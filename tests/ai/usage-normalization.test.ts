// Срез 2.0.8-E: нормализация usage + cache accounting. Fixtures — РЕАЛЬНЫЕ обезличенные shapes
// провайдеров (каветат: придумывать поля запрещено). Ядро — билляемый input с ЯВНОЙ семантикой
// кэша: exclusive (Claude) НЕ вычитает cached, inclusive (OpenAI/Gemini/Codex-Responses) вычитает.
import { describe, it, expect } from 'vitest'
import { billableInputTokens, normalizedUsage, type InputAccounting } from '../../shared/contracts/usage'

describe('billableInputTokens — дефект B (двойное вычитание кэша у Claude)', () => {
  it('exclusive (Claude): cached НЕ вычитается — input уже без кэша', () => {
    // Claude: input_tokens=100 (свежий), cache_read=900. billable = 100 (НЕ max(0,100-900)=0).
    expect(billableInputTokens({ inputTokens: 100, cacheReadTokens: 900, inputAccounting: 'exclusive' })).toBe(100)
  })
  it('inclusive (OpenAI/Gemini): billable = input − cacheRead (cached ⊂ input)', () => {
    // OpenAI: prompt_tokens=1000 включает cached=900. billable = 100.
    expect(billableInputTokens({ inputTokens: 1000, cacheReadTokens: 900, inputAccounting: 'inclusive' })).toBe(100)
  })
  it('inclusive: клампится в 0, не уходит в минус', () => {
    expect(billableInputTokens({ inputTokens: 500, cacheReadTokens: 800, inputAccounting: 'inclusive' })).toBe(0)
  })
  it('inclusive без cacheRead (null) → input как есть (нечего вычитать)', () => {
    expect(billableInputTokens({ inputTokens: 300, cacheReadTokens: null, inputAccounting: 'inclusive' })).toBe(300)
  })
  it('unknown → НЕ вычитаем (каветат #4: без подтверждённой семантики)', () => {
    expect(billableInputTokens({ inputTokens: 1000, cacheReadTokens: 900, inputAccounting: 'unknown' })).toBe(1000)
  })
  it('input не сообщён (null) → null, НЕ 0 (каветат #1)', () => {
    expect(billableInputTokens({ inputTokens: null, cacheReadTokens: 900, inputAccounting: 'inclusive' })).toBe(null)
  })
})

describe('normalizedUsage — null на границе (каветат #1) + deprecated-мост', () => {
  it('не сообщённые поля → null, НЕ 0', () => {
    const u = normalizedUsage({ inputAccounting: 'unknown' })
    expect(u.inputTokens).toBe(null)
    expect(u.outputTokens).toBe(null)
    expect(u.cacheReadTokens).toBe(null)
    expect(u.cacheWriteTokens).toBe(null)
    expect(u.providerReportedInputTokens).toBeUndefined() // не сообщён → нет аудит-поля
  })
  it('сообщённый input → providerReportedInputTokens = raw', () => {
    const u = normalizedUsage({ inputTokens: 42, inputAccounting: 'exclusive' })
    expect(u.inputTokens).toBe(42)
    expect(u.providerReportedInputTokens).toBe(42)
  })
  it('deprecated-мост: старые имена = новые (для потребителей до commit 2)', () => {
    const u = normalizedUsage({ inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 3, inputAccounting: 'exclusive' })
    expect(u.cachedInputTokens).toBe(5)          // = cacheReadTokens
    expect(u.cacheCreationInputTokens).toBe(3)   // = cacheWriteTokens (раньше терялось у всех, кроме claude.ts)
  })
  it('null cache → deprecated-мост 0 (прежний дефолт потребителей)', () => {
    const u = normalizedUsage({ inputTokens: 10, inputAccounting: 'unknown' })
    expect(u.cachedInputTokens).toBe(0)
    expect(u.cacheCreationInputTokens).toBe(0)
  })
  it('0 ≠ null: провайдер сообщил ровно 0 — сохраняем 0, не теряем', () => {
    const u = normalizedUsage({ inputTokens: 0, outputTokens: 0, inputAccounting: 'exclusive' })
    expect(u.inputTokens).toBe(0)
    expect(u.outputTokens).toBe(0)
    expect(u.providerReportedInputTokens).toBe(0)
  })
})

// Acceptance: таблица fixtures с РЕАЛЬНЫМИ обезличенными shapes провайдеров + inputAccounting,
// который ставит адаптер. Доказывает: double-count кэша невозможен.
describe('Fixtures провайдеров — double-count кэша невозможен (acceptance)', () => {
  interface Fixture {
    name: string
    accounting: InputAccounting
    // reported input провайдера + cache read (реальные обезличенные значения).
    reportedInput: number
    cacheRead: number
    cacheWrite?: number
    expectedBillable: number
  }
  const FIXTURES: Fixture[] = [
    // Claude API/CLI — EXCLUSIVE: input_tokens БЕЗ кэша; cache_read/creation отдельно.
    { name: 'Claude API (input_tokens=120, cache_read=4880, cache_creation=200)', accounting: 'exclusive', reportedInput: 120, cacheRead: 4880, cacheWrite: 200, expectedBillable: 120 },
    { name: 'Claude CLI (input_tokens=50, cache_read=10000)', accounting: 'exclusive', reportedInput: 50, cacheRead: 10000, expectedBillable: 50 },
    // Codex OAuth (Responses), OpenAI-compat, Gemini API — INCLUSIVE: cached ⊂ input.
    { name: 'Codex OAuth (input_tokens=5000, cached_tokens=4800)', accounting: 'inclusive', reportedInput: 5000, cacheRead: 4800, expectedBillable: 200 },
    { name: 'OpenAI-compat (prompt_tokens=3000, cached_tokens=2900)', accounting: 'inclusive', reportedInput: 3000, cacheRead: 2900, expectedBillable: 100 },
    { name: 'Gemini API (promptTokenCount=8000, cachedContentTokenCount=7000)', accounting: 'inclusive', reportedInput: 8000, cacheRead: 7000, expectedBillable: 1000 },
    // Codex/Gemini CLI — UNKNOWN: не вычитаем без подтверждённой семантики (каветат #4). CLI=$0.
    { name: 'Codex CLI (мульти-shape, unknown)', accounting: 'unknown', reportedInput: 1000, cacheRead: 900, expectedBillable: 1000 },
    { name: 'Gemini CLI (мульти-shape, unknown)', accounting: 'unknown', reportedInput: 1000, cacheRead: 900, expectedBillable: 1000 },
  ]
  for (const f of FIXTURES) {
    it(`${f.name} → billable ${f.expectedBillable}`, () => {
      const u = normalizedUsage({ inputTokens: f.reportedInput, cacheReadTokens: f.cacheRead, cacheWriteTokens: f.cacheWrite ?? null, inputAccounting: f.accounting })
      const billable = billableInputTokens(u)
      expect(billable).toBe(f.expectedBillable)
      // Double-count невозможен: billable НИКОГДА не превышает reported input и ≥ 0.
      expect(billable!).toBeGreaterThanOrEqual(0)
      expect(billable!).toBeLessThanOrEqual(f.reportedInput)
      // Для inclusive: billable + cacheRead = reported input (кэш ровно раз в учёте).
      if (f.accounting === 'inclusive') expect(billable! + f.cacheRead).toBe(f.reportedInput)
      // Для exclusive: billable = reported input (кэш вообще НЕ в input, вычитать нельзя).
      if (f.accounting === 'exclusive') expect(billable).toBe(f.reportedInput)
    })
  }
})
