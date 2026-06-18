import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Skill } from '../../src/types/api'

/**
 * B2: скилл с default_mode (например receivables → plan) раньше НЕ переключал
 * режим агента — заявленная скиллом безопасность не активировалась. Теперь
 * setActiveSkill пишет agent_mode в settings (sticky; useAgentMode/ai.ts читают оттуда).
 */
const setKey = vi.fn(async () => {})
const windowStub = { api: { settings: { setKey } } }
vi.stubGlobal('window', windowStub)

import { useSkills } from '../../src/store/skillStore'

function skill(partial: Partial<Skill>): Skill {
  return { id: 'x', name: 'X', source: 'built-in', systemPrompt: '', ...partial } as unknown as Skill
}

describe('skillStore setActiveSkill — применяет default_mode (B2)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', windowStub)
    setKey.mockClear()
    useSkills.setState({ activeSkillId: null, skills: [] }, false)
  })

  it('скилл с default_mode → пишет agent_mode в settings', () => {
    useSkills.setState({ skills: [skill({ id: 'receivables', default_mode: 'plan' })] }, false)
    useSkills.getState().setActiveSkill('receivables')
    expect(setKey).toHaveBeenCalledWith('agent_mode', 'plan')
  })

  it('скилл без default_mode → режим не трогается', () => {
    useSkills.setState({ skills: [skill({ id: 'plain' })] }, false)
    useSkills.getState().setActiveSkill('plain')
    expect(setKey).not.toHaveBeenCalled()
  })

  it('снятие скилла (null) → режим не трогается', () => {
    useSkills.getState().setActiveSkill(null)
    expect(setKey).not.toHaveBeenCalled()
  })
})
