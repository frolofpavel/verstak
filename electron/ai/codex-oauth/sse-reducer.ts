/**
 * Редьюсер Responses-стрима Codex (ChatGPT backend).
 *
 * На вход приходят УЖЕ распарсенные SSE-события — объекты `{ type, ... }`
 * (парсинг `data: {...}` строк живёт снаружи). Задача редьюсера — собрать из
 * потока финальный результат: текст ответа, tool-call'ы, usage и признак
 * завершения/ошибки. Чистая логика: без сети и fs.
 *
 * КРИТИЧНО (регрессия Hermes): нельзя полагаться на
 * `response.completed.response.output` — приватный backend возвращает там
 * `output: null`. Поэтому output items аккумулируются ИЗ `response.output_item.done`
 * по мере поступления, а `response.completed` используется только для usage и
 * сигнала done. Мы намеренно НЕ читаем `event.response.output`.
 */

/** Сырое usage из `response.completed.response.usage`. */
interface RawUsage {
  input_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens?: number
  output_tokens_details?: { reasoning_tokens?: number }
  total_tokens?: number
  [k: string]: unknown
}

/** Финальный output item из `response.output_item.done`. */
export interface CodexOutputItem {
  /** 'message' | 'function_call' | 'reasoning' */
  type?: string
  id?: string
  call_id?: string
  name?: string
  /** Для function_call — аргументы как JSON-СТРОКА. */
  arguments?: string
  status?: string
  role?: string
  /** Для message — массив частей {type, text} либо готовая строка. */
  content?: Array<{ type?: string; text?: string; [k: string]: unknown }> | string
  text?: string
  [k: string]: unknown
}

/** Одно распарсенное SSE-событие Responses-стрима. */
export interface CodexSseEvent {
  type: string
  /** response.output_text.delta */
  delta?: string
  /** response.function_call_arguments.done — полная JSON-строка аргументов. */
  arguments?: string
  /** response.output_item.done */
  item?: CodexOutputItem
  /** Ключи корреляции function-call дельт. */
  item_id?: string
  call_id?: string
  output_index?: number
  /** response.completed / response.failed */
  response?: {
    usage?: RawUsage
    error?: { message?: string; code?: string }
    /** НЕ используем — приватный backend отдаёт null (см. регрессию Hermes). */
    output?: unknown
    [k: string]: unknown
  }
  /** error-событие: либо строка, либо {message}. */
  error?: { message?: string; code?: string } | string
  message?: string
  [k: string]: unknown
}

/** Смапленный usage (camelCase, как в остальном коде Verstak). */
export interface CodexUsage {
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
}

export interface CodexToolCall {
  callId: string
  name: string
  /** Распарсенный JSON аргументов; если строка невалидна — исходная строка. */
  arguments: unknown
}

export interface CodexReducerResult {
  text: string
  toolCalls: CodexToolCall[]
  usage?: CodexUsage
  done: boolean
  error?: string
}

/** Накопитель одного tool-call'а между дельтами и финальным item. */
interface ToolAcc {
  callId: string
  name: string
  argsString: string
}

export class CodexSseReducer {
  // Текст из стрим-дельт (response.output_text.delta).
  private deltaText = ''
  // Текст из финальных message-item'ов (response.output_item.done) — авторитетный.
  private messageText = ''
  // tool-call'ы по ключу item_id (дельты) == item.id (финальный item).
  private tools = new Map<string, ToolAcc>()
  private usage: CodexUsage | undefined
  private done = false
  private error: string | undefined

  push(event: CodexSseEvent): void {
    switch (event.type) {
      case 'response.output_text.delta': {
        if (typeof event.delta === 'string') this.deltaText += event.delta
        break
      }
      case 'response.function_call_arguments.delta': {
        const key = argKey(event)
        if (!key) break
        const acc = this.ensureTool(key)
        if (typeof event.delta === 'string') acc.argsString += event.delta
        break
      }
      case 'response.function_call_arguments.done': {
        const key = argKey(event)
        if (!key) break
        const acc = this.ensureTool(key)
        // Полная строка авторитетнее накопленных дельт.
        if (typeof event.arguments === 'string') acc.argsString = event.arguments
        break
      }
      case 'response.output_item.done': {
        this.applyItem(event.item)
        break
      }
      case 'response.completed': {
        // usage берём отсюда; output НЕ читаем (может быть null).
        const u = event.response?.usage
        if (u) this.usage = mapUsage(u)
        this.done = true
        break
      }
      case 'response.failed': {
        this.error = extractError(event) ?? 'Codex Responses stream failed'
        this.done = true
        break
      }
      case 'error': {
        this.error = extractError(event) ?? 'Codex Responses stream error'
        this.done = true
        break
      }
      default:
        // Прочие события (response.created, *.added, reasoning-дельты и т.п.)
        // на результат не влияют — игнорируем.
        break
    }
  }

