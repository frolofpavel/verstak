// session.ts — pairing + attach state для Connected Eyes.
//
// Secure pair (EXT-B1-R1):
//   1) Desktop выдаёт одноразовый короткоживущий bootstrap code.
//   2) Extension предъявляет code → durable pairingToken + sessionId.
//   3) Reconnect/restart: durable credentials; attach НЕ восстанавливается.
//
// Fail-closed: empty pair, arbitrary first token, foreign token/session → reject.
// Credential не логировать целиком (см. tokenFingerprint).

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BridgeTabInfo } from './protocol'
import { BRIDGE_UI_STATES, type BridgeUiState } from './constants'

/** TTL одноразового bootstrap code (мс). */
export const BOOTSTRAP_CODE_TTL_MS = 5 * 60 * 1000

export interface PairingFile {
  pairingToken: string
  sessionId: string
  createdAt: number
  lastPairedAt: number | null
}

export interface BootstrapCode {
  /** Короткий код, который пользователь вводит в extension (или передаёт side panel). */
  code: string
  expiresAt: number
  /** Одноразовый — после успешного pair гасится. */
  used: boolean
}

export interface BridgeSessionState {
  ui: BridgeUiState
  /** Live sessionId только после успешного pair на текущем соединении. */
  sessionId: string | null
  /**
   * Durable token в live-state — только пока socket authenticated.
   * Не логировать; UI desktop не должен показывать после pair.
   */
  pairingToken: string | null
  browserTaskId: string | null
  runId: string | null
  attachedTab: BridgeTabInfo | null
  lastError: string | null
  connected: boolean
  desktopOnline: boolean
  /** Есть ли durable pairing file (для UI «нужен re-pair» / bootstrap). */
  hasDurablePairing: boolean
  /** Активен ли неиспользованный bootstrap code. */
  hasActiveBootstrap: boolean
}

export interface BridgeSessionStore {
  getState(): BridgeSessionState
  /** @deprecated use issueBootstrapCode for first pair; loadPairing for durable. */
  ensurePairing(): PairingFile
  loadPairing(): PairingFile | null
  /**
   * Выдать одноразовый bootstrap code для первого pair.
   * Предыдущий неиспользованный код инвалидируется.
   */
  issueBootstrapCode(opts?: { ttlMs?: number }): BootstrapCode
  /** Текущий bootstrap (для desktop UI / tests). null если нет или expired/used. */
  getActiveBootstrapCode(): BootstrapCode | null
  /**
   * Fail-closed verify:
   * - empty → reject
   * - bootstrap code (first pair) → ok + new durable session
   * - durable token / sessionId (re-pair) → ok
   * - arbitrary token → reject
   */
  verifyPairing(
    token: string | undefined,
    sessionId: string | undefined,
  ): { ok: true; session: PairingFile; isBootstrap: boolean } | { ok: false; reason: string }
  markPaired(session: PairingFile): void
  /** Сброс live-auth (disconnect/reconnect). Durable file не трогаем. */
  clearLiveAuth(): void
  setActiveRun(browserTaskId: string | null, runId: string | null): void
  attachTab(tab: BridgeTabInfo, browserTaskId: string): void
  detachTab(): void
  setConnected(connected: boolean): void
  setDesktopOnline(online: boolean): void
  setError(message: string | null): void
  clearSessionFile(): void
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  try {
    return timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}

function deriveUi(s: {
  desktopOnline: boolean
  connected: boolean
  sessionId: string | null
  attachedTab: BridgeTabInfo | null
  lastError: string | null
}): BridgeUiState {
  if (s.lastError && !s.desktopOnline) return 'error'
  if (!s.desktopOnline) return 'offline'
  if (s.lastError) return 'error'
  if (!s.connected) return 'connecting'
  if (s.attachedTab && s.sessionId) return 'attached'
  if (s.sessionId) return 'paired'
  return 'connecting'
}

function newDurablePairing(): PairingFile {
  return {
    pairingToken: randomBytes(32).toString('hex'),
    sessionId: `bs-${randomBytes(12).toString('hex')}`,
    createdAt: Date.now(),
    lastPairedAt: null,
  }
}

/** 8-char Crockford-like code (без 0/O/1/I) — удобно вводить вручную. */
function generateBootstrapCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(8)
  let out = ''
  for (let i = 0; i < 8; i++) {
    out += alphabet[bytes[i]! % alphabet.length]
  }
  return out
}

