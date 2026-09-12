// bridge-session.test.ts — pairing fail-closed + UI state (EXT-B1-R1).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createBridgeSessionStore,
  BOOTSTRAP_CODE_TTL_MS,
} from '../../../electron/ai/browser/bridge'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verstak-bridge-sess-'))
})

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('bridge session store', () => {
  it('ensurePairing creates durable file (legacy API, no live auth)', () => {
    const s = createBridgeSessionStore({ stateDir: dir })
    const p = s.ensurePairing()
    expect(p.pairingToken.length).toBeGreaterThan(16)
    expect(p.sessionId.startsWith('bs-')).toBe(true)
    const file = join(dir, 'browser-bridge-pairing.json')
    expect(existsSync(file)).toBe(true)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    expect(raw.pairingToken).toBe(p.pairingToken)
    // ensurePairing alone does NOT mark live-auth
    expect(s.getState().sessionId).toBeNull()
  })

  it('empty first pair → reject', () => {
    const s = createBridgeSessionStore({ stateDir: dir })
    const v = s.verifyPairing(undefined, undefined)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/empty|bootstrap/i)
  })

  it('arbitrary first token → reject', () => {
    const s = createBridgeSessionStore({ stateDir: dir })
    const v = s.verifyPairing('deadbeef'.repeat(8), undefined)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/bootstrap|fail-closed/i)
  })

  it('bootstrap code → durable session; code is one-shot', () => {
    const s = createBridgeSessionStore({ stateDir: dir })
    const boot = s.issueBootstrapCode()
    expect(boot.code.length).toBe(8)
    expect(s.getActiveBootstrapCode()?.code).toBe(boot.code)

    const v = s.verifyPairing(boot.code, undefined)
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.isBootstrap).toBe(true)
    expect(v.session.pairingToken.length).toBeGreaterThan(16)
    s.markPaired(v.session)

    // Same code cannot be reused
    expect(s.getActiveBootstrapCode()).toBeNull()
    const again = s.verifyPairing(boot.code, undefined)
    // After durable file exists, old bootstrap is used — reject foreign
    expect(again.ok).toBe(false)
  })

  it('expired bootstrap → reject', () => {
    let t = 1_000_000
    const s = createBridgeSessionStore({ stateDir: dir, now: () => t })
    const boot = s.issueBootstrapCode({ ttlMs: 1000 })
    t += 2000
    const v = s.verifyPairing(boot.code, undefined)
    expect(v.ok).toBe(false)
  })

  it('pair with matching durable token → ok', () => {
    const s = createBridgeSessionStore({ stateDir: dir })
    const boot = s.issueBootstrapCode()
    const first = s.verifyPairing(boot.code, undefined)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    s.markPaired(first.session)

    const v = s.verifyPairing(first.session.pairingToken, undefined)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.isBootstrap).toBe(false)
  })

  it('pair with matching sessionId after markPaired → ok (restart recovery)', () => {
    const s = createBridgeSessionStore({ stateDir: dir })
    const boot = s.issueBootstrapCode()
    const first = s.verifyPairing(boot.code, undefined)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    s.markPaired(first.session)

    const s2 = createBridgeSessionStore({ stateDir: dir })
    const v = s2.verifyPairing(undefined, first.session.sessionId)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.session.sessionId).toBe(first.session.sessionId)
  })

  it('sessionId alone before markPaired (lastPairedAt null) → reject', () => {
    const s = createBridgeSessionStore({ stateDir: dir })
    // ensurePairing writes file without lastPairedAt
    const p = s.ensurePairing()
    expect(p.lastPairedAt).toBeNull()
    const v = s.verifyPairing(undefined, p.sessionId)
    expect(v.ok).toBe(false)
  })

  it('чужой token → reject', () => {
    const s = createBridgeSessionStore({ stateDir: dir })
    const boot = s.issueBootstrapCode()
    const first = s.verifyPairing(boot.code, undefined)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    s.markPaired(first.session)
    const v = s.verifyPairing('deadbeef'.repeat(8), undefined)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/fail-closed|не совпали/i)
  })

  it('чужой sessionId → reject', () => {
    const s = createBridgeSessionStore({ stateDir: dir })
    const boot = s.issueBootstrapCode()
    const first = s.verifyPairing(boot.code, undefined)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    s.markPaired(first.session)
    const v = s.verifyPairing(undefined, 'bs-foreign-session-id')
    expect(v.ok).toBe(false)
  })

  it('attach → ui attached; detach → paired; offline → offline', () => {
    const s = createBridgeSessionStore({ stateDir: dir })
    const boot = s.issueBootstrapCode()
    const first = s.verifyPairing(boot.code, undefined)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    s.markPaired(first.session)
    s.setConnected(true)
    expect(s.getState().ui).toBe('paired')
    s.attachTab(
      { tabRef: 'tab-1', url: 'https://example.com/', title: 'Ex', origin: 'https://example.com' },
      'bt-1',
    )
    expect(s.getState().ui).toBe('attached')
    expect(s.getState().browserTaskId).toBe('bt-1')
    s.detachTab()
    expect(s.getState().ui).toBe('paired')
    expect(s.getState().attachedTab).toBeNull()
    s.setDesktopOnline(false)
    expect(s.getState().ui).toBe('offline')
  })

  it('clearLiveAuth drops attach; durable file stays', () => {
    const s = createBridgeSessionStore({ stateDir: dir })
    const boot = s.issueBootstrapCode()
    const first = s.verifyPairing(boot.code, undefined)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    s.markPaired(first.session)
    s.attachTab(
      { tabRef: 'tab-1', url: 'https://example.com/', title: 'Ex', origin: 'https://example.com' },
      'bt-1',
    )
    s.clearLiveAuth()
    expect(s.getState().sessionId).toBeNull()
    expect(s.getState().attachedTab).toBeNull()
    expect(existsSync(join(dir, 'browser-bridge-pairing.json'))).toBe(true)
    const loaded = s.loadPairing()
    expect(loaded?.sessionId).toBe(first.session.sessionId)
  })

  it('restart preserves pairing file, not attach', () => {
    const s = createBridgeSessionStore({ stateDir: dir })
    const boot = s.issueBootstrapCode()
    const first = s.verifyPairing(boot.code, undefined)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    s.markPaired(first.session)
    s.attachTab(
      { tabRef: 'tab-x', url: 'https://example.com/', title: 't', origin: 'https://example.com' },
      'bt-1',
    )
    const s2 = createBridgeSessionStore({ stateDir: dir })
    expect(s2.loadPairing()?.sessionId).toBe(first.session.sessionId)
    expect(s2.getState().attachedTab).toBeNull()
    expect(s2.getState().sessionId).toBeNull()
  })

  it('BOOTSTRAP_CODE_TTL_MS is 5 minutes', () => {
    expect(BOOTSTRAP_CODE_TTL_MS).toBe(5 * 60 * 1000)
  })
})
