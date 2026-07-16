import { describe, it, expect } from 'vitest'
import { createCostGuard } from '../../electron/ai/cost-guard'

describe('createCostGuard', () => {
  it('null/0 cap = guard выключен, ничего не блокирует', () => {
    const g = createCostGuard(null)
    const check = g.recordAndCheck('claude', 'claude-sonnet-4-6', 10_000_000, 10_000_000, 0)
    expect(check.exceeded).toBe(false)
    expect(check.capCents).toBeNull()
  })

  it('CLI провайдеры всегда $0 (подписка), не считаются', () => {
    const g = createCostGuard(0.01)  // очень маленький cap
    const check = g.recordAndCheck('claude-cli', 'claude-sonnet-4-6', 100_000_000, 100_000_000, 0)
    expect(check.exceeded).toBe(false)
    expect(g.current()).toBe(0)
  })

  it('Sonnet API за 1M input + 1M output = $18 → cap $20 не превышен', () => {
    const g = createCostGuard(20)
    const check = g.recordAndCheck('claude', 'claude-sonnet-4-6', 1_000_000, 1_000_000, 0)
    expect(check.exceeded).toBe(false)
    expect(check.cents).toBe(1800)
  })

  it('Sonnet API превышает cap $5 → exceeded=true', () => {
    const g = createCostGuard(5)
    const check = g.recordAndCheck('claude', 'claude-sonnet-4-6', 1_000_000, 1_000_000, 0)
    expect(check.exceeded).toBe(true)
    expect(check.message).toMatch(/израсходов/)
    expect(check.message).toMatch(/\$5/)
  })

  it('кумулятивный счёт по нескольким вызовам', () => {
    const g = createCostGuard(0.50)  // $0.50 = 50 cents
    // Sonnet: 100K input = 100K/1M * $3 = $0.30 → 30 cents
    g.recordAndCheck('claude', 'claude-sonnet-4-6', 100_000, 0, 0)
    expect(g.current()).toBeCloseTo(30, 0)
    // Ещё 100K input = +30 cents = 60 → превысит $0.50
    const check = g.recordAndCheck('claude', 'claude-sonnet-4-6', 100_000, 0, 0)
    expect(check.exceeded).toBe(true)
  })

  it('неизвестная модель БЕЗ активного cap не считается (прежнее fail-open)', () => {
    const g = createCostGuard(null)  // cap выключен
    const check = g.recordAndCheck('claude', 'mystery-model-xyz', 1_000_000, 1_000_000, 0)
    expect(check.exceeded).toBe(false)
    expect(g.current()).toBe(0)  // не считаем когда cap выключен
  })

  it('fail-safe: неизвестная модель ПОД активным cap считается по консервативному тарифу', () => {
    // Регресс багу: раньше unknown-model молча пропускалась даже под cap →
    // рой субов на незнакомой модели жёг деньги без срабатывания cap.
    const g = createCostGuard(5)
    const check = g.recordAndCheck('claude', 'mystery-model-xyz', 1_000_000, 1_000_000, 0)
    // По fallback-тарифу (sonnet: 3+15 = $18) → cap $5 превышен.
    expect(g.current()).toBeGreaterThan(0)
    expect(check.exceeded).toBe(true)
  })

  it('российские/extra провайдеры теперь имеют цены (YandexGPT/GigaChat/DeepSeek)', () => {
    const g = createCostGuard(20)
    expect(g.recordAndCheck('yandex-gpt', 'yandexgpt/latest', 1_000_000, 0, 0).cents).toBeGreaterThan(0)
    expect(g.recordAndCheck('gigachat', 'GigaChat', 1_000_000, 0, 0).cents).toBeGreaterThan(0)
    expect(g.recordAndCheck('deepseek', 'deepseek-v4-flash', 1_000_000, 0, 0).cents).toBeGreaterThan(0)
  })

  it('openrouter: префикс провайдера нормализуется перед lookup цены', () => {
    const g = createCostGuard(20)
    // 'anthropic/claude-sonnet-4-6' → 'claude-sonnet-4-6' → 1M input = $3 = 300¢
    const check = g.recordAndCheck('openrouter', 'anthropic/claude-sonnet-4-6', 1_000_000, 0, 0)
    expect(check.cents).toBe(300)
  })

  it('ollama (local) — осознанно $0, не fail-safe даже под cap', () => {
    const g = createCostGuard(0.01)
    const check = g.recordAndCheck('ollama', 'llama3.3', 100_000_000, 100_000_000, 0)
    expect(check.exceeded).toBe(false)
    expect(g.current()).toBe(0)
  })

  it('батч дешёвых субов: дробные центы аккумулируются, cap взводится (регресс багу округления)', () => {
    // Раньше Math.round(total*100) на каждом событии округлял дешёвые ходы в 0 →
    // current() не рос → cap никогда не взводился на роях дешёвых моделей.
    const g = createCostGuard(0.20)  // $0.20 cap
    // gemini-3.5-flash, in=3000/out=400 → ~$0.0019 за вызов (< 1¢, округлилось бы в 0)
    let exceededAt = -1
    let prev = 0
    for (let i = 0; i < 200; i++) {
      const check = g.recordAndCheck('gemini-api', 'gemini-3.5-flash', 3000, 400, 0)
      expect(g.current()).toBeGreaterThanOrEqual(prev)  // монотонно растёт
      prev = g.current()
      if (check.exceeded) { exceededAt = i; break }
    }
    expect(exceededAt).toBeGreaterThan(0)  // в какой-то момент cap взвёлся
  })

  it('cached input снижает биллинг', () => {
    const g = createCostGuard(20)
    // 1M cached vs 1M billable input — разница 10× по cost
    const check1 = g.recordAndCheck('claude', 'claude-sonnet-4-6', 1_000_000, 0, 1_000_000)
    // Cached = $0.30 / 1M, billable input - $3 / 1M.
    // input=1M, cached=1M → billableInput = 0, cachedCost = 1M * 0.3/1M = $0.30
    // (inputAccounting не передан → default inclusive = ПРЕЖНЕЕ поведение; характеризация не меняется.)
    expect(check1.cents).toBeCloseTo(30, 0)
  })

  // 2.0.8-E commit 2 — ДЕФЕКТ B (денежный): Claude=EXCLUSIVE, input_tokens УЖЕ без кэша.
  it('дефект B: exclusive (Claude) НЕ вычитает cached — billable = полный input, не 0', () => {
    const g = createCostGuard(null)
    // Тот же вход, что выше (input=1M, cached=1M), но с честным exclusive: billable=1M (НЕ 0).
    // Раньше max(0, 1M−1M)=0 занижало Claude до одной cachedCost; теперь input считается честно.
    const excl = g.recordAndCheck('claude', 'claude-sonnet-4-6', 1_000_000, 0, 1_000_000, 'exclusive')
    // inputCost = 1M×$3/M = 300c + cachedCost = 1M×$0.30/M = 30c → 330c (было бы 30c при вычитании).
    expect(excl.cents).toBeCloseTo(330, 0)
    // Ключ: exclusive СТРОГО дороже, чем прежнее (inclusive) занижение на том же входе.
    const g2 = createCostGuard(null)
    const incl = g2.recordAndCheck('claude', 'claude-sonnet-4-6', 1_000_000, 0, 1_000_000, 'inclusive')
    expect(excl.cents).toBeGreaterThan(incl.cents)
  })

  it('inclusive (OpenAI-семейство) — прежнее вычитание сохранено (характеризация)', () => {
    const g = createCostGuard(null)
    // openai: input=1M включает cached=900K → billable=100K. Поведение как до E.
    const check = g.recordAndCheck('openai', 'gpt-5', 1_000_000, 0, 900_000, 'inclusive')
    expect(check.cents).toBeGreaterThan(0) // считается; точная цифра зависит от прайса openai
  })

  // Каветат #4: usage не сообщён (null) → «нет данных»: не считаем $0 и НЕ блокируем.
  it('null usage (нет данных) → не блокирует и не добавляет стоимость', () => {
    const g = createCostGuard(0.01) // крошечный cap
    const before = g.current()
    const check = g.recordAndCheck('claude', 'claude-sonnet-4-6', null, null, null, 'exclusive')
    expect(check.exceeded).toBe(false)   // не блокирует по «неизвестно»
    expect(g.current()).toBe(before)     // не добавил стоимость (не $0-как-бесплатно, а «нет данных»)
  })
})
