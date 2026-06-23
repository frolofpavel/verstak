import { describe, it, expect } from 'vitest'
import { createFloorTracker, NO_FLOOR } from '../../electron/storage/undo-floors'

// F3 (ревью 23.06): мульти-чат — несколько чекпоинтов в одном проекте.
describe('FloorTracker — мульти-чекпоинт защита (F3)', () => {
  it('нет активных floor → NO_FLOOR', () => {
    const t = createFloorTracker()
    expect(t.effective('p')).toBe(NO_FLOOR)
  })

  it('эффективный floor = минимум активных (защищает регион старейшего чекпоинта)', () => {
    const t = createFloorTracker()
    t.add('p', 30)
    t.add('p', 70)
    // С багом (один floor на проект) второй перетёр бы первый → 70, оголив 31..70.
    expect(t.effective('p')).toBe(30)
  })

  it('снятие одного floor оставляет остальные', () => {
    const t = createFloorTracker()
    t.add('p', 30); t.add('p', 70)
    t.remove('p', 30)
    expect(t.effective('p')).toBe(70)
    t.remove('p', 70)
    expect(t.effective('p')).toBe(NO_FLOOR)
  })

  it('remove без id снимает все floor проекта (undo:clear)', () => {
    const t = createFloorTracker()
    t.add('p', 30); t.add('p', 70)
    t.remove('p')
    expect(t.effective('p')).toBe(NO_FLOOR)
  })

  it('проекты изолированы', () => {
    const t = createFloorTracker()
    t.add('a', 10); t.add('b', 99)
    expect(t.effective('a')).toBe(10)
    expect(t.effective('b')).toBe(99)
  })

  it('дубликат floor (оба чата чекпоинтят на пустом стеке, id=0): remove убирает один', () => {
    const t = createFloorTracker()
    t.add('p', 0); t.add('p', 0)
    t.remove('p', 0)
    expect(t.effective('p')).toBe(0)   // второй ещё активен
  })

  it('remove несуществующего floor — без эффекта', () => {
    const t = createFloorTracker()
    t.add('p', 5)
    t.remove('p', 999)
    expect(t.effective('p')).toBe(5)
  })
})
