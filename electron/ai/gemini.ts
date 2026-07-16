import { GoogleGenAI } from '@google/genai'
import { randomUUID } from 'crypto'
import type { ChatProvider, ChatMessage, ChatEvent, ToolDefinition, ToolResult } from './types'
import { normalizedUsage } from '../../shared/contracts/usage'

interface GeminiOptions {
  apiKey: string
  model?: string
  effortLevel?: 'quick' | 'standard' | 'deep'
  sdk?: { models: { generateContentStream: (opts: unknown) => Promise<AsyncIterable<unknown>> } }
}

const MODELS = ['gemini-3.5-flash', 'gemini-3-pro', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash']

function partsForMessage(m: ChatMessage): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = []
  if (m.content) parts.push({ text: m.content })
  if (m.attachments?.length) {
    for (const att of m.attachments) {
      parts.push({ inlineData: { mimeType: att.mimeType, data: att.data } })
    }
  }
  // Assistant message that includes tool calls — pack each as functionCall part.
  // Gemini 3+ requires the thoughtSignature we captured during streaming to be
  // round-tripped on the same part, otherwise the API rejects with
  // "Function call is missing a thought_signature in functionCall parts".
  if (m.toolCalls?.length) {
    for (const call of m.toolCalls) {
      const part: Record<string, unknown> = { functionCall: { name: call.name, args: call.args } }
      if (call.thoughtSignature) part.thoughtSignature = call.thoughtSignature
      parts.push(part)
    }
  }
  // User message carrying tool results — pack each as functionResponse part
  if (m.toolResults?.length) {
    for (const r of m.toolResults) {
      parts.push({
        functionResponse: {
          name: r.name,
          response: r.error
            ? { error: r.error, result: r.result }
            : { result: r.result }
        }
      })
    }
  }
  if (parts.length === 0) parts.push({ text: '' })
  return parts
}

