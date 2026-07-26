import { describe, it, expect } from 'vitest'
import { SUGGEST_THRESHOLD } from '../../src/lib/skill-suggest'
import type { Skill } from '../../src/types/api'

const mk = (over: Partial<Skill>): Skill => ({
  id: over.id ?? 'x',
  systemPrompt: '',
  source: 'user',
  sourceRef: '',
  ...over,
})


describe('suggestSkill', () => {















  it('порог экспортируется и равен 3', () => {
    expect(SUGGEST_THRESHOLD).toBe(3)
  })

})
