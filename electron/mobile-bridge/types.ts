import type { MobileCommand, MobileEnvelope } from '../../mobile/shared/protocol'

export type MobileCommandHandler = (payload: unknown, command: MobileCommand) => Promise<unknown>
export type MobileCommandHandlers = Partial<Record<MobileCommand['kind'], MobileCommandHandler>>
export type MobileCommandResponse = MobileEnvelope<{ requestId: string; result?: unknown; message?: string }>