export function createGeminiProvider(opts: GeminiOptions): ChatProvider {
  const model = opts.model ?? 'gemini-3.5-flash'
  const client = opts.sdk ?? new GoogleGenAI({ apiKey: opts.apiKey })
  const effortLevel = opts.effortLevel ?? 'standard'

  return {
    id: 'gemini',
    name: 'Gemini',
    models: MODELS,

    async *send(messages: ChatMessage[], tools: ToolDefinition[], _toolResults?: ToolResult[], signal?: AbortSignal): AsyncIterable<ChatEvent> {
      // Extract system messages — Gemini wants them in `config.systemInstruction`,
      // not as a user turn. Mixing system content into user turns wastes the
      // prompt cache and confuses multi-turn role alternation.
      const systemTexts: string[] = []
      const nonSystem: ChatMessage[] = []
      for (const m of messages) {
        if (m.role === 'system') {
          if (m.content) systemTexts.push(m.content)
        } else {
          nonSystem.push(m)
        }
      }
      const contents = nonSystem.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: partsForMessage(m)
      }))

      const config: Record<string, unknown> = {}
      // Thinking budget: quick=0 (disable), standard=default, deep=max
      if (effortLevel === 'quick') {
        config.thinkingConfig = { thinkingBudget: 0 }
      } else if (effortLevel === 'deep') {
        config.thinkingConfig = { thinkingBudget: 24576 }
      }
      if (tools.length > 0) {
        config.tools = [{ functionDeclarations: tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters as Record<string, unknown>
        })) }]
      }
      if (systemTexts.length > 0) {
        config.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] }
      }
      // Аудит B3: abortSignal в config рвёт HTTP-стрим Gemini при Stop.
      if (signal) config.abortSignal = signal
      const hasConfig = Object.keys(config).length > 0

      try {
        const stream = await client.models.generateContentStream(
          hasConfig ? { model, contents, config } : { model, contents }
        )
        let lastUsage: { prompt?: number; output?: number; cached?: number } = {}
        let totalText = ''  // accumulate all text characters that we actually emitted
        let toolEmitted = false
        let lastFinishReason: string | undefined
        let lastBlockReason: string | undefined
        let chunkCount = 0
        // Track raw chunk shapes so we can show a diagnostic if everything stays empty
        const sampleChunks: string[] = []
        for await (const chunk of stream) {
          chunkCount++
          if (sampleChunks.length < 3) {
            try {
              const dump = JSON.stringify(chunk, (_k, v) => typeof v === 'function' ? '[fn]' : v)
              sampleChunks.push(dump.slice(0, 400))
              console.error(`[gemini chunk ${chunkCount - 1}]`, dump.slice(0, 1500))
            } catch { /* ignore */ }
          }
          const c = chunk as {
            text?: string
            functionCalls?: Array<{ name: string; args: Record<string, unknown>; thoughtSignature?: string }>
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number }
            candidates?: Array<{
              finishReason?: string
              finishMessage?: string
              content?: { parts?: Array<{
                text?: string
                /** Gemini 3 marks chain-of-thought parts with thought:true. */
                thought?: boolean
                functionCall?: { name: string; args: Record<string, unknown> }
                thoughtSignature?: string
              }> }
            }>
            promptFeedback?: { blockReason?: string; blockReasonMessage?: string }
          }

          // Single-source extraction: walk candidates[].content.parts.
          //
          // Previously we ALSO read c.text (SDK getter) and c.functionCalls
          // (another SDK getter). Both internally read from candidates.parts.
          // Using both = silent text loss OR doubled tool calls — both happened.
          //
          // Now: parts is the ONLY primary path. The top-level getters are
          // touched only as fallback when candidates[].content.parts is empty
          // (defensive — older SDK builds may not populate parts).
          let foundAnythingInParts = false
          if (c.candidates?.[0]?.content?.parts) {
            for (const part of c.candidates[0].content.parts) {
              if (part.text) {
                if (part.thought) {
                  yield { type: 'thought', text: part.text }
                } else {
                  yield { type: 'text', text: part.text }
                  totalText += part.text
                }
                foundAnythingInParts = true
              }
              if (part.functionCall) {
                yield {
                  type: 'tool-call',
                  call: {
                    id: randomUUID(),
                    name: part.functionCall.name,
                    args: part.functionCall.args,
                    thoughtSignature: part.thoughtSignature
                  }
                }
                toolEmitted = true
                foundAnythingInParts = true
              }
            }
          }

          // Fallback path для SDK сборок где parts пуст — используем top-level
          // getters. Активируется ТОЛЬКО когда из parts ничего не извлекли.
          if (!foundAnythingInParts) {
            let topText: string | undefined
            try { topText = c.text } catch { topText = undefined }
            if (topText) {
              yield { type: 'text', text: topText }
              totalText += topText
            }
            if (c.functionCalls) {
              for (const fc of c.functionCalls) {
                yield {
                  type: 'tool-call',
                  call: {
                    id: randomUUID(),
                    name: fc.name,
                    args: fc.args,
                    thoughtSignature: fc.thoughtSignature
                  }
                }
                toolEmitted = true
              }
            }
          }

          if (c.usageMetadata) {
            lastUsage = {
              prompt: c.usageMetadata.promptTokenCount,
              output: c.usageMetadata.candidatesTokenCount,
              cached: c.usageMetadata.cachedContentTokenCount
            }
          }
          if (c.candidates?.[0]?.finishReason) lastFinishReason = c.candidates[0].finishReason
          if (c.promptFeedback?.blockReason) lastBlockReason = c.promptFeedback.blockReason
        }

        // MALFORMED_FUNCTION_CALL fallback. Gemini sometimes decides to use a
        // tool, builds the function-call args incorrectly (esp. with Cyrillic),
        // and returns 0 text + MALFORMED_FUNCTION_CALL. The user sees an empty
        // bubble. Recover by silently retrying the SAME conversation WITHOUT
        // tools — the model falls back to a plain chat reply.
        if (lastFinishReason === 'MALFORMED_FUNCTION_CALL' && !totalText.trim() && !toolEmitted && tools.length > 0) {
          console.error('[gemini] MALFORMED_FUNCTION_CALL → retrying without tools')
          const noToolsConfig: Record<string, unknown> = {}
          if (systemTexts.length > 0) {
            noToolsConfig.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] }
          }
          if (signal) noToolsConfig.abortSignal = signal
          try {
            const retryStream = await client.models.generateContentStream(
              Object.keys(noToolsConfig).length > 0
                ? { model, contents, config: noToolsConfig }
                : { model, contents }
            )
            for await (const chunk of retryStream) {
              const c = chunk as { text?: string; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number }; candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
              let t: string | undefined
              try { t = c.text } catch { t = undefined }
              if (t) { yield { type: 'text', text: t }; totalText += t }
              else if (c.candidates?.[0]?.content?.parts) {
                for (const p of c.candidates[0].content.parts) {
                  if (p.text) { yield { type: 'text', text: p.text }; totalText += p.text }
                }
              }
              if (c.usageMetadata) {
                lastUsage = {
                  prompt: (lastUsage.prompt ?? 0) + (c.usageMetadata.promptTokenCount ?? 0),
                  output: (lastUsage.output ?? 0) + (c.usageMetadata.candidatesTokenCount ?? 0),
                  cached: (lastUsage.cached ?? 0) + (c.usageMetadata.cachedContentTokenCount ?? 0)
                }
              }
            }
          } catch (err) {
            console.error('[gemini] retry failed:', err instanceof Error ? err.message : String(err))
          }
        }

        // If after all attempts the response is still empty, surface why.
        if (!totalText.trim() && !toolEmitted) {
          let reason = ''
          if (lastBlockReason) {
            reason = `⚠ Запрос заблокирован Gemini: ${lastBlockReason}. Перефразируй и попробуй ещё раз.`
          } else if (lastFinishReason === 'SAFETY') {
            reason = '⚠ Ответ заблокирован safety-фильтром Gemini. Попробуй перефразировать запрос.'
          } else if (lastFinishReason === 'RECITATION') {
            reason = '⚠ Ответ заблокирован recitation-фильтром (Gemini считает что вывод копирует обучающие данные).'
          } else if (lastFinishReason === 'MAX_TOKENS') {
            reason = '⚠ Лимит токенов исчерпан до того как модель что-либо написала.'
          } else if (lastFinishReason === 'MALFORMED_FUNCTION_CALL') {
            reason = '⚠ Gemini пыталась вызвать инструмент с битыми аргументами и без-tool retry тоже не помог. Перефразируй запрос конкретнее.'
          } else if (lastFinishReason && lastFinishReason !== 'STOP') {
            reason = `⚠ Gemini завершил ответ без текста, finishReason=${lastFinishReason}.`
          } else {
            const sample = sampleChunks[0] ?? '(нет данных)'
            reason = `⚠ Gemini вернул пустой ответ (${chunkCount} chunks, output_tokens=${lastUsage.output ?? '?'}). Первый chunk: ${sample.slice(0, 200)}`
          }
          yield { type: 'text', text: reason }
        }
        if (lastUsage.prompt !== undefined || lastUsage.output !== undefined) {
          yield {
            type: 'usage',
            // 2.0.8-E: Gemini = INCLUSIVE (promptTokenCount ВКЛЮЧАЕТ cachedContentTokenCount) → billable вычитает cached.
            usage: normalizedUsage({ inputTokens: lastUsage.prompt, outputTokens: lastUsage.output, cacheReadTokens: lastUsage.cached, inputAccounting: 'inclusive', model })
          }
        }
        yield { type: 'done' }
      } catch (err) {
        yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
      }
    }
  }
}
