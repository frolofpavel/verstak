// Губернатор доверия. Два свойства, ради которых он существует:
//   1) уровень считается по ФАКТАМ работы, а не по числу запусков;
//   2) слой умеет только УЖЕСТОЧАТЬ решение — ослабить не может ни при каких
//      входах. Второе проверяется перебором всех комбинаций, а не примерами:
//      дыра в таком слое не краснеет, она просто тихо расширяет права.
import { describe, it, expect } from 'vitest'
import {
  computeTrust,
  tightenByTrust,
  emptyEvidence,
  type TrustEvidence,
} from '../../shared/contracts/trust'
import { TRUST_LEVELS, TRUST_FLOOR, compareTrust } from '../../shared/contracts/capability'
import type { ToolDecision } from '../../electron/ai/mode-policy'

const ev = (over: Partial<TrustEvidence> = {}): TrustEvidence => ({ ...emptyEvidence(), ...over })

/** Строгость решения. Больше — строже. Порядок и есть предмет проверки. */
const STRICTNESS: Record<ToolDecision, number> = { 'auto-accept': 0, confirm: 1, block: 2 }
const DECISIONS: ToolDecision[] = ['auto-accept', 'confirm', 'block']

describe('уровень считается по фактам, а не по числу запусков', () => {
  it('без истории — доверие по умолчанию, и это НЕ права записи', () => {
    const { level, reason } = computeTrust(emptyEvidence())
    expect(level).toBe('T1')
    expect(reason).toContain('нет')
  })

  // Прямое требование постановки: доверие не должно расти от количества.
  it('сто успешных прогонов без проверок не поднимают доверие', () => {
    const { level } = computeTrust(ev({ successfulRuns: 100, completedTasks: 100 }))
    expect(compareTrust(level, 'T2')).toBeLessThan(0)
  })

  it('доверие растёт от пройденных проверок и принятых человеком результатов', () => {
    const weak = computeTrust(ev({ successfulRuns: 20, completedTasks: 20 })).level
    const strong = computeTrust(ev({
      successfulRuns: 20,
      completedTasks: 20,
      verificationsPassed: 18,
      verificationsTotal: 20,
      humanAccepted: 12,
      humanRejected: 1,
    })).level
    expect(compareTrust(strong, weak)).toBeGreaterThan(0)
  })

  it('отказы человека тянут уровень вниз', () => {
    const good = computeTrust(ev({ verificationsPassed: 18, verificationsTotal: 20, humanAccepted: 12, humanRejected: 1, successfulRuns: 20, completedTasks: 20 })).level
    const bad = computeTrust(ev({ verificationsPassed: 18, verificationsTotal: 20, humanAccepted: 2, humanRejected: 15, successfulRuns: 20, completedTasks: 20 })).level
    expect(compareTrust(bad, good)).toBeLessThan(0)
  })
})

describe('нарушение безопасности обрушивает автономность', () => {
  // Требование постановки: ЛЮБОЕ нарушение безопасности резко снижает уровень.
  // Не «снижает на шаг» и не «учитывается в среднем» — обрушивает.
  it('одно нарушение безопасности роняет на пол даже безупречную историю', () => {
    const perfect = ev({
      successfulRuns: 500, completedTasks: 500,
      verificationsPassed: 500, verificationsTotal: 500,
      humanAccepted: 400, humanRejected: 0,
    })
    expect(computeTrust(perfect).level).not.toBe(TRUST_FLOOR)
    const { level, reason } = computeTrust({ ...perfect, safetyViolations: 1 })
    expect(level).toBe(TRUST_FLOOR)
    expect(reason).toContain('безопасност')
  })

  it('нарушение политики снижает уровень, но не обязательно до пола', () => {
    const base = ev({ successfulRuns: 50, completedTasks: 50, verificationsPassed: 50, verificationsTotal: 50, humanAccepted: 40, humanRejected: 0 })
    const withViolation = computeTrust({ ...base, policyViolations: 2 }).level
    expect(compareTrust(withViolation, computeTrust(base).level)).toBeLessThan(0)
  })

  it('неожиданное поведение инструмента или сети считается нарушением безопасности', () => {
    expect(computeTrust(ev({ unexpectedToolBehavior: 1 })).level).toBe(TRUST_FLOOR)
  })

  it('перерасход бюджета снижает уровень', () => {
    const base = ev({ successfulRuns: 50, completedTasks: 50, verificationsPassed: 50, verificationsTotal: 50, humanAccepted: 40 })
    expect(compareTrust(computeTrust({ ...base, costOverruns: 3 }).level, computeTrust(base).level)).toBeLessThan(0)
  })

  it('уровень всегда из объявленной шкалы', () => {
    for (const evidence of [emptyEvidence(), ev({ safetyViolations: 9 }), ev({ humanAccepted: 999 })]) {
      expect(TRUST_LEVELS).toContain(computeTrust(evidence).level)
    }
  })
})

describe('слой не умеет ослаблять — перебором, а не примерами', () => {
  it('ни одна комбинация решения и уровня не делает решение мягче', () => {
    for (const decision of DECISIONS) {
      for (const level of TRUST_LEVELS) {
        const after = tightenByTrust(decision, level)
        expect(
          STRICTNESS[after],
          `${decision} при ${level} стало ${after}`
        ).toBeGreaterThanOrEqual(STRICTNESS[decision])
      }
    }
  })

  it('block остаётся block при любом доверии — даже наивысшем', () => {
    for (const level of TRUST_LEVELS) expect(tightenByTrust('block', level)).toBe('block')
  })

  it('на полу доверия автоприём невозможен', () => {
    expect(tightenByTrust('auto-accept', 'T0')).not.toBe('auto-accept')
  })

  // Контроль: без него все пины выше зелены у функции `() => 'block'`, которая
  // «не ослабляет» тем, что запрещает всё.
  it('контроль: при высоком доверии решение проходит нетронутым', () => {
    for (const decision of DECISIONS) {
      expect(tightenByTrust(decision, 'T4')).toBe(decision)
    }
  })
})
