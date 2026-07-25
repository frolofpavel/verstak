import { describe, expect, it } from 'vitest'
import { normalizeSkillUserTags } from '../../src/lib/skill-user-tags'

describe('skill user tags', () => {
  it('нормализует и дедуплицирует без учёта регистра', () => {
    expect(normalizeSkillUserTags(' РСЯ, рся,\n аудит   за неделю, ')).toEqual([
      'РСЯ',
      'аудит за неделю',
    ])
  })

  it('ограничивает локальный индекс 24 тегами', () => {
    expect(normalizeSkillUserTags(Array.from({ length: 30 }, (_, i) => `tag ${i}`))).toHaveLength(24)
  })
})
