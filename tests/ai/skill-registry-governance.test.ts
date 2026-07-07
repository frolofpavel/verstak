import { describe, it, expect } from 'vitest'
import { createSkillRegistry } from '../../electron/ai/skills/registry'

describe('skill registry governance filters', () => {
  it('hides archived skills from list/get without deleting built-ins', async () => {
    const archived = new Set(['code-review'])
    const registry = createSkillRegistry(() => ({}), {
      isArchived: id => archived.has(id)
    })
    await registry.refresh()

    expect(registry.get('code-review')).toBeNull()
    expect(registry.list().some(s => s.id === 'code-review')).toBe(false)
    expect(registry.list().some(s => s.id === 'git-summary')).toBe(true)

    archived.delete('code-review')
    expect(registry.get('code-review')?.id).toBe('code-review')
  })
})
