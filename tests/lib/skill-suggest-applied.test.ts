import { describe, expect, it } from 'vitest'
import { buildSkillIndex, suggestFromIndex } from '../../src/lib/skill-suggest'
import type { Skill } from '../../src/types/api'

const mk = (over: Partial<Skill>): Skill => ({
  id: over.id ?? 'x',
  systemPrompt: '',
  source: 'user',
  sourceRef: '',
  ...over,
})

describe('skill suggestions for focused task routing', () => {
  it('does not suggest a skill already applied to the draft', () => {
    const review = mk({
      id: 'code-review',
      name: 'Code Review',
      description: 'Review code for bugs and security',
      suggested_prompts: ['review code bugs security'],
    })

    const index = buildSkillIndex([review])

    expect(suggestFromIndex(
      'review code bugs security',
      index,
      null,
      new Set(['code-review'])
    )).toBeNull()
  })



})
