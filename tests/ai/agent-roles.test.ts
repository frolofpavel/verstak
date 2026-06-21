import { describe, it, expect } from 'vitest'
import { AGENT_ROLES, getRolePrompt } from '../../electron/ai/agent-roles'
import { getRoleToolset } from '../../electron/ai/role-tools'

// AI-штаб (Shadow Team, Phase 2) — продуктизация ШТУРМ-паттерна: бизнес-роли
// для решений в delegate_parallel + компилятор-синтезатор (Decision Record).
const SHADOW_TEAM = ['strategist', 'skeptic', 'finance', 'techlead', 'risk', 'sales', 'compiler']
const WRITE_TOOLS = ['write_file', 'apply_patch', 'propose_edits', 'edit_spreadsheet']

describe('AI-штаб (Shadow Team) — бизнес-роли Phase 2', () => {
  it('все 7 бизнес-ролей определены (id/name/systemPrompt)', () => {
    for (const id of SHADOW_TEAM) {
      const role = AGENT_ROLES[id]
      expect(role, id).toBeDefined()
      expect(role.id).toBe(id)
      expect(role.name.length).toBeGreaterThan(0)
      expect(role.systemPrompt.length).toBeGreaterThan(30)
    }
  })

  it('getRolePrompt возвращает промпт каждой бизнес-роли', () => {
    for (const id of SHADOW_TEAM) {
      expect(getRolePrompt(id)).toBe(AGENT_ROLES[id].systemPrompt)
    }
  })

  it('Компилятор задаёт формат Decision Record (решение/почему/риски/пересмотр)', () => {
    const p = getRolePrompt('compiler') ?? ''
    expect(p).toMatch(/РЕШЕНИЕ/)
    expect(p).toMatch(/ПОЧЕМУ/)
    expect(p).toMatch(/РИСК/i)
    expect(p).toMatch(/ПЕРЕСМОТР/)
  })

  it('SECURITY: бизнес-роли советуют — read-only, без write/команд/делегирования', () => {
    for (const id of SHADOW_TEAM) {
      const toolset = getRoleToolset(id)
      expect(toolset).toContain('read_file') // читают проект для обоснования мнения
      for (const w of WRITE_TOOLS) expect(toolset, `${id} даёт ${w}`).not.toContain(w)
      expect(toolset, `${id} даёт run_command`).not.toContain('run_command')
      // советующие роли не порождают поддерево агентов
      expect(toolset, `${id} даёт delegate_task`).not.toContain('delegate_task')
      expect(toolset, `${id} даёт delegate_parallel`).not.toContain('delegate_parallel')
    }
  })

  it('технические роли не потеряны при добавлении штаба', () => {
    for (const id of ['planner', 'critic', 'executor', 'verifier', 'researcher']) {
      expect(AGENT_ROLES[id], id).toBeDefined()
    }
  })

  it('Fusion: роль judge определена и read-only (оценивает, не правит)', () => {
    expect(AGENT_ROLES.judge).toBeDefined()
    expect(getRolePrompt('judge')).toMatch(/судья/i)
    const toolset = getRoleToolset('judge')
    expect(toolset).toContain('read_file')
    for (const w of WRITE_TOOLS) expect(toolset, `judge даёт ${w}`).not.toContain(w)
    expect(toolset).not.toContain('run_command')
    expect(toolset).not.toContain('delegate_task')
  })
})
