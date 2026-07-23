import type { MobileEnvelope } from '../shared/protocol'
import type { RelayIdentity } from './auth'

export type RelaySend = (envelope: MobileEnvelope) => void
export interface RelayAuditEntry {
  id: string
  accountId: string
  deviceId: string
  kind: string
  delivered: number
}

export function createRelayRouter(options: { replayLimit?: number } = {}) {
  const connections = new Map<string, Set<RelaySend>>()
  const replay = new Set<string>()
  const order: string[] = []
  const auditEntries: RelayAuditEntry[] = []
  const replayLimit = options.replayLimit ?? 2_000
  const key = (identity: RelayIdentity) => `${identity.accountId}:${identity.deviceId}:${identity.role}`

  return {
    registerConnection(identity: RelayIdentity, send: RelaySend): () => void {
      const k = key(identity)
      const set = connections.get(k) ?? new Set<RelaySend>()
      set.add(send)
      connections.set(k, set)
      return () => {
        set.delete(send)
        if (set.size === 0) connections.delete(k)
      }
    },
    route(envelope: MobileEnvelope): { delivered: number } {
      if (replay.has(envelope.id)) throw new Error('replayed envelope')
      replay.add(envelope.id)
      order.push(envelope.id)
      if (order.length > replayLimit) replay.delete(order.shift()!)
      const targetRole: RelayIdentity['role'] = envelope.kind === 'command.result' || envelope.kind === 'command.error' || envelope.kind.includes('.') && ['device.status', 'chat.message', 'run.status', 'run.event', 'approval.requested', 'changes.updated'].includes(envelope.kind)
        ? 'mobile'
        : 'desktop'
      const targets = connections.get(key({ accountId: envelope.accountId, deviceId: envelope.deviceId, role: targetRole }))
      let delivered = 0
      for (const send of targets ?? []) { send(envelope); delivered++ }
      auditEntries.push({ id: envelope.id, accountId: envelope.accountId, deviceId: envelope.deviceId, kind: envelope.kind, delivered })
      return { delivered }
    },
    audit(): readonly RelayAuditEntry[] { return auditEntries },
  }
}
