import { describe, it, expect } from 'vitest'
import { deriveSkillId, buildCapturedSkill } from '../../electron/ai/skills/capture'
import { parseSkillDoc } from '../../electron/ai/skills/frontmatter'

describe('skill-capture', () => {
  it('deriveSkillId: ascii-slug из заголовка', () => {
    expect(deriveSkillId('Fix Auth Bug')).toBe('fix-auth-bug')
    expect(deriveSkillId('  Deploy   Pipeline!! ')).toBe('deploy-pipeline')
  })

  it('deriveSkillId: чисто кириллица → fallback', () => {
    expect(deriveSkillId('Ночной отчёт')).toBe('captured-skill')
    expect(deriveSkillId('')).toBe('captured-skill')
  })

  it('buildCapturedSkill: валидный frontmatter + тело, парсится обратно', () => {
    const { id, filename, markdown } = buildCapturedSkill({
      title: 'Marketing audit run',
      summary: 'Прошёл по кабинетам, собрал отчёт',
      toolsAllow: ['connector_query', 'generate_html'],
      capturedAt: '2026-06-19',
    })
    expect(id).toBe('marketing-audit-run')
    expect(filename).toBe('marketing-audit-run.md')
    // Парсится штатным загрузчиком скиллов.
    const doc = parseSkillDoc(markdown)
    expect(doc.frontmatter.id).toBe('marketing-audit-run')
    expect(doc.frontmatter.name).toBe('Marketing audit run')
    expect(doc.frontmatter.tools_allow).toEqual(['connector_query', 'generate_html'])
    expect(doc.body).toContain('Подход')
    expect(doc.body).toContain('собрал отчёт')
  })

  it('buildCapturedSkill: без summary/tools — корректный скаффолд', () => {
    const { markdown } = buildCapturedSkill({ title: 'Quick task', capturedAt: '2026-06-19' })
    const doc = parseSkillDoc(markdown)
    expect(doc.frontmatter.description).toContain('Quick task')
    expect(doc.frontmatter.tools_allow).toBeUndefined()
    expect(doc.body).toContain('поправь перед использованием')
  })

  it('buildCapturedSkill: явный id уважается (дедуп из IPC)', () => {
    const { id, filename } = buildCapturedSkill({ title: 'X', capturedAt: '2026-06-19', id: 'x-2' })
    expect(id).toBe('x-2')
    expect(filename).toBe('x-2.md')
  })
})
