import { describe, expect, it } from 'vitest'
import { buildConflictGraph, scopesMayConflict } from '../../electron/ai/conflict-graph'

describe('Agent Job conflict graph', () => {
  it('два reader не конфликтуют, writer exact/parent/glob конфликтуют', () => {
    expect(scopesMayConflict([], [])).toBe(false)
    expect(scopesMayConflict(['src/a.ts'], ['src/a.ts'])).toBe(true)
    expect(scopesMayConflict(['src'], ['src/a.ts'])).toBe(true)
    expect(scopesMayConflict(['src/**/*.ts'], ['src/a.ts'])).toBe(true)
    expect(scopesMayConflict(['src/**'], ['tests/**'])).toBe(false)
  })

  it('строит симметричный граф', () => {
    const graph = buildConflictGraph([
      { id: 'a', writeScope: ['src/**'] },
      { id: 'b', writeScope: ['src/x.ts'] },
      { id: 'c', writeScope: ['tests/**'] },
    ])
    expect(graph.get('a')).toEqual(['b'])
    expect(graph.get('b')).toEqual(['a'])
    expect(graph.get('c')).toEqual([])
  })
})
