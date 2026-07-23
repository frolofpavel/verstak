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
})
