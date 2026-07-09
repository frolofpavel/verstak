import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Database as DB } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import {
  createSubscriptionAccount,
  listSubscriptionAccounts,
  getSubscriptionAccount,
  getActiveAccount,
  setActiveAccount,
  renameSubscriptionAccount,
  deleteSubscriptionAccount,
  touchSubscriptionAccount,
} from '../../electron/storage/subscription-accounts'

describe('subscription accounts storage', () => {
  let dir: string
  let db: DB

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-subacct-'))
    db = openDb(join(dir, 'test.db'))
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('migration 44 creates subscription_accounts table', () => {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='subscription_accounts'").get()
    expect(t).toBeTruthy()
  })

  it('creates an account; first account for a provider becomes active automatically', () => {
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'Личный Max', credRef: 'subacct:claude:1' })
    expect(a.id).toBeGreaterThan(0)
    expect(a.providerId).toBe('claude-cli')
    expect(a.label).toBe('Личный Max')
    expect(a.active).toBe(true) // первый для провайдера — активен
    expect(a.lastUsedAt).toBeNull()
  })

  it('second account for same provider does NOT auto-activate; only one active per provider', () => {
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' })
    const b = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'B', credRef: 'r2' })
    expect(a.active).toBe(true)
    expect(b.active).toBe(false)
    // accounts for a DIFFERENT provider have their own active
    const g = createSubscriptionAccount(db, { providerId: 'gemini-cli', label: 'G', credRef: 'r3' })
    expect(g.active).toBe(true)
  })

  it('setActiveAccount switches exclusively within a provider, not across providers', () => {
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' })
    const b = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'B', credRef: 'r2' })
    const g = createSubscriptionAccount(db, { providerId: 'gemini-cli', label: 'G', credRef: 'r3' })

    setActiveAccount(db, 'claude-cli', b.id)
    expect(getActiveAccount(db, 'claude-cli')?.id).toBe(b.id)
    expect(getSubscriptionAccount(db, a.id)?.active).toBe(false)
    // gemini's active is untouched
    expect(getActiveAccount(db, 'gemini-cli')?.id).toBe(g.id)
  })

  it('lists by provider, ordered newest first', () => {
    createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' })
    createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'B', credRef: 'r2' })
    createSubscriptionAccount(db, { providerId: 'gemini-cli', label: 'G', credRef: 'r3' })
    const claude = listSubscriptionAccounts(db, 'claude-cli')
    expect(claude.map(a => a.label)).toEqual(['B', 'A'])
    expect(listSubscriptionAccounts(db).length).toBe(3)
  })

  it('rename and touch update fields', () => {
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'Old', credRef: 'r1' })
    renameSubscriptionAccount(db, a.id, 'New')
    expect(getSubscriptionAccount(db, a.id)?.label).toBe('New')
    touchSubscriptionAccount(db, a.id, 12345)
    expect(getSubscriptionAccount(db, a.id)?.lastUsedAt).toBe(12345)
  })

  it('config-dir account (Codex) persists configDir and has no secret', () => {
    const a = createSubscriptionAccount(db, { providerId: 'codex-cli', label: 'Рабочий', credRef: '', configDir: '/data/cli-accounts/codex-abc' })
    const got = getSubscriptionAccount(db, a.id)!
    expect(got.configDir).toBe('/data/cli-accounts/codex-abc')
    expect(got.credRef).toBe('')
    expect(got.active).toBe(true) // первый для codex-cli — активен
    // отдельный пул от claude-cli
    const c = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'C', credRef: 'r1' })
    expect(c.active).toBe(true)
    expect(getActiveAccount(db, 'codex-cli')?.id).toBe(a.id)
  })

  it('delete removes account; if the active one is deleted, another becomes active', () => {
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' })
    const b = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'B', credRef: 'r2' })
    expect(getActiveAccount(db, 'claude-cli')?.id).toBe(a.id)
    deleteSubscriptionAccount(db, a.id)
    expect(getSubscriptionAccount(db, a.id)).toBeNull()
    // оставшийся аккаунт становится активным (не осиротить провайдера без активного)
    expect(getActiveAccount(db, 'claude-cli')?.id).toBe(b.id)
  })
})
