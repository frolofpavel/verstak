import { describe, it, expect } from 'vitest'
import { findConsolidationNudge, buildConsolidationHint, CONSOLIDATE_THRESHOLD } from '../../electron/ai/memory-consolidate'

const m = (tags: string[]) => ({ tags })

describe('findConsolidationNudge', () => {
  it('тег с числом ≥ порога → nudge с этим тегом и счётчиком', () => {
    const mems = Array.from({ length: CONSOLIDATE_THRESHOLD }, () => m(['session-summary']))
    const n = findConsolidationNudge(mems)
    expect(n).toEqual({ tag: 'session-summary', count: CONSOLIDATE_THRESHOLD })
  })

  it('ниже порога → null (не шумим)', () => {
    const mems = Array.from({ length: CONSOLIDATE_THRESHOLD - 1 }, () => m(['session-summary']))
    expect(findConsolidationNudge(mems)).toBeNull()
  })

  it('выбирает САМЫЙ перегруженный тег', () => {
    const mems = [
      ...Array.from({ length: 6 }, () => m(['a'])),
      ...Array.from({ length: 9 }, () => m(['b'])),
    ]
    expect(findConsolidationNudge(mems)?.tag).toBe('b')
    expect(findConsolidationNudge(mems)?.count).toBe(9)
  })

  it('пустые теги игнорируются', () => {
    const mems = Array.from({ length: 10 }, () => m(['', '  ']))
    expect(findConsolidationNudge(mems)).toBeNull()
  })

  it('пустой список → null', () => {
    expect(findConsolidationNudge([])).toBeNull()
  })
})

describe('buildConsolidationHint', () => {
  it('содержит тег, счётчик, core_memory_append и оговорку «только если уместно»', () => {
    const h = buildConsolidationHint({ tag: 'session-summary', count: 8 })
    expect(h).toContain('session-summary')
    expect(h).toContain('8')
    expect(h).toContain('core_memory_append')
    expect(h).toMatch(/уместн/i)
  })
})
