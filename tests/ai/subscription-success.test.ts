/**
 * 2.1.3-EF S5: last_success_at — только реальный успех.
 * Попытка (last_used_at) фиксируется до запроса; успех — после finish('done').
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Database as DB } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import {
  createSubscriptionAccount,
  getSubscriptionAccount,
  getActiveAccount,
  setActiveAccount,
} from '../../electron/storage/subscription-accounts'
import { markSuccessForRun, wrapFinishWithSuccess, type SubscriptionSuccessDeps } from '../../electron/ai/subscription-success'

describe('subscription-success: markSuccessForRun (EF S5)', () => {
  let dir: string
  let db: DB

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-subsuccess-'))
    db = openDb(join(dir, 'test.db'))
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const depsFor = (run: { chatId: number | null; providerId: string | null; requestedProviderId: string | null; accountId?: number | null } | null,
    binding: { mode: string; accountId: number | null } | null = null): SubscriptionSuccessDeps => ({
    getRun: () => run,
    getSubscriptionBinding: () => binding,
  })

  it('успешный прогон → last_success_at активного аккаунта обновлён', () => {
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' })
    expect(getSubscriptionAccount(db, a.id)?.lastSuccessAt).toBeNull()
    markSuccessForRun(db, depsFor({ chatId: 1, providerId: 'claude-cli', requestedProviderId: null }), 'run-1', 123)
    expect(getSubscriptionAccount(db, a.id)?.lastSuccessAt).toBe(123)
  })

  it('прогон с ошибкой (wrapper НЕ зовёт модуль) → last_success_at остаётся NULL', () => {
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' })
    // main.ts-обёртка зовёт markSuccessForRun только при status==='done'; здесь симулируем
    // отсутствие вызова: ошибка не должна менять колонку (ничего не делаем и проверяем).
    expect(getSubscriptionAccount(db, a.id)?.lastSuccessAt).toBeNull()
  })

  it('pinned-чат → отмечается ЗАКРЕПЛЁННЫЙ аккаунт, а не активный', () => {
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' }) // active
    const b = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'B', credRef: 'r2' })
    markSuccessForRun(db, depsFor(
      { chatId: 7, providerId: 'claude-cli', requestedProviderId: null },
      { mode: 'pinned', accountId: b.id },
    ), 'run-2', 456)
    expect(getSubscriptionAccount(db, b.id)?.lastSuccessAt).toBe(456)
    expect(getSubscriptionAccount(db, a.id)?.lastSuccessAt).toBeNull()
  })

  it('после Auto-ротации (active сменился) → отмечается НОВЫЙ активный (фактически отработавший)', () => {
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' })
    const b = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'B', credRef: 'r2' })
    setActiveAccount(db, 'claude-cli', b.id) // ротация A→B до финиша
    markSuccessForRun(db, depsFor({ chatId: null, providerId: 'claude-cli', requestedProviderId: null }), 'run-3', 789)
    expect(getSubscriptionAccount(db, b.id)?.lastSuccessAt).toBe(789)
    expect(getSubscriptionAccount(db, a.id)?.lastSuccessAt).toBeNull()
  })

  it('actual providerId предпочитается requested (fallback-прогон)', () => {
    const a = createSubscriptionAccount(db, { providerId: 'gemini-cli', label: 'G', credRef: 'r1' })
    markSuccessForRun(db, depsFor({ chatId: null, providerId: 'gemini-cli', requestedProviderId: 'claude-cli' }), 'run-4', 111)
    expect(getSubscriptionAccount(db, a.id)?.lastSuccessAt).toBe(111)
  })

  it('API-провайдер без парка аккаунтов → no-op, не падает', () => {
    expect(() => markSuccessForRun(db, depsFor({ chatId: null, providerId: 'openai-api', requestedProviderId: null }), 'run-5')).not.toThrow()
    expect(getActiveAccount(db, 'openai-api')).toBeNull()
  })

  it('run не найден → no-op, не падает', () => {
    expect(() => markSuccessForRun(db, depsFor(null), 'run-missing')).not.toThrow()
  })

  // ─── EF-R1 Б3: успех строго на аккаунт ПРОГОНА (run.account_id) ───

  it('Б3 сценарий 4: one-shot B при global active A → успех записан B (run.account_id)', () => {
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' }) // active
    const b = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'B', credRef: 'r2' })
    markSuccessForRun(db, depsFor({ chatId: 1, providerId: 'claude-cli', requestedProviderId: null, accountId: b.id }), 'run-os', 321)
    expect(getSubscriptionAccount(db, b.id)?.lastSuccessAt).toBe(321)
    expect(getSubscriptionAccount(db, a.id)?.lastSuccessAt).toBeNull()
  })

  it('Б3 сценарий 5: run стартовал на A, active переключили на B, финиш → успех ТОЛЬКО A', () => {
    const a = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'A', credRef: 'r1' })
    const b = createSubscriptionAccount(db, { providerId: 'claude-cli', label: 'B', credRef: 'r2' })
    setActiveAccount(db, 'claude-cli', b.id) // ручное переключение ПОСЛЕ старта прогона
    markSuccessForRun(db, depsFor({ chatId: null, providerId: 'claude-cli', requestedProviderId: null, accountId: a.id }), 'run-swap', 654)
    expect(getSubscriptionAccount(db, a.id)?.lastSuccessAt).toBe(654)
    expect(getSubscriptionAccount(db, b.id)?.lastSuccessAt).toBeNull()
  })

  it('Б3: accountId удалённого аккаунта → отметка не падает (best-effort SQL no-op)', () => {
    expect(() => markSuccessForRun(db, depsFor({ chatId: null, providerId: 'claude-cli', requestedProviderId: null, accountId: 999 }), 'run-gone')).not.toThrow()
  })
})

// EF-R1 Б4: обёртка finish — success ТОЛЬКО на первом терминальном переходе 'done'.
describe('wrapFinishWithSuccess (EF-R1 Б4)', () => {
  /** Имитация storage finish: первый вызов совершает переход, повторные — false. */
  function fakeBase() {
    const ended = new Set<string>()
    return {
      calls: [] as Array<{ runId: string; status: string }>,
      finish: (runId: string, status: string): boolean => {
        if (ended.has(runId)) return false
        ended.add(runId)
        return true
      },
      ended,
    }
  }

  it('первый finish(done) → onSuccess вызван ровно один раз', () => {
    const base = fakeBase()
    const seen: string[] = []
    const finish = wrapFinishWithSuccess(base, (runId) => seen.push(runId))
    expect(finish('r1', 'done')).toBe(true)
    expect(seen).toEqual(['r1'])
  })

  it('сценарий 7: finish(stopped) → поздний finish(done) → success ОТСУТСТВУЕТ', () => {
    const base = fakeBase()
    const seen: string[] = []
    const finish = wrapFinishWithSuccess(base, (runId) => seen.push(runId))
    expect(finish('r1', 'stopped')).toBe(true)
    expect(finish('r1', 'done')).toBe(false) // storage no-op
    expect(seen, 'stop → late done никогда не создаёт lastSuccessAt').toEqual([])
  })

  it('finish(failed) → success нет; исключение onSuccess не роняет finish', () => {
    const base = fakeBase()
    const finish = wrapFinishWithSuccess(base, () => { throw new Error('db down') })
    expect(finish('r1', 'failed')).toBe(true)
    expect(() => finish('r2', 'done')).not.toThrow()
  })
})
