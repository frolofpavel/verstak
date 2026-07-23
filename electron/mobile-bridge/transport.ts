import { randomUUID } from 'node:crypto'
import { parseEnvelope, type MobileEnvelope } from '../../mobile/shared/protocol'
import { MobileBridgeSession } from './session'

export interface DesktopTransportConfig { relayUrl: string; token: string; accountId: string; deviceId: string }

export class DesktopRelayTransport {
  private abort?: AbortController
  private reconnectTimer?: NodeJS.Timeout
  constructor(private readonly config: DesktopTransportConfig, private readonly session: MobileBridgeSession) {}
  async connect(): Promise<void> {
    this.abort?.abort()
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }
    this.abort = new AbortController()
    await this.openStream(this.abort.signal)
  }
  disconnect(): void {
    this.abort?.abort(); this.abort = undefined
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }
  }
  async emit(kind: MobileEnvelope['kind'], payload: unknown, id = randomUUID()): Promise<void> {
    await this.post({ v: 1, id, accountId: this.config.accountId, deviceId: this.config.deviceId, kind, sentAt: Date.now(), payload }, this.query())
  }
  private async openStream(signal: AbortSignal): Promise<void> {
    const query = this.query()
    const response = await fetch(`${this.config.relayUrl}/events?${query}`, { headers: { Authorization: `Bearer ${this.config.token}` }, signal })
    if (!response.ok || !response.body) throw new Error(`relay connection failed: ${response.status}`)
    console.info('[mobile] desktop bridge connected to relay', this.config.relayUrl)
    void this.consume(response.body, query, signal).catch(error => {
      if (!signal.aborted) this.scheduleReconnect(error)
    })
  }
  private query(): URLSearchParams {
    return new URLSearchParams({ accountId: this.config.accountId, deviceId: this.config.deviceId, role: 'desktop' })
  }
  private scheduleReconnect(error: unknown): void {
    console.warn('[mobile] desktop bridge disconnected; reconnecting soon', error instanceof Error ? error.message : String(error))
    if (this.abort?.signal.aborted || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.abort?.signal.aborted) return
      void this.openStream(this.abort!.signal).catch(nextError => this.scheduleReconnect(nextError))
    }, 2_000)
  }
  private async consume(stream: ReadableStream<Uint8Array>, query: URLSearchParams, signal: AbortSignal): Promise<void> {
    const reader = stream.getReader(); const decoder = new TextDecoder(); let buffer = ''
    while (!signal.aborted) {
      const { value, done } = await reader.read(); if (done) throw new Error('relay event stream ended')
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split('\n\n'); buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const line = frame.split('\n').find(part => part.startsWith('data:')); if (!line) continue
        const command = parseEnvelope(JSON.parse(line.slice(5)))
        try { await this.post(await this.session.handle(command), query) } catch (error) { await this.postError(command, error, query) }
      }
    }
  }
  private async post(envelope: MobileEnvelope, query: URLSearchParams): Promise<void> {
    await fetch(`${this.config.relayUrl}/messages?${query}`, { method: 'POST', headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(envelope) })
  }
  private async postError(command: MobileEnvelope, error: unknown, query: URLSearchParams): Promise<void> {
    await this.post({ v: 1, id: `${command.id}:transport-error`, accountId: command.accountId, deviceId: command.deviceId, kind: 'command.error', sentAt: Date.now(), payload: { requestId: command.id, message: error instanceof Error ? error.message : 'command failed' } }, query)
  }
}