  getResult(): CodexReducerResult {
    // message-item'ы авторитетны; дельты — fallback, если финальных item'ов не было.
    const text = this.messageText.length > 0 ? this.messageText : this.deltaText

    const toolCalls: CodexToolCall[] = []
    for (const acc of this.tools.values()) {
      // Валидный tool-call обязан иметь имя (приходит с output_item.done).
      // Осколки от одних дельт без финального item отбрасываем.
      if (!acc.name) continue
      toolCalls.push({ callId: acc.callId, name: acc.name, arguments: parseArgs(acc.argsString) })
    }

    const result: CodexReducerResult = { text, toolCalls, done: this.done }
    if (this.usage) result.usage = this.usage
    if (this.error) result.error = this.error
    return result
  }

  private ensureTool(key: string): ToolAcc {
    let acc = this.tools.get(key)
    if (!acc) {
      acc = { callId: key, name: '', argsString: '' }
      this.tools.set(key, acc)
    }
    return acc
  }

  private applyItem(item: CodexOutputItem | undefined): void {
    if (!item) return
    if (item.type === 'message') {
      this.messageText += extractMessageText(item)
      return
    }
    if (item.type === 'function_call') {
      // item.id совпадает с item_id дельт; item.call_id — настоящий id вызова.
      const key = item.id ?? item.call_id
      if (!key) return
      const acc = this.ensureTool(key)
      if (typeof item.call_id === 'string' && item.call_id) acc.callId = item.call_id
      if (typeof item.name === 'string' && item.name) acc.name = item.name
      // Аргументы из финального item авторитетнее дельт.
      if (typeof item.arguments === 'string') acc.argsString = item.arguments
      return
    }
    // reasoning и прочие типы для итогового результата не нужны.
  }
}

/** Прогнать все события за раз и вернуть результат — удобная обёртка для тестов/вызова. */
export function reduceCodexSse(events: Iterable<CodexSseEvent>): CodexReducerResult {
  const reducer = new CodexSseReducer()
  for (const ev of events) reducer.push(ev)
  return reducer.getResult()
}

/** Ключ корреляции function-call дельт: item_id → call_id → output_index. */
function argKey(event: CodexSseEvent): string | undefined {
  if (typeof event.item_id === 'string' && event.item_id) return event.item_id
  if (typeof event.call_id === 'string' && event.call_id) return event.call_id
  if (typeof event.output_index === 'number') return 'idx:' + event.output_index
  return undefined
}

/** Достаёт текст из message-item: массив частей, готовая строка или item.text. */
function extractMessageText(item: CodexOutputItem): string {
  if (Array.isArray(item.content)) {
    return item.content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('')
  }
  if (typeof item.content === 'string') return item.content
  if (typeof item.text === 'string') return item.text
  return ''
}

/** JSON-строка аргументов → объект; при битом JSON возвращаем исходную строку. */
function parseArgs(raw: string): unknown {
  if (!raw || !raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** Мапит сырое usage backend'а в camelCase-форму Verstak. */
function mapUsage(u: RawUsage): CodexUsage {
  return {
    inputTokens: u.input_tokens ?? 0,
    cachedTokens: u.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
    totalTokens: u.total_tokens ?? 0
  }
}

/** Достаёт человекочитаемую ошибку из response.failed / error-события. */
function extractError(event: CodexSseEvent): string | undefined {
  const respErr = event.response?.error?.message
  if (typeof respErr === 'string' && respErr) return respErr
  if (typeof event.error === 'string' && event.error) return event.error
  if (event.error && typeof event.error === 'object' && typeof event.error.message === 'string' && event.error.message) {
    return event.error.message
  }
  if (typeof event.message === 'string' && event.message) return event.message
  return undefined
}
