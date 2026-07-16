import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import type { ChatProvider, ChatMessage, ChatEvent, ToolDefinition, ToolResult } from './types'
import { CACHE_BREAKPOINT } from './compose-prompt'
import { normalizedUsage } from '../../shared/contracts/usage'

interface ClaudeOptions {
  apiKey: string
  model?: string
  effortLevel?: 'quick' | 'standard' | 'deep'
}

export const CLAUDE_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5'
]

const DEFAULT_MODEL = CLAUDE_MODELS[1]

type AnyBlock = Record<string, unknown>

function buildContent(message: ChatMessage): string | AnyBlock[] {
  const blocks: AnyBlock[] = []
  if (message.content) blocks.push({ type: 'text', text: message.content })

  if (message.attachments?.length) {
    for (const att of message.attachments) {
      if (att.mimeType.startsWith('image/')) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: att.mimeType, data: att.data } })
      } else if (att.mimeType === 'application/pdf') {
        blocks.push({ type: 'document', source: { type: 'base64', media_type: att.mimeType, data: att.data } })
      }
    }
  }

  // Assistant turn with tool calls
  if (message.toolCalls?.length) {
    for (const call of message.toolCalls) {
      blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args })
    }
  }

  // User turn carrying tool results
  if (message.toolResults?.length) {
    for (const r of message.toolResults) {
      const content = r.error
        ? `Error: ${r.error}\n${typeof r.result === 'string' ? r.result : JSON.stringify(r.result).slice(0, 5000)}`
        : (typeof r.result === 'string' ? r.result : JSON.stringify(r.result).slice(0, 5000))
      blocks.push({
        type: 'tool_result',
        tool_use_id: r.id,
        content,
        ...(r.error ? { is_error: true } : {})
      })
    }
  }

  if (blocks.length === 0) return ''
  // If only one text block, send as a plain string (Anthropic accepts both)
  if (blocks.length === 1 && blocks[0].type === 'text') return blocks[0].text as string
  return blocks
}

/** Пометить последний блок сообщения cache_control:ephemeral (history-prefix кэш).
 *  Строку конвертируем в text-блок (к строке cache_control не прицепить). Пустое — как есть. */
export function withHistoryCacheControl(content: string | AnyBlock[]): string | AnyBlock[] {
  if (typeof content === 'string') {
    if (!content) return content
    return [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }]
  }
  if (content.length === 0) return content
  const clone = content.slice()
  clone[clone.length - 1] = { ...clone[clone.length - 1], cache_control: { type: 'ephemeral' } }
  return clone
}

// Модели Claude поддерживающие extended thinking (budget_tokens)
const THINKING_MODELS = new Set(['claude-sonnet-4-6', 'claude-opus-4-5', 'claude-opus-4'])

