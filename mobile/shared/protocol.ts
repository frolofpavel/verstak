export const MOBILE_COMMAND_KINDS = [
  'device.snapshot',
  'roots.list',
  'files.list',
  'chats.list',
  'chat.create',
  'chat.history',
  'chat.send',
  'run.stop',
  'approval.resolve',
  'changes.list',
  'attachment.stage',
] as const

export const MOBILE_EVENT_KINDS = [
  'device.status',
  'chat.message',
  'run.status',
  'run.event',
  'approval.requested',
  'changes.updated',
  'command.result',
  'command.error',
] as const

export type MobileCommandKind = typeof MOBILE_COMMAND_KINDS[number]
export type MobileEventKind = typeof MOBILE_EVENT_KINDS[number]
export type MobileMessageKind = MobileCommandKind | MobileEventKind

export interface MobileEnvelope<T = unknown> {
  v: 1
  id: string
  accountId: string
  deviceId: string
  kind: MobileMessageKind
  sentAt: number
  payload: T
}

export type MobileCommand = MobileEnvelope & { kind: MobileCommandKind }
export type MobileEvent = MobileEnvelope & { kind: MobileEventKind }

const kinds = new Set<string>([...MOBILE_COMMAND_KINDS, ...MOBILE_EVENT_KINDS])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.trim() === '') throw new Error(`invalid ${key}`)
  return field
}

export function parseEnvelope(value: unknown): MobileEnvelope {
  if (!isRecord(value)) throw new Error('envelope must be an object')
  if (value.v !== 1) throw new Error('unsupported protocol version')
  const id = requireString(value, 'id')
  const accountId = requireString(value, 'accountId')
  const deviceId = requireString(value, 'deviceId')
  const kind = requireString(value, 'kind')
  if (!kinds.has(kind)) throw new Error('unknown message kind')
  if (typeof value.sentAt !== 'number' || !Number.isFinite(value.sentAt)) throw new Error('invalid sentAt')
  if (!Object.hasOwn(value, 'payload')) throw new Error('invalid payload')
  return { v: 1, id, accountId, deviceId, kind: kind as MobileMessageKind, sentAt: value.sentAt, payload: value.payload }
}

export function createEnvelope<T>(input: Omit<MobileEnvelope<T>, 'v' | 'sentAt'> & { sentAt?: number }): MobileEnvelope<T> {
  return { v: 1, sentAt: input.sentAt ?? Date.now(), ...input }
}
