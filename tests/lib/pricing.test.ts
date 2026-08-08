import { describe, it, expect } from 'vitest'
import { estimateCost, costSeverity, costBreakdown } from '../../src/lib/pricing'

describe('estimateCost', () => {
  it('CLI провайдеры — free (usd=null)', () => {
    const c = estimateCost('claude-cli', 'auto', 10000, 5000, 0)
    expect(c.usd).toBeNull()
    expect(c.cents).toBe(0)
  })

  it('Неизвестная модель — usd=—', () => {
    const c = estimateCost('claude', 'unknown-model-xxx', 1000, 1000, 0)
    expect(c.usd).toBe('—')
  })

  it('Sonnet: 1M input + 1M output = $3 + $15 = $18', () => {
    const c = estimateCost('claude', 'claude-sonnet-4-5', 1_000_000, 1_000_000, 0)
    expect(c.cents).toBe(1800)
    expect(c.usd).toBe('$18.00')
  })

  it('Cached input снижает стоимость (для моделей с cached price)', () => {
    // Sonnet: input 3, cached 0.3
    // 1M input, из них 500k cached → billable=500k * 3 + 500k * 0.3 = $1.5 + $0.15 = $1.65
    const c = estimateCost('claude', 'claude-sonnet-4-5', 1_000_000, 0, 500_000)
    expect(c.cents).toBe(165)  // $1.65
  })

  it('Claude cache creation показывается и входит в live estimate', () => {
    const c = estimateCost('claude', 'claude-sonnet-4-6', 0, 0, 0, 'exclusive', 1_000_000)
    expect(c.cents).toBe(375)
    const breakdown = costBreakdown('claude', 'claude-sonnet-4-6', 0, 0, 0, 'exclusive', 1_000_000)
    expect(breakdown).toMatch(/cache write: 1[,.\s]?000[,.\s]?000/)
    expect(breakdown).toMatch(/\$3\.75/)
  })

  it('Маленькая стоимость показывается как <$0.01', () => {
    const c = estimateCost('claude', 'claude-haiku-4-5', 100, 50, 0)
    expect(c.usd).toBe('<$0.01')
  })

  // ЗАДАЧА A (штаб, 06.08): у всех OpenAI-совместимых моделей нет поля cached, и
  // счётчик считал кэш по НУЛЮ → занижение (кэш вычтен из input при inclusive, а
  // cachedCost=0). Правило: неизвестна цена кэша → кэш по ПОЛНОЙ цене input.
  // Занижение опаснее завышения: контроллер порогов ($2/$5) сработал бы ПОЗЖЕ.
  it('DeepSeek (нет цены кэша): кэш по ПОЛНОЙ цене input, НЕ по нулю', () => {
    // input 0.28; 1M input, 500k из них cached, inclusive:
    // billable 500k×0.28=$0.14 + кэш 500k по полной 0.28=$0.14 = $0.28 (до фикса $0.14).
    const c = estimateCost('deepseek', 'deepseek-v4-flash', 1_000_000, 0, 500_000)
    expect(c.cents).toBe(28)
  })

  it('КОНТРОЛЬ: у Claude цена кэша ЕСТЬ (0.3) — кэш считается ИНАЧЕ (дешевле input)', () => {
    // Те же 1M/500k: input $1.5 + кэш 500k×0.3=$0.15 = $1.65. Кэш дешевле своего input —
    // в отличие от DeepSeek. Без контроля пин выше зелен и если бы правило затирало
    // известную цену кэша полной ценой input.
    const c = estimateCost('claude', 'claude-sonnet-4-5', 1_000_000, 0, 500_000)
    expect(c.cents).toBe(165)
  })

  it('поле кэша не пришло (cached=0) — не падаем, кэш-стоимости нет', () => {
    const c = estimateCost('deepseek', 'deepseek-v4-flash', 1_000_000, 0, 0)
    expect(c.cents).toBe(28)  // 1M input × 0.28 = $0.28
  })
})

describe('costSeverity', () => {
  it('< $2 — нет уровня', () => {
    expect(costSeverity(0)).toBe('')
    expect(costSeverity(50)).toBe('')
    expect(costSeverity(199)).toBe('')
  })

  it('$2 - $5 — warn', () => {
    expect(costSeverity(200)).toBe('is-warn')
    expect(costSeverity(300)).toBe('is-warn')
    expect(costSeverity(499)).toBe('is-warn')
  })

  it('$5+ — alert', () => {
    expect(costSeverity(500)).toBe('is-alert')
    expect(costSeverity(1500)).toBe('is-alert')
  })
})

describe('costBreakdown', () => {
  it('Для CLI указывает подписку', () => {
    const b = costBreakdown('claude-cli', 'auto', 1000, 500, 0)
    expect(b).toMatch(/CLI/)
    expect(b).toMatch(/подписка/)
  })

  it('Для неизвестной модели указывает что цен нет', () => {
    const b = costBreakdown('claude', 'mystery', 100, 50, 0)
    expect(b).toMatch(/цены неизвестны/)
  })

  it('Для API содержит формулу с ценами и итог', () => {
    const b = costBreakdown('claude', 'claude-sonnet-4-5', 1_000_000, 1_000_000, 0)
    expect(b).toMatch(/Sonnet/i)
    expect(b).toMatch(/\$3.+input/)
    expect(b).toMatch(/\$15.+output/)
    expect(b).toMatch(/Итого: \$18/)
  })

  it('Cached блок появляется только если cachedTokens > 0', () => {
    const noCached = costBreakdown('claude', 'claude-sonnet-4-5', 1000, 500, 0)
    expect(noCached).not.toMatch(/cached:/)
    const withCached = costBreakdown('claude', 'claude-sonnet-4-5', 1000, 500, 200)
    expect(withCached).toMatch(/cached:/)
  })

  // Половина собственного фикса cachedTokenRate (08.08, шипнуто в 2.4.4): сумма
  // считала кэш по правилу «неизвестна цена → по input», а СТРОКА разбивки
  // показывалась только при price.cached. На дешёвых моделях (нет price.cached)
  // кэш попадал в «Итого» и не попадал в видимые строки — человек видел итог
  // больше суммы того, что показано, без объяснения.
  it('У модели БЕЗ цены кэша строка cached всё равно показана и названа фолбэком', () => {
    const b = costBreakdown('deepseek', 'deepseek-v4-flash', 1_000_000, 0, 500_000)
    expect(b).toMatch(/cached:/)
    expect(b).toMatch(/цена кэша неизвестна/)
  })

  // ГЛАВНЫЙ инвариант, а не текст: видимые строки обязаны сходиться с «Итого».
  it('Сумма видимых строк равна Итого (модель без цены кэша)', () => {
    const b = costBreakdown('deepseek', 'deepseek-v4-flash', 1_000_000, 0, 500_000)
    const shown = [...b.matchAll(/=\s\$([0-9.]+)/g)].map(m => Number(m[1]))
    const total = Number(/Итого: \$([0-9.]+)/.exec(b)?.[1])
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.reduce((a, n) => a + n, 0)).toBeCloseTo(total, 4)
  })

  // КОНТРОЛЬНЫЙ: у модели С известной ценой кэша ставка своя, а не input'овая —
  // иначе фикс выродился бы в «всегда считать кэш по input».
  it('У модели С ценой кэша ставка своя, фолбэк не подставляется', () => {
    const b = costBreakdown('claude', 'claude-sonnet-4-5', 1_000_000, 0, 500_000)
    expect(b).toMatch(/cached:/)
    expect(b).not.toMatch(/цена кэша неизвестна/)
    expect(b).toMatch(/\$0\.3\/M/)
  })
})
