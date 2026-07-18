import OpenAI from 'openai'
import { randomUUID } from 'crypto'
import type { ChatProvider, ChatMessage, ChatEvent, ToolDefinition, ToolResult } from './types'
import { normalizedUsage } from '../../shared/contracts/usage'
import { formatVerstakMeta, mapGatewayError } from './gateway-meta'
import { parseTextToolCalls } from './tool-call-repair'

export interface OpenAiCompatOptions {
  id: string
  name: string
  models: string[]
  defaultModel: string
  apiKey: string
  baseUrl?: string
  /** Запасной хост: при сетевом сбое соединения с baseUrl повторяем запрос сюда
   *  тем же ключом (страховка от падения РФ-релея). */
  fallbackBaseUrl?: string
  model?: string
  effortLevel?: 'quick' | 'standard' | 'deep'
  /** Дефект 3: умеет ли провайдер vision (картинки). undefined/true — умеет (как
   *  было). false — картинки НЕ отправляем массивом image_url (иначе 400 у GLM
   *  Coding и т.п.), деградируем честно: текст доходит, юзеру шлём info. */
  supportsImages?: boolean
}

interface OpenAiContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

/** true — в user-сообщении есть вложение-картинка. */
function hasImageAttachment(message: ChatMessage): boolean {
  return !!message.attachments?.some(a => a.mimeType.startsWith('image/'))
}

function buildUserContent(message: ChatMessage, supportsImages: boolean): string | OpenAiContentPart[] {
  if (!message.attachments?.length) return message.content
  // Дефект 3: провайдер без vision (GLM Coding и т.п.) — картинки НЕ вкладываем
  // (сервер вернул бы 400 и убил прогон, потеряв текст). Отдаём чистый текст;
  // уведомление юзеру шлётся один раз из send().
  if (!supportsImages) return message.content
  const parts: OpenAiContentPart[] = []
  if (message.content) parts.push({ type: 'text', text: message.content })
  for (const att of message.attachments) {
    if (att.mimeType.startsWith('image/')) {
      parts.push({ type: 'image_url', image_url: { url: `data:${att.mimeType};base64,${att.data}` } })
    }
  }
  return parts.length > 0 ? parts : ''
}

/**
 * Convert our ChatMessage list to OpenAI Chat Completions message list.
 * - Assistant messages with toolCalls become assistant role + tool_calls field.
 * - User messages with toolResults become a *sequence* of `role: 'tool'` messages.
 *   The original user content (if any) becomes a regular user message before them.
 */
function buildOpenAiMessages(messages: ChatMessage[], supportsImages: boolean): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) out.push({ role: 'system', content: m.content })
      continue
    }
    if (m.role === 'assistant') {
      const entry: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: m.content || ''
      }
      if (m.toolCalls?.length) {
        entry.tool_calls = m.toolCalls.map(c => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.args) }
        }))
      }
      out.push(entry)
      continue
    }
    // role === 'user'
    if (m.toolResults?.length) {
      // Tool results travel as their own role:'tool' entries, one per result.
      // Any actual user text in the same logical turn is emitted FIRST as user.
      if (m.content) out.push({ role: 'user', content: buildUserContent(m, supportsImages) as never })
      for (const r of m.toolResults) {
        const content = r.error
          ? `Error: ${r.error}\n${typeof r.result === 'string' ? r.result : JSON.stringify(r.result).slice(0, 5000)}`
          : (typeof r.result === 'string' ? r.result : JSON.stringify(r.result).slice(0, 5000))
        out.push({ role: 'tool', tool_call_id: r.id, content })
      }
    } else {
      out.push({ role: 'user', content: buildUserContent(m, supportsImages) as never })
    }
  }
  return out
}

