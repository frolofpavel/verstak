import { parseEnvelope, type MobileEnvelope } from '../../mobile/shared/protocol'
import { MobileBridgeSession } from './session'

export interface DesktopTransportConfig { relayUrl: string; token: string; accountId: string; deviceId: string }

export class DesktopRelayTransport {
  private abort?: AbortController
  constructor(private readonly config: DesktopTransportConfig, private readonly session: MobileBridgeSession) {}
  async connect(): Promise<void> {
    this.abort?.abort(); this.abort = new AbortController()
    const query = new URLSearchParams({ accountId: this.config.accountId, deviceId: this.config.deviceId, role: 'desktop' })
    const response = await fetch(`${this.config.relayUrl}/events?${query}`, { headers: { Authorization: `Bearer ${this.config.token}` }, signal: this.abort.signal })
    if (!response.ok || !response.body) throw new Error(`relay connection failed: ${response.status}`)
    void this.consume(response.body, query, this.abort.signal)
  }
  disconnect(): void { this.abort?.abort(); this.abort = undefined }
  private async consume(stream: ReadableStream<Uint8Array>, query: URLSearchParams, signal: AbortSignal): Promise<void> {
    const reader = stream.getReader(); const decoder = new TextDecoder(); let buffer = ''
    while (!signal.aborted) {
      const { value, done } = await reader.read(); if (done) return
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