export function createBridgeSessionStore(opts: {
  stateDir: string
  fileName?: string
  /** Injectable clock for tests. */
  now?: () => number
}): BridgeSessionStore {
  const filePath = join(opts.stateDir, opts.fileName ?? 'browser-bridge-pairing.json')
  const now = opts.now ?? (() => Date.now())

  // Live (per successful pair on current connection) — НЕ из ensurePairing/file alone.
  let pairingToken: string | null = null
  let sessionId: string | null = null
  let browserTaskId: string | null = null
  let runId: string | null = null
  let attachedTab: BridgeTabInfo | null = null
  let lastError: string | null = null
  let connected = false
  let desktopOnline = true

  let bootstrap: BootstrapCode | null = null

  function ensureDir(): void {
    mkdirSync(dirname(filePath), { recursive: true })
  }

  function loadPairing(): PairingFile | null {
    try {
      if (!existsSync(filePath)) return null
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<PairingFile>
      if (typeof raw.pairingToken !== 'string' || typeof raw.sessionId !== 'string') return null
      if (!raw.pairingToken || !raw.sessionId) return null
      return {
        pairingToken: raw.pairingToken,
        sessionId: raw.sessionId,
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now(),
        lastPairedAt: typeof raw.lastPairedAt === 'number' ? raw.lastPairedAt : null,
      }
    } catch {
      return null
    }
  }

  function persist(p: PairingFile): void {
    ensureDir()
    writeFileSync(filePath, JSON.stringify(p, null, 2), 'utf8')
  }

  function bootstrapActive(): BootstrapCode | null {
    if (!bootstrap || bootstrap.used) return null
    if (now() > bootstrap.expiresAt) return null
    return bootstrap
  }

  function getState(): BridgeSessionState {
    const ui = deriveUi({ desktopOnline, connected, sessionId, attachedTab, lastError })
    void BRIDGE_UI_STATES
    return {
      ui,
      sessionId,
      pairingToken,
      browserTaskId,
      runId,
      attachedTab,
      lastError,
      connected,
      desktopOnline,
      hasDurablePairing: !!loadPairing(),
      hasActiveBootstrap: !!bootstrapActive(),
    }
  }

  return {
    getState,
    loadPairing,
    ensurePairing(): PairingFile {
      // Сохраняем API для старых callers: durable file, БЕЗ live-auth.
      const existing = loadPairing()
      if (existing) return existing
      const p = newDurablePairing()
      persist(p)
      return p
    },
    issueBootstrapCode(optsIn) {
      const ttl = optsIn?.ttlMs ?? BOOTSTRAP_CODE_TTL_MS
      bootstrap = {
        code: generateBootstrapCode(),
        expiresAt: now() + ttl,
        used: false,
      }
      return { ...bootstrap }
    },
    getActiveBootstrapCode() {
      const b = bootstrapActive()
      return b ? { ...b } : null
    },
    verifyPairing(token, sid) {
      const t = typeof token === 'string' ? token.trim() : ''
      const s = typeof sid === 'string' ? sid.trim() : ''

      // Empty first pair — always reject.
      if (!t && !s) {
        return { ok: false, reason: 'empty pair запрещён: нужен bootstrap code или durable credentials' }
      }

      const file = loadPairing()

      // Durable re-pair / restart recovery.
      if (file) {
        // Strong path: durable pairingToken.
        if (t && safeEqual(t, file.pairingToken)) {
          return { ok: true, session: file, isBootstrap: false }
        }
        // Restart: sessionId from extension storage (must have been paired before).
        if (s && safeEqual(s, file.sessionId) && file.lastPairedAt) {
          // If token also provided and wrong — reject (don't allow session alone to override bad token).
          if (t && !safeEqual(t, file.pairingToken)) {
            return { ok: false, reason: 'pairing token/session не совпали (fail-closed)' }
          }
          return { ok: true, session: file, isBootstrap: false }
        }
        // Wrong credentials against existing file.
        if (t || s) {
          // Still allow bootstrap re-pair (user re-issues code to re-bind).
          const boot = bootstrapActive()
          if (boot && t && safeEqual(t, boot.code)) {
            boot.used = true
            bootstrap = boot
            const p = newDurablePairing()
            persist(p)
            return { ok: true, session: p, isBootstrap: true }
          }
          return { ok: false, reason: 'pairing token/session не совпали (fail-closed)' }
        }
      }

      // First pair: only via active bootstrap code.
      const boot = bootstrapActive()
      if (boot && t && safeEqual(t, boot.code)) {
        boot.used = true
        bootstrap = boot
        const p = newDurablePairing()
        persist(p)
        return { ok: true, session: p, isBootstrap: true }
      }

      // Arbitrary first token / expired bootstrap.
      if (!file) {
        return {
          ok: false,
          reason: 'первый pair требует одноразовый bootstrap code с desktop (fail-closed)',
        }
      }
      return { ok: false, reason: 'pairing token/session не совпали (fail-closed)' }
    },
    markPaired(session) {
      pairingToken = session.pairingToken
      sessionId = session.sessionId
      lastError = null
      connected = true
      const next: PairingFile = {
        ...session,
        lastPairedAt: now(),
      }
      persist(next)
    },
    clearLiveAuth() {
      // Disconnect / new socket: durable file stays; live auth + attach gone.
      pairingToken = null
      sessionId = null
      attachedTab = null
      // Keep browserTaskId/runId? Spec: no auto-continue actions; lineage for next attach
      // can be re-set by setActiveRun from desktop. Clear attach-bound, keep run hints? Safer clear attach only.
      // browserTaskId/runId are desktop lineage — keep for status after re-pair.
    },
    setActiveRun(btId, rId) {
      browserTaskId = btId
      runId = rId
    },
    attachTab(tab, btId) {
      attachedTab = tab
      browserTaskId = btId
      lastError = null
    },
    detachTab() {
      attachedTab = null
    },
    setConnected(c) {
      connected = c
    },
    setDesktopOnline(online) {
      desktopOnline = online
    },
    setError(message) {
      lastError = message
    },
    clearSessionFile() {
      try {
        if (existsSync(filePath)) unlinkSync(filePath)
      } catch { /* ignore */ }
      pairingToken = null
      sessionId = null
      attachedTab = null
      browserTaskId = null
      runId = null
      bootstrap = null
    },
  }
}

/** Fingerprint token for logs (не полный secret). */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12)
}
