import { describe, it, expect } from 'vitest'
import { offersSpawnTaskSession } from '../../electron/ai/runner-api'

// Задача C (08.08): у spawn_task_session НЕ было гарда глубины — дочерняя сессия получала
// инструмент как родитель и могла спавнить внучек без предела (дерево видимых чатов, деньги).
// Держал случайно лишь малый бюджет ребёнка (8), поэтому поднимать бюджет без гарда нельзя.
// Глубина ровно один уровень: корень выносит задачу, вынесенная — нет.
describe('offersSpawnTaskSession — гард глубины спавна', () => {
  it('РОДИТЕЛЬ (не дочерняя) + оркестратор вкл → инструмент ЕСТЬ', () => {
    expect(offersSpawnTaskSession(true, false)).toBe(true)
  })
  it('РЕБЁНОК (дочерняя сессия) + оркестратор вкл → инструмента НЕТ (гард глубины)', () => {
    expect(offersSpawnTaskSession(true, true)).toBe(false)
  })
  it('оркестратор ВЫКЛ → нет у родителя (прежнее поведение)', () => {
    expect(offersSpawnTaskSession(false, false)).toBe(false)
  })
  it('оркестратор ВЫКЛ → нет и у ребёнка', () => {
    expect(offersSpawnTaskSession(false, true)).toBe(false)
  })
})