export function createOpenAiCompatProvider(opts: OpenAiCompatOptions): ChatProvider {
  const model = opts.model ?? opts.defaultModel
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl })
  // Фолбэк-клиент на запасной хост — строим только если он задан и отличается от
  // основного. Используется лишь при сбое соединения с основным (см. send).
  const fallbackClient = opts.fallbackBaseUrl && opts.fallbackBaseUrl !== opts.baseUrl
    ? new OpenAI({ apiKey: opts.apiKey, baseURL: opts.fallbackBaseUrl })
    : null
  const effortLevel = opts.effortLevel ?? 'standard'

  return {
    id: opts.id,
    name: opts.name,
    models: opts.models,

    async *send(messages: ChatMessage[], tools: ToolDefinition[], _results?: ToolResult[], signal?: AbortSignal): AsyncIterable<ChatEvent> {
      // Дефект 3: провайдер без vision — картинки не уходят на сервер (см. buildUserContent).
      // undefined трактуем как «умеет» (обратная совместимость всех прежних провайдеров).
      const imagesSupported = opts.supportsImages !== false
      const droppedImages = !imagesSupported && messages.some(m => m.role === 'user' && hasImageAttachment(m))
      if (droppedImages) {
        yield { type: 'info', text: `${opts.name} не принимает изображения — отправлен только текст, вложение пропущено` }
      }
      const apiMessages = buildOpenAiMessages(messages, imagesSupported)
      const apiTools: OpenAI.Chat.ChatCompletionTool[] | undefined = tools.length > 0
        ? tools.map(t => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters as Record<string, unknown>
            }
          }))
        : undefined

      // Accumulators for streaming tool calls (OpenAI sends incremental delta.tool_calls)
      const inProgress: Record<number, { id: string; name: string; args: string }> = {}

      const maxTokens = effortLevel === 'quick' ? 2048 : effortLevel === 'deep' ? 16384 : 4096
      // Аудит M14: reasoning-модели OpenAI (o1/o1-mini/o3/o4...) отвергают max_tokens
      // с 400 'Use max_completion_tokens instead' — а это 4xx, не triggerит fallback.
      // Шлём правильный параметр по имени модели.
      const isReasoningModel = /^o\d/i.test(model)
      const tokenParam = isReasoningModel
        ? { max_completion_tokens: maxTokens }
        : { max_tokens: maxTokens }

      try {
        const createParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
          model,
          messages: apiMessages,
          stream: true,
          ...tokenParam,
          stream_options: { include_usage: true },
          ...(apiTools ? { tools: apiTools } : {})
        }
        const reqOpts = signal ? { signal } : undefined
        // Авто-фолбэк: если основной хост (релей) недостижим на этапе соединения —
        // повторяем на запасном (прямой Амстердам) тем же ключом. Триггерим ТОЛЬКО
        // на сетевой сбой «не достучались» (нет HTTP-статуса) и не на отмену юзером;
        // HTTP-ошибки апстрима (4xx/5xx) фолбэком не лечатся — апстрим жив.
        let usedFallback = false
        const openStream = async () => {
          try {
            return await client.chat.completions.create(createParams, reqOpts)
          } catch (primaryErr) {
            const pe = primaryErr as { status?: number }
            if (fallbackClient && !signal?.aborted && typeof pe.status !== 'number') {
              usedFallback = true
              return await fallbackClient.chat.completions.create(createParams, reqOpts)
            }
            throw primaryErr
          }
        }
        const stream = await openStream()
        if (usedFallback) yield { type: 'info', text: 'Релей РФ недоступен — прямой канал' }

        let usageSent = false
        let verstakSent = false
        let fullText = ''
        let emittedToolCall = false
        for await (const chunk of stream) {
          // Verstak Gateway: доп-метадата (cost_rub/balance_rub/cache) в чанке —
          // показываем компактной плашкой. Хармлесс для остальных (поля нет).
          if (!verstakSent) {
            const vmeta = (chunk as { verstak?: Parameters<typeof formatVerstakMeta>[0] }).verstak
            const line = formatVerstakMeta(vmeta)
            if (line) { verstakSent = true; yield { type: 'info', text: line } }
          }
          // Final chunk may carry only usage (no choices)
          if ((chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } }).usage && !usageSent) {
            const u = (chunk as { usage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } }).usage
            usageSent = true
            yield {
              type: 'usage',
              // 2.0.8-E: OpenAI Chat Completions = INCLUSIVE (prompt_tokens ВКЛЮЧАЕТ
              // prompt_tokens_details.cached_tokens) → billable вычитает cached. Все OpenAI-совместимые.
              usage: normalizedUsage({
                inputTokens: u.prompt_tokens,
                outputTokens: u.completion_tokens,
                cacheReadTokens: u.prompt_tokens_details?.cached_tokens,
                inputAccounting: 'inclusive',
                model
              })
            }
          }
          const delta = chunk.choices?.[0]?.delta
          if (!delta) continue
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            fullText += delta.content
            yield { type: 'text', text: delta.content }
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              if (!inProgress[idx]) {
                inProgress[idx] = { id: tc.id ?? randomUUID(), name: tc.function?.name ?? '', args: '' }
              }
              if (tc.id) inProgress[idx].id = tc.id
              if (tc.function?.name) inProgress[idx].name = tc.function.name
              if (tc.function?.arguments) inProgress[idx].args += tc.function.arguments
            }
          }
          const finish = chunk.choices?.[0]?.finish_reason
          if (finish === 'tool_calls') {
            for (const k of Object.keys(inProgress)) {
              const t = inProgress[Number(k)]
              let args: Record<string, unknown> = {}
              // Этап 2: битый JSON в arguments — раньше молча {} и тулза исполнялась
              // с пустыми аргументами. Теперь помечаем argsError, чтобы цикл сделал
              // corrective retry. Только при НЕПУСТОМ payload (пустой = легитимный no-arg).
              let argsErr: 'malformed_json' | undefined
              try { args = t.args ? JSON.parse(t.args) : {} } catch { args = {}; if (t.args.trim()) argsErr = 'malformed_json' }
              yield { type: 'tool-call', call: { id: t.id, name: t.name, args, ...(argsErr ? { argsError: argsErr } : {}) } }
              emittedToolCall = true
            }
            // Clear so next turn starts fresh if reused
            for (const k of Object.keys(inProgress)) delete inProgress[Number(k)]
          }
        }
        // Флаш недослитых tool-calls: некоторые OpenAI-совместимые серверы
        // (Ollama, часть DeepSeek/Qwen-сборок) закрывают стрим с finish_reason
        // 'stop' вместо 'tool_calls' — без этого накопленные вызовы молча
        // терялись и агент видел пустой turn. Штатный путь выше очищает
        // inProgress, так что здесь остаются ТОЛЬКО недослитые (без дубля).
        for (const k of Object.keys(inProgress)) {
          const t = inProgress[Number(k)]
          if (!t.name) continue
          let args: Record<string, unknown> = {}
          let argsErr: 'malformed_json' | undefined
          try { args = t.args ? JSON.parse(t.args) : {} } catch { args = {}; if (t.args.trim()) argsErr = 'malformed_json' }
          yield { type: 'tool-call', call: { id: t.id, name: t.name, args, ...(argsErr ? { argsError: argsErr } : {}) } }
          emittedToolCall = true
        }
        // T1.5 repair: модель отдала вызов ТЕКСТОМ (не structured tool_calls) —
        // восстанавливаем, чтобы тулза исполнилась, а не упала в чат прозой.
        // Срабатывает только для слабых/RU-моделей; сильные шлют structured.
        // ВАЛИДАЦИЯ ИМЕНИ (ревью 24.06): эмитим только вызовы, чьё имя есть в наборе
        // tools. Иначе обычная проза с JSON (пример конфига/тела запроса с ключом
        // name/tool) → фантомный вызов → lookupHandler-fallback на readHandler →
        // потраченный ход. Неизвестное имя оставляем текстом (он уже отстримлен).
        if (!emittedToolCall && fullText.trim() && tools.length > 0) {
          const known = new Set(tools.map(t => t.name))
          for (const rc of parseTextToolCalls(fullText)) {
            if (known.has(rc.name)) {
              yield { type: 'tool-call', call: { id: randomUUID(), name: rc.name, args: rc.args } }
            }
          }
        }
        yield { type: 'done' }
      } catch (err) {
        // Verstak Gateway — человеко-читаемые ошибки по статусу/коду (нет баланса,
        // лимит, ключ). Для остальных провайдеров — обычное сообщение.
        const e = err as { status?: number; code?: string; error?: { code?: string } }
        const friendly = opts.id === 'verstak-gateway'
          ? mapGatewayError(e.status, e.code ?? e.error?.code)
          : null
        yield { type: 'error', message: friendly ?? (err instanceof Error ? err.message : String(err)) }
      }
    }
  }
}
