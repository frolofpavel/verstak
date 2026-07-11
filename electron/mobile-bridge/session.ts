import { createEnvelope, MOBILE_COMMAND_KINDS, type MobileCommand, type MobileEnvelope } from '../../mobile/shared/protocol'
import { IdempotencyCache } from './idempotency'
import type { MobileCommandHandlers, MobileCommandResponse } from './types'

export class MobileBridgeSession {
  private readonly cache = new IdempotencyCache<MobileCommandResponse>()
  constructor(private readonly handlers: MobileCommandHandlers) {}

  async handle(envelope: MobileEnvelope): Promise<MobileCommandResponse> {
    if (!MOBILE_COMMAND_KINDS.includes(envelope.kind as MobileCommand['kind'])) throw new Error('mobile event cannot be handled as a command')
    const command = envelope as MobileCommand
    const cached = this.cache.get(command.id)
    if (cached) {
      if (command.kind === 'approval.resolve') throw new Error('approval replay is forbidden')
      return cached
    }
    const handler = this.handlers[command.kind]
    if (!handler) throw new Error(`unsupported mobile command: ${command.kind}`)
    try {
      const result = await handler(command.payload, command)
      const response = createEnvelope({ id: `${command.id}:result`, accountId: command.accountId, deviceId: command.deviceId, kind: 'command.result', payload: { requestId: command.id, result } }) as MobileCommandResponse
      this.cache.set(command.id, response)
      return response
    } catch (error) {
      const response = createEnvelope({ id: `${command.id}:error`, accountId: command.accountId, deviceId: command.deviceId, kind: 'command.error', payload: { requestId: command.id, message: error instanceof Error ? error.message : 'command failed' } }) as MobileCommandResponse
      this.cache.set(command.id, response)
      throw error
    }
  }
}
