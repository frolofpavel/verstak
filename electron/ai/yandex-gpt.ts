/**
 * YandexGPT provider — Yandex Cloud Foundation Models.
 *
 * Особенности vs OpenAI/Anthropic:
 *  1. modelUri составляется как `gpt://${folderId}/${model}` — folderId
 *     обязателен и идёт отдельно от API ключа.
 *  2. Streaming формат — NDJSON (newline-delimited JSON), не SSE. Каждая
 *     строка — отдельный JSON-объект с ПОЛНЫМ накопленным текстом ответа.
 *     Дельту вычисляем сами (slice от prevText).
 *  3. Function calling поддерживается через поле `tools` в запросе.
 *     Ответ — toolCallList в assistantMessage. Tool result — role: "function"
 *     с toolResultList.
 *  4. maxTokens передаётся как строка ('8000'), не number — особенность API.
 *
 * Документация: https://yandex.cloud/ru/docs/foundation-models/text-generation/api-ref/TextGeneration/completion
 */

import { randomUUID } from 'crypto'
import type { ChatProvider, ChatMessage, ChatEvent, ToolDefinition, ToolResult } from './types'
import { toYandexTools } from './tool-format'

const COMPLETION_STREAM_URL =
  'https://llm.api.cloud.yandex.net/foundationModels/v1/completionStream'

export const YANDEX_GPT_MODELS = [
  'yandexgpt/latest',
  'yandexgpt-lite/latest',
  'yandexgpt-32k/latest'
]

const DEFAULT_MODEL = 'yandexgpt/latest'

export interface YandexGptOptions {
  apiKey: string
  folderId: string
  model?: string
}

// Внутренний тип сообщения для Yandex API — поддерживает все роли включая function.
type YandexMessage =
  | { role: 'system'; text: string }
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCallList?: { toolCalls: Array<{ functionCall: { name: string; arguments: Record<string, unknown> } }> } }
  | { role: 'function'; toolResultList: { toolResults: Array<{ functionResult: { name: string; content: string } }> } }

interface YandexChunk {
  result?: {
    alternatives?: Array<{
      message?: {
        text?: string
        role?: string
        toolCallList?: {
          toolCalls?: Array<{
            functionCall?: {
              name?: string
              arguments?: Record<string, unknown>
            }
          }>
        }
      }
      status?: string
    }>
    usage?: {
      inputTextTokens?: string
      completionTokens?: string
      totalTokens?: string
    }
  }
}

/**
 * Преобразует наши ChatMessage в формат Yandex: system-сообщения
 * объединяются в один, остальные идут как user/assistant/function.
 * Tool-результаты конвертируются в role: "function" с toolResultList.
 */
export function buildYandexMessages(messages: ChatMessage[]): YandexMessage[] {
  const systemParts: string[] = []
  const rest: YandexMessage[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content)
    } else if (m.role === 'assistant') {
      if (m.toolCalls?.length) {
        // Ассистент вызвал тулзы — передаём toolCallList + текст
        rest.push({
          role: 'assistant',
          text: m.content ?? '',
          toolCallList: {
            toolCalls: m.toolCalls.map(tc => ({
              functionCall: {
                name: tc.name,
                arguments: tc.args
              }
            }))
          }
        })
      } else {
        rest.push({ role: 'assistant', text: m.content ?? '' })
      }
    } else if (m.role === 'user') {
      if (m.toolResults?.length) {
        // User message carrying tool results → role: "function"
        rest.push({
          role: 'function',
          toolResultList: {
            toolResults: m.toolResults.map(r => ({
              functionResult: {
                name: r.name,
                content: r.error
                  ? `Error: ${r.error}\n${JSON.stringify(r.result)}`
                  : (typeof r.result === 'string' ? r.result : JSON.stringify(r.result))
              }
            }))
          }
        })
        // Если есть текстовый контент (verifyHint), добавляем следом как user
        if (m.content) {
          rest.push({ role: 'user', text: m.content })
        }
      } else {
        rest.push({ role: 'user', text: m.content ?? '' })
      }
    }
  }

  const out: YandexMessage[] = []
  if (systemParts.length > 0) {
    out.push({ role: 'system', text: systemParts.join('\n\n') })
  }
  out.push(...rest)
  return out
}

/**
 * Строит modelUri из folder и model. Экспортирован для тестов.
 */
export function buildModelUri(folderId: string, model: string): string {
  return `gpt://${folderId}/${model}`
}

