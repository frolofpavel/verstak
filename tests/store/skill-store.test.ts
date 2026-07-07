import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Skill } from '../../src/types/api'

const setKey = vi.fn(async () => {})
const recordUse = vi.fn(async () => null)
const windowStub = { api: { settings: { setKey }, skills: { recordUse } } }
vi.stubGlobal('window', windowStub)

import { useSkills } from '../../src/store/skillStore'

function skill(partial: Partial<Skill>): Skill {
  return { id: 'x', name: 'X', source: 'built-in', systemPrompt: '', ...partial } as unknown as Skill
}

describe('skillStore setActiveSkill', () => {
  beforeEach(() => {
    vi.stubGlobal('window', windowStub)
    setKey.mockClear()
    recordUse.mockClear()
    useSkills.setState({ activeSkillId: null, skills: [] }, false)
  })

  it('скилл с default_mode не пишет глобальный agent_mode', () => {
    useSkills.setState({ skills: [skill({ id: 'receivables', default_mode: 'plan' })] }, false)
    useSkills.getState().setActiveSkill('receivables')
    expect(useSkills.getState().activeSkillId).toBe('receivables')
    expect(setKey).not.toHaveBeenCalled()
    expect(recordUse).toHaveBeenCalledWith('receivables')
  })

  it('скилл без default_mode → режим не трогается', () => {
    useSkills.setState({ skills: [skill({ id: 'plain' })] }, false)
    useSkills.getState().setActiveSkill('plain')
    expect(setKey).not.toHaveBeenCalled()
    expect(recordUse).toHaveBeenCalledWith('plain')
  })

  it('снятие скилла (null) → режим не трогается', () => {
    useSkills.getState().setActiveSkill(null)
    expect(setKey).not.toHaveBeenCalled()
    expect(recordUse).not.toHaveBeenCalled()
  })
})
