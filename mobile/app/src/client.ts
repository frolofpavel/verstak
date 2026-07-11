import { createEnvelope, parseEnvelope, type MobileEnvelope } from '../../shared/protocol'

export interface MobileClientConfig { relayUrl: string; token: string; accountId: string; deviceId: string }
type EventListener = (event: MobileEnvelope) => void

export class MobileClient {
  private abort?: AbortController
  private listeners = new Set<EventListener>()
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
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
  disconnect(): void { this.abort?.abort(); this.abort = undefined }
  async command(kind: MobileEnvelope['kind'], payload: unknown): Promise<unknown> {
    const id = crypto.randomUUID()
    const envelope = createEnvelope({ id, accountId: this.config.accountId, deviceId: this.config.deviceId, kind, payload })
    const query = new URLSearchParams({ accountId: this.config.accountId, deviceId: this.config.deviceId, role: 'mobile' })
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    const response = await fetch(`${this.config.relayUrl}/messages?${query}`, { method: 'POST', headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(envelope) })
    if (!response.ok) { this.pending.delete(id); throw new Error(await response.text()) }
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
          event.kind === 'command.error' ? pending.reject(new Error(payload.message ?? 'command failed')) : pending.resolve(payload.result)
        }
        for (const listener of this.listeners) listener(event)
      }
    }
  }
}
