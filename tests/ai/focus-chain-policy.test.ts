import { describe, expect, it } from 'vitest'
import {
  FOCUS_REINJECT_EVERY,
  shouldReinjectFocus,
} from '../../electron/ai/focus-chain-policy'
import { DEFAULT_AGENT_TURNS } from '../../electron/ai/runner-shared'

// V2-1 (agent-runtime-v2.md §4): Focus Chain построен, но на ДЕФОЛТНОМ чат-пути
// не срабатывал ни разу. Прежнее условие — `turn > 0 && turn % 8 === 0` при
// DEFAULT_AGENT_TURNS, тогда равном 8: цикл шёл turn ∈ 0..7, и модуль 8 внутри
// бюджета недостижим по построению. Не «редко», а НИКОГДА. Плюс реинжект не
// возвращался после компакции — а состояние теряется там в первую очередь.
//
// 10.08 (V2-2): дефолт поднят, и утверждения ниже намеренно НЕ переписаны — они
// и раньше сравнивали с константой, а не с числом. Правлены только заголовок и
// шапка, называвшие 8 фактом: правда о них кончилась вместе со старым дефолтом.
// Решение по постановке: реинжект по ПРИЗНАКУ (есть незакрытые пункты и прошло
// N ходов с ПРОШЛОГО реинжекта, N заведомо меньше бюджета) + после компакции.

describe('shouldReinjectFocus — V2-1', () => {
  it('cadence заведомо меньше дефолтного бюджета (иначе правило снова мертво)', () => {
    expect(FOCUS_REINJECT_EVERY).toBeLessThan(DEFAULT_AGENT_TURNS)
  })

  it('РЕПРО МЁРТВОСТИ: внутри дефолтного бюджета реинжект случается хотя бы раз', () => {
    let lastReinjectTurn = 0
    const fired: number[] = []
    for (let turn = 0; turn < DEFAULT_AGENT_TURNS; turn++) {
      if (shouldReinjectFocus({ turn, lastReinjectTurn, hasOpenItems: true, compactedSinceReinject: false })) {
        fired.push(turn)
        lastReinjectTurn = turn
      }
    }
    expect(fired.length).toBeGreaterThan(0)
  })

  it('КОНТРОЛЬ: без незакрытых пунктов не реинжектим никогда', () => {
    const fired: number[] = []
    for (let turn = 0; turn < 40; turn++) {
      if (shouldReinjectFocus({ turn, lastReinjectTurn: 0, hasOpenItems: false, compactedSinceReinject: true })) {
        fired.push(turn)
      }
    }
    expect(fired).toEqual([])
  })

  it('считает ходы от ПРОШЛОГО реинжекта, а не от начала прогона (модуль совпавшей константы)', () => {
    // Реинжект был на ходу 5 — следующий обязан ждать cadence ходов ОТ НЕГО.
    expect(
      shouldReinjectFocus({ turn: 5 + FOCUS_REINJECT_EVERY - 1, lastReinjectTurn: 5, hasOpenItems: true, compactedSinceReinject: false }),
    ).toBe(false)
    expect(
      shouldReinjectFocus({ turn: 5 + FOCUS_REINJECT_EVERY, lastReinjectTurn: 5, hasOpenItems: true, compactedSinceReinject: false }),
    ).toBe(true)
  })

  it('после компакции реинжект сразу, не дожидаясь cadence (там состояние теряется первым)', () => {
    expect(
      shouldReinjectFocus({ turn: 6, lastReinjectTurn: 5, hasOpenItems: true, compactedSinceReinject: true }),
    ).toBe(true)
  })

  it('КОНТРОЛЬ: компакция без незакрытых пунктов реинжект не вызывает', () => {
    expect(
      shouldReinjectFocus({ turn: 6, lastReinjectTurn: 5, hasOpenItems: false, compactedSinceReinject: true }),
    ).toBe(false)
  })

  it('нулевой ход не реинжектит: цель только что дана человеком', () => {
    expect(
      shouldReinjectFocus({ turn: 0, lastReinjectTurn: 0, hasOpenItems: true, compactedSinceReinject: false }),
    ).toBe(false)
  })

  it('на длинном прогоне (40 ходов) реинжекты идут регулярно, а не один раз', () => {
    let lastReinjectTurn = 0
    let count = 0
    for (let turn = 0; turn < 40; turn++) {
      if (shouldReinjectFocus({ turn, lastReinjectTurn, hasOpenItems: true, compactedSinceReinject: false })) {
        count++
        lastReinjectTurn = turn
      }
    }
    expect(count).toBeGreaterThanOrEqual(Math.floor(40 / FOCUS_REINJECT_EVERY) - 1)
  })
})
