import { describe, expect, it } from 'vitest'
import {
  AUTO_CONTINUE_STEP,
  DEFAULT_AGENT_TURNS,
  MAX_AUTO_CONTINUES,
  MAX_BUDGET_TURNS,
  MIN_AGENT_TURNS,
  SPAWN_TASK_TURNS,
  decideAutoContinue,
  resolveTurnsBudget,
} from '../../electron/ai/runner-shared'
import { STAGNATION_TURNS } from '../../electron/ai/progress'

// V2-2 (agent-runtime-v2.md §4). Дефолт обычного прогона был 8 и опровергнут
// СОБСТВЕННЫМ замером продукта (комментарий runner-shared: 8 ходов, 11 вызовов,
// артефакт не дошёл). Вывод тогда применили только к спавн-сессиям, а обычный
// чат остался на опровергнутом числе. Плюс: продолжение должно быть
// автоматическим, пока есть прогресс, и ручным — только когда прогресса нет.

describe('бюджет ходов по классу работы', () => {
  it('дефолт обычного прогона больше опровергнутых восьми', () => {
    expect(DEFAULT_AGENT_TURNS).toBeGreaterThan(8)
  })

  it('порядок величин сохранён: пол < дефолт < спавн ≤ потолок', () => {
    expect(MIN_AGENT_TURNS).toBeLessThan(DEFAULT_AGENT_TURNS)
    expect(DEFAULT_AGENT_TURNS).toBeLessThan(SPAWN_TASK_TURNS)
    expect(SPAWN_TASK_TURNS).toBeLessThanOrEqual(MAX_BUDGET_TURNS)
  })

  it('ЯВНЫЙ бюджет человека не переписывается поднятым дефолтом', () => {
    // Пока пол и дефолт были одним числом, поднятие дефолта молча превращало
    // «дай 10 ходов» в 16. Это и есть цена отдельной константы MIN_AGENT_TURNS.
    expect(resolveTurnsBudget(10, false)).toBe(10)
    expect(resolveTurnsBudget(12, false)).toBe(12)
  })

  it('пол и потолок остались границами', () => {
    expect(resolveTurnsBudget(1, false)).toBe(MIN_AGENT_TURNS)
    expect(resolveTurnsBudget(1000, false)).toBe(MAX_BUDGET_TURNS)
  })

  it('cadence Focus Chain (V2-1) остаётся заведомо меньше дефолта', () => {
    // Смысл пина V2-1: реинжект обязан случиться внутри дефолтного бюджета хотя бы
    // раз. Поднятие бюджета его не ломает, но проверять это надо здесь тоже —
    // иначе следующая правка бюджета уронит смысл, а не утверждение.
    expect(STAGNATION_TURNS).toBeLessThan(DEFAULT_AGENT_TURNS)
  })
})

describe('decideAutoContinue — продолжаем, пока есть прогресс', () => {
  const base = { budget: DEFAULT_AGENT_TURNS, allowed: true, staleTurns: 0, extensions: 0 }

  it('последний ход дал новый факт → бюджет расширяется сам', () => {
    const decision = decideAutoContinue(base)
    expect(decision.extend).toBe(true)
    expect(decision.reason).toBe('progress')
    expect(decision.nextBudget).toBe(DEFAULT_AGENT_TURNS + AUTO_CONTINUE_STEP)
  })

  it('КОНТРОЛЬ: прогресса нет → не продлеваем, решение остаётся человеку', () => {
    const decision = decideAutoContinue({ ...base, staleTurns: 1 })
    expect(decision.extend).toBe(false)
    expect(decision.reason).toBe('no-progress')
    expect(decision.nextBudget).toBe(base.budget)
  })

  it('КОНТРОЛЬ: без явного разрешения не продлеваем даже при прогрессе', () => {
    // Разрешение выключено по умолчанию: runApiConversation зовут и пайплайны, и
    // делегирование, и спавн-сессии — там бюджет часть условия задачи.
    const decision = decideAutoContinue({ ...base, allowed: false })
    expect(decision.extend).toBe(false)
    expect(decision.reason).toBe('not-allowed')
  })

  it('bounded: продлений подряд не больше MAX_AUTO_CONTINUES', () => {
    expect(decideAutoContinue({ ...base, extensions: MAX_AUTO_CONTINUES - 1 }).extend).toBe(true)
    const stopped = decideAutoContinue({ ...base, extensions: MAX_AUTO_CONTINUES })
    expect(stopped.extend).toBe(false)
    expect(stopped.reason).toBe('bounded')
  })

  it('потолок MAX_BUDGET_TURNS не пробивается', () => {
    const atCeiling = decideAutoContinue({ ...base, budget: MAX_BUDGET_TURNS })
    expect(atCeiling.extend).toBe(false)
    expect(atCeiling.reason).toBe('ceiling')
    const nearCeiling = decideAutoContinue({ ...base, budget: MAX_BUDGET_TURNS - 1 })
    expect(nearCeiling.nextBudget).toBe(MAX_BUDGET_TURNS)
  })

  it('цепочка продлений конечна и приходит к потолку или к человеку', () => {
    let budget = DEFAULT_AGENT_TURNS
    let extensions = 0
    for (let i = 0; i < 50; i++) {
      const decision = decideAutoContinue({ budget, allowed: true, staleTurns: 0, extensions })
      if (!decision.extend) break
      budget = decision.nextBudget
      extensions++
    }
    expect(extensions).toBeLessThanOrEqual(MAX_AUTO_CONTINUES)
    expect(budget).toBeLessThanOrEqual(MAX_BUDGET_TURNS)
  })
})
