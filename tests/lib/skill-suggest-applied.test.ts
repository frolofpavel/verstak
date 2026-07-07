import { describe, expect, it } from 'vitest'
import { buildSkillIndex, suggestFromIndex, suggestSkill } from '../../src/lib/skill-suggest'
import type { Skill } from '../../src/types/api'

const mk = (over: Partial<Skill>): Skill => ({
  id: over.id ?? 'x',
  systemPrompt: '',
  source: 'user',
  sourceRef: '',
  ...over,
})

describe('skill suggestions for per-message application', () => {
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

  it('does not auto-suggest service skills', () => {
    const guide = mk({
      id: 'verstak-guide',
      name: 'Verstak Guide',
      description: 'Help with the Verstak interface',
      suggested_prompts: ['help interface settings project chat'],
    })
    const nightShift = mk({
      id: 'client-run',
      name: 'Night shift',
      description: 'Nightly client cabinet checks',
      suggested_prompts: ['night shift client report anomalies'],
    })

    expect(suggestSkill('help interface settings project chat', [guide], null)).toBeNull()
    expect(suggestSkill('night shift client report anomalies', [nightShift], null)).toBeNull()
  })
})
