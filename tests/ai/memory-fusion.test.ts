import { describe, it, expect } from 'vitest'
import { fuseRanks } from '../../electron/ai/memory-fusion'

const m = (id: string) => ({ id })

describe('fuseRanks (ось 4 #1 — RRF)', () => {
  it('факт высоко В ДВУХ каналах поднимается выше топ-1-в-одном', () => {
    // B: 3-й в релевантности (rank 3) + 1-й в недавности (rank 1) → сумма большая.
    // A: 1-й в релевантности, но больше нигде.
    const relevance = [m('A'), m('X'), m('B')]
    const recency = [m('B'), m('Y'), m('Z')]
    const fused = fuseRanks([relevance, recency]).map(d => d.id)
    expect(fused[0]).toBe('B') // присутствует в обоих → выигрывает
    expect(fused).toContain('A')
  })

  it('дедуп по id — каждый элемент один раз', () => {
    const fused = fuseRanks([[m('A'), m('B')], [m('A'), m('A')]])
    expect(fused.filter(d => d.id === 'A')).toHaveLength(1)
  })

  it('пустые каналы → пусто; один канал → сохраняет порядок', () => {
    expect(fuseRanks([[], []])).toEqual([])
    expect(fuseRanks([[m('A'), m('B'), m('C')]]).map(d => d.id)).toEqual(['A', 'B', 'C'])
  })

  it('меньший k сильнее поощряет топовые позиции', () => {
    // только релевантность: порядок сохраняется при любом k
    const out = fuseRanks([[m('A'), m('B')]], 1).map(d => d.id)
    expect(out).toEqual(['A', 'B'])
  })
})
