import { describe, it, expect } from 'vitest'
import { resolveTurnsBudget, SPAWN_TASK_TURNS, DEFAULT_AGENT_TURNS, MAX_BUDGET_TURNS } from '../../electron/ai/runner-shared'

// Задача C(а), 08.08: самостоятельная (спавн) сессия получала дефолт обычного хода (8) и
// упиралась в него до артефакта. Теперь при отсутствии явного budget дочерняя сессия
// получает больший SPAWN_TASK_TURNS; обычная — прежний DEFAULT.
describe('resolveTurnsBudget — бюджет ходов', () => {
  it('обычная сессия без явного budget → DEFAULT', () => {
    expect(resolveTurnsBudget(undefined, false)).toBe(DEFAULT_AGENT_TURNS)
  })
  it('дочерняя (спавн) сессия без явного budget → SPAWN_TASK_TURNS, больше дефолта', () => {
    expect(resolveTurnsBudget(undefined, true)).toBe(SPAWN_TASK_TURNS)
    expect(SPAWN_TASK_TURNS).toBeGreaterThan(DEFAULT_AGENT_TURNS)
  })
  it('явный budget побеждает дефолт (и у обычной, и у дочерней)', () => {
    expect(resolveTurnsBudget(30, false)).toBe(30)
    expect(resolveTurnsBudget(30, true)).toBe(30)
  })
  it('потолок MAX_BUDGET_TURNS соблюдается', () => {
    expect(resolveTurnsBudget(1000, true)).toBe(MAX_BUDGET_TURNS)
  })
})
