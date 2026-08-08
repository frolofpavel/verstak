import { describe, it, expect } from 'vitest'
import { spawnCardStatusLabel } from '../../src/store/session-snapshot'

// Задача 08.08 C(б): карточка-след знает НАБЛЮДАЕМОЕ (прогон завершён), а не выполнена ли
// задача — критерия успеха у неё нет. Ребёнок мог закончить 'done', но артефакта не сделать,
// поэтому 'done' НЕ должен намекать на успех («готово»).
describe('spawnCardStatusLabel — карточка не намекает на успех', () => {
  it('done → «прогон завершён», НЕ «готово» (нет намёка на успех)', () => {
    expect(spawnCardStatusLabel('done')).toBe('прогон завершён')
    expect(spawnCardStatusLabel('done')).not.toMatch(/готов/i)
  })
  it('running → «выполняется»', () => {
    expect(spawnCardStatusLabel('running')).toBe('выполняется')
  })
  it('error → «ошибка»; terminated → «прогон оборвался»', () => {
    expect(spawnCardStatusLabel('error')).toBe('ошибка')
    expect(spawnCardStatusLabel('terminated')).toBe('прогон оборвался')
  })
})
