// LSP-тул (Фаза 1b): generic JSON-RPC 2.0 клиент поверх транспорта.
//
// Транспорт инъектируется (send + onMessage), чтобы корреляцию запрос↔ответ можно
// было тестировать без живого процесса языкового сервера. Реальный транспорт
// (spawn процесса + stdio + LspDecoder) — тонкий адаптер поверх этого клиента.

import { encodeMessage } from './framing'

/** Канал к языковому серверу. send — в stdin; onMessage — декодированные из stdout. */
export interface LspTransport {
  send: (data: Buffer) => void
  onMessage: (cb: (msg: unknown) => void) => void
  close: () => void
}

interface JsonRpcResponse {
  jsonrpc?: string
  id?: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** Ошибка, пришедшая от сервера в поле `error` JSON-RPC ответа. */
export class LspError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message)
    this.name = 'LspError'
  }
}

const DEFAULT_TIMEOUT_MS = 15_000

export class LspClient {
  private nextId = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private notificationHandlers: Array<(method: string, params: unknown) => void> = []
  private closed = false

  constructor(private transport: LspTransport, private timeoutMs = DEFAULT_TIMEOUT_MS) {
    transport.onMessage(msg => this.handle(msg))
  }

  /** JSON-RPC запрос. Резолвится result'ом, реджектится LspError или таймаутом. */
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('LSP client закрыт'))
    const id = ++this.nextId
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LSP таймаут (${this.timeoutMs}мс): ${method}`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.transport.send(encodeMessage({ jsonrpc: '2.0', id, method, params }))
    })
  }

  /** JSON-RPC уведомление (без id, без ответа). */
  notify(method: string, params?: unknown): void {
    if (this.closed) return
    this.transport.send(encodeMessage({ jsonrpc: '2.0', method, params }))
  }

  /** Подписка на серверные уведомления (publishDiagnostics, logMessage и т.п.). */
  onNotification(cb: (method: string, params: unknown) => void): void {
    this.notificationHandlers.push(cb)
  }

  /** Закрыть клиент: реджектим всё незавершённое, закрываем транспорт. */
  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('LSP client закрыт'))
    }
    this.pending.clear()
    this.transport.close()
  }

  private handle(msg: unknown): void {
    if (msg == null || typeof msg !== 'object') return
    const m = msg as JsonRpcResponse & { method?: string; params?: unknown }
    // Ответ на наш запрос: есть наш id в pending.
    if (typeof m.id === 'number' && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!
      this.pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.error) p.reject(new LspError(m.error.code, m.error.message, m.error.data))
      else p.resolve(m.result)
      return
    }
    // Серверный запрос/уведомление (method есть, нашего pending нет) — отдаём
    // подписчикам. Серверные запросы с id (требующие ответа) в MVP игнорируем.
    if (typeof m.method === 'string') {
      for (const cb of this.notificationHandlers) {
        try { cb(m.method, m.params) } catch { /* подписчик не должен ронять клиент */ }
      }
    }
  }
}
