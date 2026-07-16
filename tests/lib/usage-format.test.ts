import { describe, it, expect } from 'vitest'
import { costLabel, cacheLabel, runCostLabel, formatCost, cacheDiagnosticLabel } from '../../src/lib/usage-format'

/**
 * Срез 2.0.8-F, каветат #2: «неизвестно» НЕЛЬЗЯ показывать как ноль, а известный ноль —
 * как неизвестность. Эти ярлыки — единственное место, где пользователь читает деньги/кэш,
 * поэтому честность трёх состояний закреплена тестом.
 */
describe('usage-format — три честных состояния (2.0.8-F)', () => {
  describe('costLabel (группа)', () => {
    it('ВСЕ прогоны без цены → «цена неизвестна», НЕ $0', () => {
      expect(costLabel({ costAmount: 0, unknownCostRuns: 3, runs: 3 })).toBe('цена неизвестна')
    })

    it('цена ИЗВЕСТНА и равна нулю (CLI/локальные) → «бесплатно» (другое состояние)', () => {
      expect(costLabel({ costAmount: 0, unknownCostRuns: 0, runs: 5 })).toBe('бесплатно')
    })

    it('цена известна и положительна → сумма', () => {
      expect(costLabel({ costAmount: 1.234, unknownCostRuns: 0, runs: 2 })).toBe('$1.23')
    })

    it('частично неизвестно → известная сумма + честная пометка про остальные', () => {
      expect(costLabel({ costAmount: 2.5, unknownCostRuns: 2, runs: 5 })).toBe('$2.50 + 2 без цены')
    })

    // Регрессия: «бесплатно» и «цена неизвестна» — РАЗНЫЕ состояния, их нельзя схлопывать.
    it('«бесплатно» ≠ «цена неизвестна» при одинаковом costAmount=0', () => {
      const free = costLabel({ costAmount: 0, unknownCostRuns: 0, runs: 1 })
      const unknown = costLabel({ costAmount: 0, unknownCostRuns: 1, runs: 1 })
      expect(free).not.toBe(unknown)
    })
  })

  describe('runCostLabel (один прогон)', () => {
    it('pricing_known=0 → «цена неизвестна»', () => {
      expect(runCostLabel({ pricingKnown: 0, costAmount: null })).toBe('цена неизвестна')
    })
    it('pricing_known=1 + cost=0 → «бесплатно»', () => {
      expect(runCostLabel({ pricingKnown: 1, costAmount: 0 })).toBe('бесплатно')
    })
    it('pricing_known=1 + cost>0 → сумма', () => {
      expect(runCostLabel({ pricingKnown: 1, costAmount: 0.5 })).toBe('$0.50')
    })
    // Защита от «известной цены с null-суммой» (рассогласование БД) → не врём нулём.
    it('pricing_known=1, но costAmount=null → «цена неизвестна» (не $0)', () => {
      expect(runCostLabel({ pricingKnown: 1, costAmount: null })).toBe('цена неизвестна')
    })
  })

  describe('cacheLabel', () => {
    it('знаменатель неизвестен (null) → «нет данных», НЕ «0%»', () => {
      expect(cacheLabel(null)).toBe('нет данных')
    })
    it('знаменатель известен, доля 0 → «нет кэша» (реальный ноль)', () => {
      expect(cacheLabel(0)).toBe('нет кэша')
    })
    it('доля > 0 → проценты', () => {
      expect(cacheLabel(0.3)).toBe('30%')
      expect(cacheLabel(1)).toBe('100%')
    })
    it('«нет данных» ≠ «нет кэша» — разные состояния', () => {
      expect(cacheLabel(null)).not.toBe(cacheLabel(0))
    })
  })

  describe('cacheDiagnosticLabel', () => {
    // Павел — маркетолог: машинный код в UI недопустим.
    it('машинные коды переводятся на человеческий русский', () => {
      expect(cacheDiagnosticLabel('first-request')).toBe('первый прогон в этом чате')
      expect(cacheDiagnosticLabel('tools-drift')).toBe('изменился набор инструментов')
      expect(cacheDiagnosticLabel('unknown')).toBe('причина неизвестна')
    })

    // Ревью P0: системный промпт пересобирается каждый send и включает АВТО-КОНТЕКСТ
    // (git status, недавние правки, карта проекта). Говорить «изменились правила проекта» —
    // ложь: правила (CLAUDE.md) не менялись, менялся авто-контекст.
    it('system-prompt-changed НЕ приписывает изменение «правилам проекта»', () => {
      const label = cacheDiagnosticLabel('system-prompt-changed')!
      expect(label).toBe('изменился системный промпт (правила + авто-контекст)')
      expect(label).not.toBe('изменились правила проекта')
      expect(label).toContain('авто-контекст') // честно называет вторую составляющую
    })
    it('ни один известный код не утекает в UI сырым', () => {
      const codes = ['first-request', 'system-prompt-changed', 'tools-drift', 'model-changed', 'ttl-expired', 'provider-reported-miss', 'unknown']
      for (const c of codes) expect(cacheDiagnosticLabel(c)).not.toBe(c)
    })
    it('null → null (нечего показывать)', () => {
      expect(cacheDiagnosticLabel(null)).toBeNull()
    })
    // Новый код из будущего среза лучше показать сырым, чем выдумать ему смысл.
    it('неизвестный код показывается как есть, а не подменяется', () => {
      expect(cacheDiagnosticLabel('какой-то-новый-код')).toBe('какой-то-новый-код')
    })
  })

  describe('formatCost', () => {
    // Мелкие суммы не должны схлопываться в «$0.00» — это выглядело бы как «бесплатно».
    it('мелкая сумма показывается 4 знаками, а не $0.00', () => {
      expect(formatCost(0.0013)).toBe('$0.0013')
      expect(formatCost(0.0013)).not.toBe('$0.00')
    })
    it('обычная сумма — 2 знака', () => {
      expect(formatCost(12.345)).toBe('$12.35')
    })
  })
})