export function createYandexGptProvider(opts: YandexGptOptions): ChatProvider {
  if (!opts.folderId || !opts.folderId.trim()) {
    throw new Error('YandexGPT: Folder ID не задан (Settings → Провайдеры → YandexGPT)')
  }
  if (!opts.apiKey || !opts.apiKey.trim()) {
    throw new Error('YandexGPT: API ключ не задан')
  }

  const model = opts.model && opts.model.trim() ? opts.model : DEFAULT_MODEL

  return {
    id: 'yandex-gpt',
    name: 'YandexGPT',
    models: YANDEX_GPT_MODELS,

    async *send(
      messages: ChatMessage[],
      tools: ToolDefinition[],
      _results?: ToolResult[],
      signal?: AbortSignal
    ): AsyncIterable<ChatEvent> {
      const yandexMessages = buildYandexMessages(messages)
      const body: Record<string, unknown> = {
        modelUri: buildModelUri(opts.folderId, model),
        completionOptions: {
          stream: true,
          temperature: 0.6,
          maxTokens: '8000' // ВАЖНО: строка, не number — особенность Yandex API
        },
        messages: yandexMessages
      }

      // Добавляем tools если они есть
      if (tools.length > 0) {
        body.tools = toYandexTools(tools)
      }

      let usageInput = 0
      let usageOutput = 0

      try {
        const response = await fetch(COMPLETION_STREAM_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Api-Key ${opts.apiKey}`,
            'x-folder-id': opts.folderId,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body),
          signal // Аудит B3: Stop рвёт стрим YandexGPT
        })

        if (!response.ok) {
          const errText = await response.text().catch(() => '')
          yield {
            type: 'error',
            message: `YandexGPT HTTP ${response.status}: ${errText.slice(0, 400) || response.statusText}`
          }
          return
        }
        if (!response.body) {
          yield { type: 'error', message: 'YandexGPT: пустой response body (streaming недоступен)' }
          return
        }

        // NDJSON парсер: каждая строка — отдельный JSON.
        const reader = response.body.getReader()
        const decoder = new TextDecoder('utf-8')
        let buf = ''
        let prevText = '' // ПОЛНЫЙ накопленный текст из предыдущего chunk'а

        // Накапливаем tool calls из NDJSON — последний chunk содержит финальное
        // состояние. Ключ дедупа: name + args (см. M15 ниже).
        const toolCallsSeen = new Set<string>()

        const processChunk = (chunk: YandexChunk): { text?: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> } => {
          const alt = chunk.result?.alternatives?.[0]
          const msg = alt?.message
          const fullText = msg?.text ?? ''

          // Yandex возвращает накопленный текст; вычитаем prevText чтобы получить дельту
          const delta = fullText.length > prevText.length ? fullText.slice(prevText.length) : ''
          if (delta) prevText = fullText

          // Usage всегда в последних chunk'ах
          if (chunk.result?.usage) {
            const u = chunk.result.usage
            usageInput = parseInt(u.inputTextTokens ?? '0', 10) || 0
            usageOutput = parseInt(u.completionTokens ?? '0', 10) || 0
          }

          // Tool calls в assistantMessage
          const rawCalls = msg?.toolCallList?.toolCalls
          let toolCalls: Array<{ name: string; args: Record<string, unknown> }> | undefined
          if (rawCalls?.length) {
            toolCalls = rawCalls
              .filter(tc => tc.functionCall?.name)
              .map(tc => ({
                name: tc.functionCall!.name!,
                args: tc.functionCall?.arguments ?? {}
              }))
          }

          return { text: delta || undefined, toolCalls }
        }

        const pendingToolCalls: Array<{ name: string; args: Record<string, unknown> }> = []

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            const t = line.trim()
            if (!t) continue
            try {
              const { text, toolCalls } = processChunk(JSON.parse(t) as YandexChunk)
              if (text) yield { type: 'text', text }
              // Обновляем pending tool calls при каждом chunk'е
              // (Yandex отдаёт финальный список в конце, перезаписываем)
              if (toolCalls?.length) {
                pendingToolCalls.length = 0
                pendingToolCalls.push(...toolCalls)
              }
            } catch { /* битый chunk — пропускаем */ }
          }
        }
        // Хвост буфера
        if (buf.trim()) {
          try {
            const { text, toolCalls } = processChunk(JSON.parse(buf) as YandexChunk)
            if (text) yield { type: 'text', text }
            if (toolCalls?.length) {
              pendingToolCalls.length = 0
              pendingToolCalls.push(...toolCalls)
            }
          } catch { /* skip */ }
        }

        // Эмитим tool calls после завершения стрима.
        // Аудит M15: дедуп по name терял повторные вызовы одного тула (две правки
        // через write_file, два чтения) — ключ по name+args сохраняет их, но всё
        // ещё гасит точные дубли из накопленного NDJSON-стрима.
        for (const tc of pendingToolCalls) {
          const dedupKey = `${tc.name} ${JSON.stringify(tc.args)}`
          if (!toolCallsSeen.has(dedupKey)) {
            toolCallsSeen.add(dedupKey)
            yield {
              type: 'tool-call',
              call: {
                id: randomUUID(),
                name: tc.name,
                args: tc.args
              }
            }
          }
        }

        if (usageInput > 0 || usageOutput > 0) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: usageInput,
              outputTokens: usageOutput,
              model
            }
          }
        }
      } catch (err) {
        yield {
          type: 'error',
          message: `YandexGPT: ${err instanceof Error ? err.message : String(err)}`
        }
      } finally {
        yield { type: 'done' }
      }
    }
  }
}