export function createClaudeProvider(opts: ClaudeOptions): ChatProvider {
  const model = opts.model ?? DEFAULT_MODEL
  const client = new Anthropic({ apiKey: opts.apiKey })
  const effortLevel = opts.effortLevel ?? 'standard'

  return {
    id: 'claude',
    name: 'Claude',
    models: CLAUDE_MODELS,

    async *send(messages: ChatMessage[], tools: ToolDefinition[], _results?: ToolResult[], signal?: AbortSignal): AsyncIterable<ChatEvent> {
      const systemMessages = messages.filter(m => m.role === 'system').map(m => m.content).filter(Boolean).join('\n\n')
      // Prompt caching: режем по маркеру на СТАБИЛЬНЫЙ префикс (кэшируем) и ИЗМЕНЧИВЫЙ
      // хвост (context-pack, не кэшируем — меняется каждый ход). cache_control на
      // стабильном блоке → Anthropic кэширует tools+stable-system (60-90% на input
      // со 2-го хода). Нет маркера (нет проекта/reviewer) → весь system стабилен.
      const bpIdx = systemMessages.indexOf(CACHE_BREAKPOINT)
      const stableSys = bpIdx >= 0 ? systemMessages.slice(0, bpIdx) : systemMessages
      const volatileSys = bpIdx >= 0 ? systemMessages.slice(bpIdx + CACHE_BREAKPOINT.length) : ''
      const systemParam: Anthropic.Messages.TextBlockParam[] | undefined = stableSys.trim()
        ? [
            { type: 'text', text: stableSys, cache_control: { type: 'ephemeral' } },
            ...(volatileSys.trim() ? [{ type: 'text' as const, text: volatileSys }] : []),
          ]
        : undefined
      const conversation = messages
        .filter(m => m.role !== 'system')
        .map(m => ({
          role: (m.role === 'assistant' ? 'assistant' : 'user') as 'assistant' | 'user',
          content: buildContent(m)
        }))
        .filter(m => {
          const c = m.content
          return typeof c === 'string' ? c.length > 0 : c.length > 0
        })

      // history-prefix caching: ephemeral-маркер на ПОСЛЕДНЕМ сообщении диалога →
      // Anthropic кэширует растущий префикс истории (всё до текущего хвоста). Каждый
      // ход маркер «катится» вперёд: прошлый префикс = cache hit. 3-й breakpoint
      // (system + tools + history ≤ 4 макс). Крупнейший остаток токенов после 1.5.47.
      if (conversation.length > 0) {
        const last = conversation[conversation.length - 1]
        last.content = withHistoryCacheControl(last.content)
      }

      // cache_control на ПОСЛЕДНЕМ туле → Anthropic кэширует весь блок tools (~11-14K
      // токенов, статичны между ходами). Отдельный breakpoint от system: если system
      // сменится (skill/mode), tools-кэш всё равно попадёт.
      const apiTools = tools.length > 0
        ? tools.map((t, i) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters as Anthropic.Messages.Tool.InputSchema,
            ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {})
          }))
        : undefined

      // Accumulators for in-progress tool_use blocks (Claude streams partial JSON)
      const activeToolUses: Record<number, { id: string; name: string; input: string }> = {}
      // Extended thinking blocks (content_block.type === 'thinking')
      const activeThinkingBlocks: Record<number, string> = {}

      // Параметры зависят от effortLevel:
      // quick    → max_tokens 2048, без thinking
      // standard → max_tokens 8192 (ранее было 4096), без thinking
      // deep     → max_tokens 16000, extended thinking если модель поддерживает
      const maxTokens = effortLevel === 'quick' ? 2048 : effortLevel === 'deep' ? 16000 : 8192
      const useThinking = effortLevel === 'deep' && THINKING_MODELS.has(model)
      // Extended thinking несовместимо с tool use по Anthropic API — только plain
      const thinkingParam = useThinking && !apiTools
        ? { thinking: { type: 'enabled' as const, budget_tokens: 10000 } }
        : {}

      try {
        // pre-existing baseline (lint-baseline): SDK stream() «thenable»-подобен, но не Promise. E
        // обязан менять claude.ts → error всплыл; реальный фикс — lint-cleanup (ledger 2.0.10-G). Деферрал.
        // eslint-disable-next-line @typescript-eslint/await-thenable
        const stream = await client.messages.stream({
          model,
          max_tokens: maxTokens,
          system: systemParam,
          messages: conversation as Anthropic.Messages.MessageParam[],
          ...(apiTools ? { tools: apiTools } : {}),
          ...thinkingParam
        }, signal ? { signal } : undefined)

        let inputTokens = 0
        let outputTokens = 0
        let cachedInputTokens = 0
        let cacheCreationInputTokens = 0
        for await (const event of stream) {
          if (event.type === 'message_start' && event.message?.usage) {
            inputTokens = event.message.usage.input_tokens ?? 0
            cachedInputTokens = (event.message.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0
            cacheCreationInputTokens = (event.message.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0
          } else if (event.type === 'message_delta' && event.usage) {
            outputTokens = event.usage.output_tokens ?? 0
          } else if (event.type === 'content_block_start') {
            if (event.content_block.type === 'tool_use') {
              activeToolUses[event.index] = {
                id: event.content_block.id ?? randomUUID(),
                name: event.content_block.name,
                input: ''
              }
            } else if ((event.content_block as { type: string }).type === 'thinking') {
              activeThinkingBlocks[event.index] = ''
            }
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              yield { type: 'text', text: event.delta.text }
            } else if (event.delta.type === 'input_json_delta' && activeToolUses[event.index]) {
              activeToolUses[event.index].input += event.delta.partial_json
            } else if ((event.delta as { type: string; thinking?: string }).type === 'thinking_delta' && activeThinkingBlocks[event.index] !== undefined) {
              activeThinkingBlocks[event.index] += (event.delta as { type: string; thinking?: string }).thinking ?? ''
            }
          } else if (event.type === 'content_block_stop') {
            // Emit accumulated thinking block
            if (activeThinkingBlocks[event.index] !== undefined) {
              if (activeThinkingBlocks[event.index]) {
                yield { type: 'thought', text: activeThinkingBlocks[event.index] }
              }
              delete activeThinkingBlocks[event.index]
            }
          }
          if (event.type === 'content_block_stop' && activeToolUses[event.index]) {
            const tu = activeToolUses[event.index]
            let args: Record<string, unknown> = {}
            try { args = tu.input ? JSON.parse(tu.input) : {} } catch { args = {} }
            yield { type: 'tool-call', call: { id: tu.id, name: tu.name, args } }
            delete activeToolUses[event.index]
          }
        }
        if (inputTokens || outputTokens) {
          // 2.0.8-E: Claude = EXCLUSIVE (input_tokens БЕЗ кэша; cache_read/creation отдельно) →
          // billable НЕ вычитает cached (фикс дефекта B). cache write не теряется (фикс A).
          yield { type: 'usage', usage: normalizedUsage({ inputTokens, outputTokens, cacheReadTokens: cachedInputTokens, cacheWriteTokens: cacheCreationInputTokens, inputAccounting: 'exclusive', model }) }
        }
        yield { type: 'done' }
      } catch (err) {
        yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
      }
    }
  }
}
