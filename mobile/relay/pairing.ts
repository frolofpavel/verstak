import { randomBytes, randomInt } from 'node:crypto'

interface PendingPairing { accountId: string; deviceId: string; expiresAt: number }
interface DeviceIdentity { accountId: string; deviceId: string }

export class PairingStore {
  private readonly pending = new Map<string, PendingPairing>()
  private readonly credentials = new Map<string, DeviceIdentity>()
  constructor(private readonly options: { ttlMs?: number } = {}) {}
  create(accountId: string, deviceId: string): { code: string; expiresAt: number } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const expiresAt = Date.now() + (this.options.ttlMs ?? 600_000)
    this.pending.set(code, { accountId, deviceId, expiresAt })
    return { code, expiresAt }
  }
  consume(code: string): DeviceIdentity & { credential: string } {
    const pending = this.pending.get(code)
    if (!pending) throw new Error('invalid pairing code')
    this.pending.delete(code)
    if (pending.expiresAt <= Date.now()) throw new Error('expired pairing code')
    const credential = randomBytes(32).toString('base64url')
    const identity = { accountId: pending.accountId, deviceId: pending.deviceId }
    this.credentials.set(credential, identity)
    return { ...identity, credential }
  }
  verify(credential: string): DeviceIdentity | null { return this.credentials.get(credential) ?? null }
  revoke(credential: string): void { this.credentials.delete(credential) }
}
