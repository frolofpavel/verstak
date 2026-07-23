import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PairingStore } from '../../mobile/relay/pairing'
import { validateAttachment } from '../../electron/mobile-bridge/attachments'

describe('mobile pairing and attachments', () => {
  it('pairing code is one-time, expiring and revocable', () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000)
    const store = new PairingStore({ ttlMs: 600_000 })
    const pair = store.create('account', 'device')
    const credential = store.consume(pair.code)
    expect(credential.accountId).toBe('account')
    expect(() => store.consume(pair.code)).toThrow('invalid pairing code')
    store.revoke(credential.credential)
    expect(store.verify(credential.credential)).toBeNull()
    const expired = store.create('account', 'other'); vi.advanceTimersByTime(600_001)
    expect(() => store.consume(expired.code)).toThrow('expired pairing code')
    vi.useRealTimers()
  })

  it('validates staged attachment destination', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'verstak-upload-'))
    expect(validateAttachment({ name: 'brief.pdf', size: 20, stagingDir: staging }).name).toBe('brief.pdf')
    expect(() => validateAttachment({ name: '../.env', size: 20, stagingDir: staging })).toThrow()
    expect(() => validateAttachment({ name: 'huge.zip', size: 30_000_000, stagingDir: staging })).toThrow('large')
  })
})
