import { createEnvelope, parseEnvelope, type MobileEnvelope } from '../../shared/protocol'

export interface MobileClientConfig { relayUrl: string; token: string; accountId: string; deviceId: string }
type EventListener = (event: MobileEnvelope) => void

export function createMobileRequestId(): string {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export class MobileClient {
  private abort?: AbortController
  private listeners = new Set<EventListener>()
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  constructor(private readonly config: MobileClientConfig) {}
  onEvent(listener: EventListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  async connect(): Promise<void> {
    this.abort?.abort()
    this.abort = new AbortController()
    const query = new URLSearchParams({ accountId: this.config.accountId, deviceId: this.config.deviceId, role: 'mobile' })
    const response = await fetch(`${this.config.relayUrl}/events?${query}`, { headers: { Authorization: `Bearer ${this.config.token}` }, signal: this.abort.signal })
    if (!response.ok || !response.body) throw new Error(`relay connection failed: ${response.status}`)
    void this.readEvents(response.body, this.abort.signal)
  }
  disconnect(): void {
    this.abort?.abort(); this.abort = undefined
    for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(new Error('Подключение закрыто')); this.pending.delete(id) }
  }
  async command(kind: MobileEnvelope['kind'], payload: unknown): Promise<unknown> {
    const id = createMobileRequestId()
    const envelope = createEnvelope({ id, accountId: this.config.accountId, deviceId: this.config.deviceId, kind, payload })
    const query = new URLSearchParams({ accountId: this.config.accountId, deviceId: this.config.deviceId, role: 'mobile' })
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Компьютер не ответил за 30 секунд. Проверь, что окна relay, desktop и PWA запущены.'))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timer })
    })
    let response: Response
    try {
      response = await fetch(`${this.config.relayUrl}/messages?${query}`, { method: 'POST', headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(envelope) })
    } catch (error) {
      const pending = this.pending.get(id)
      if (pending) clearTimeout(pending.timer)
      this.pending.delete(id)
      throw error
    }
    if (!response.ok) {
      const pending = this.pending.get(id)
      if (pending) clearTimeout(pending.timer)
      this.pending.delete(id)
      const text = await response.text()
      throw new Error(response.status === 409 ? 'Компьютер пока не подключён к relay. Подожди 5-10 секунд или проверь служебные окна на компьютере.' : text)
    }
    return result
  }
  private async readEvents(stream: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (!signal.aborted) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split('\n\n'); buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const line = frame.split('\n').find(part => part.startsWith('data:'))
        if (!line) continue
        const event = parseEnvelope(JSON.parse(line.slice(5)))
        const payload = event.payload as { requestId?: string; result?: unknown; message?: string }
        if (payload.requestId && this.pending.has(payload.requestId)) {
          const pending = this.pending.get(payload.requestId)!; this.pending.delete(payload.requestId)
          clearTimeout(pending.timer)
          event.kind === 'command.error' ? pending.reject(new Error(payload.message ?? 'command failed')) : pending.resolve(payload.result)
        }
        for (const listener of this.listeners) listener(event)
      }
    }
  }
}
