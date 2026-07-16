// Срез 2.0.8-F: persistence usage. Каветат #1 — идемпотентность (double-finalize / crash-resume
// не создаёт 2-ю строку) — RED-тест ПЕРВЫМ. Плюс pricing_known=0 ≠ $0, дефект B в стоимости,
// null-семантика, cache-hit только где знаменатель известен, диагностика без текста промпта.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Database as DB } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { persistRunUsage, computeRunCost, listRunUsage, usageSummary } from '../../electron/storage/agent-run-usage'
import { normalizedUsage } from '../../shared/contracts/usage'

describe('agent_run_usage persistence (2.0.8-F)', () => {
  let dir: string
  let db: DB
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-run-usage-'))
    db = openDb(join(dir, 'test.db'))
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  const usage = (over = {}) => normalizedUsage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, inputAccounting: 'exclusive', ...over })
  const input = (over = {}) => ({ runId: 'r1', providerId: 'claude', model: 'claude-sonnet-4-6', transport: 'API', accountId: null, usage: usage(), ...over })

  it('migration 50 создаёт agent_run_usage', () => {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_run_usage'").get()).toBeTruthy()
  })

  // КАВЕТАТ #1 (ПЕРВЫМ): double-finalize / crash-resume-переигровка → РОВНО одна строка.
  it('идемпотентность: повторный persist того же run_id → 1 строка (INSERT OR IGNORE)', () => {
    persistRunUsage(db, input(), 1000)
    persistRunUsage(db, input({ usage: usage({ inputTokens: 999999 }) }), 2000) // «переигровка» с другими цифрами
    const rows = listRunUsage(db, {})
    expect(rows).toHaveLength(1)
    expect(rows[0].inputTokens).toBe(100) // первая запись победила, вторая — no-op
    expect(rows[0].runId).toBe('r1')
  })

  // Каветат #2: неизвестная цена → pricing_known=0, cost=null (НЕ $0).
  it('неизвестная модель → pricing_known=0, cost_amount=null (не $0)', () => {
    const c = computeRunCost('openai', 'gpt-НЕИЗВЕСТНАЯ', usage({ inputAccounting: 'inclusive' }))
    expect(c.pricingKnown).toBe(0)
    expect(c.costAmount).toBeNull()
    persistRunUsage(db, input({ runId: 'r2', providerId: 'openai', model: 'gpt-НЕИЗВЕСТНАЯ', usage: usage({ inputAccounting: 'inclusive' }) }), 1000)
    expect(listRunUsage(db, {})[0].pricingKnown).toBe(0)
    expect(listRunUsage(db, {})[0].costAmount).toBeNull()
  })

  it('CLI/локальные — заведомо бесплатны: pricing_known=1, cost=0 (НЕ «неизвестно»)', () => {
    expect(computeRunCost('claude-cli', 'claude-code', usage())).toEqual({ costAmount: 0, currency: 'USD', pricingKnown: 1 })
    expect(computeRunCost('ollama', 'llama3.3', usage())).toMatchObject({ costAmount: 0, pricingKnown: 1 })
  })

  // Дефект B (денежный) в persistence-стоимости: Claude=exclusive → billable НЕ вычитает cached.
  it('дефект B: exclusive Claude — стоимость по полному input, не заниженная', () => {
    // input=100 (свежий), cache_read=900, output=50. billable=100 (НЕ max(0,100−900)=0).
    // sonnet: 100/1M×$3 + 900/1M×$0.3 + 50/1M×$15 = 0.0003 + 0.00027 + 0.00075 = 0.00132.
    const excl = computeRunCost('claude', 'claude-sonnet-4-6', usage())
    expect(excl.costAmount!).toBeCloseTo(0.00132, 6)
    // Если бы вычитали (как inclusive-баг): billable=0 → только cachedCost 0.00027 → строго меньше.
    const inclBug = computeRunCost('claude', 'claude-sonnet-4-6', usage({ inputAccounting: 'inclusive' }))
    expect(excl.costAmount!).toBeGreaterThan(inclBug.costAmount!)
  })

  it('null токены сохраняются как null, НЕ 0 (каветат null-семантики)', () => {
    persistRunUsage(db, input({ runId: 'r3', usage: normalizedUsage({ inputAccounting: 'unknown' }) }), 1000)
    const row = listRunUsage(db, {})[0]
    expect(row.inputTokens).toBeNull()
    expect(row.outputTokens).toBeNull()
    expect(row.cacheReadTokens).toBeNull()
  })

  it('cache diagnostic хранит ТОЛЬКО reason-код (без текста промпта)', () => {
    persistRunUsage(db, input({ runId: 'r4', cacheDiagnosticCode: 'system-prompt-changed' }), 1000)
    const row = listRunUsage(db, {})[0]
    expect(row.cacheDiagnosticCode).toBe('system-prompt-changed')
    // структурно: RunUsageInput не имеет поля с текстом промпта → утечь нечему.
  })

  it('usageSummary: cache-hit доля ТОЛЬКО где знаменатель известен, иначе null', () => {
    persistRunUsage(db, input({ runId: 'a', usage: usage({ inputTokens: 1000, cacheReadTokens: 300 }) }), 1000)  // знаменатель известен
    persistRunUsage(db, input({ runId: 'b', usage: normalizedUsage({ outputTokens: 50, inputAccounting: 'unknown' }) }), 1100) // input не сообщён
    const groups = usageSummary(db, 0)
    const g = groups.find(x => x.model === 'claude-sonnet-4-6')!
    expect(g.runs).toBe(2)
    // знаменатель = 1000 (только run 'a'), cacheRead=300 → 0.3.
    expect(g.cacheHitShare).toBeCloseTo(0.3, 4)
  })

  it('usageSummary: нет строк с известным input → cacheHitShare = null (не «0%»)', () => {
    persistRunUsage(db, input({ runId: 'c', usage: normalizedUsage({ outputTokens: 10, inputAccounting: 'unknown' }) }), 1000)
    const g = usageSummary(db, 0)[0]
    expect(g.cacheHitShare).toBeNull()
  })
})
