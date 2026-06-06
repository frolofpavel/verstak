import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { composeSystemPrompt } from '../../electron/ai/compose-prompt'
import { prepareSystemContext } from '../../electron/ai/compose-system'

const SKILL = 'Ты — оркестратор los-hq. Жди пакет задачи и маршрутизируй.'

describe('composeSystemPrompt — skill layering (не замена)', () => {
  it('БЕЗ skillPrompt: нет секции skill_layer, поведение прежнее', () => {
    const { system } = composeSystemPrompt({ path: null, content: '' })
    expect(system).toContain('verstak_system_layer')
    expect(system).not.toContain('skill_layer')
  })

  it('С skillPrompt: базовый system-layer СОХРАНЯЕТСЯ + добавлена секция skill_layer', () => {
    const { system } = composeSystemPrompt({ path: null, content: '' }, '', SKILL)
    // Регрессия исходного бага: раньше промпт скилла ЗАМЕНЯЛ базу.
    // Теперь immutable протокол должен оставаться.
    expect(system).toContain('verstak_system_layer')
    expect(system).toContain('EXECUTION PROTOCOL')
    expect(system).toContain('<skill_layer>')
    expect(system).toContain(SKILL)
  })

  it('порядок слоёв: system-layer → user-layer → context-pack → skill-layer', () => {
    const { system } = composeSystemPrompt(
      { path: 'CLAUDE.md', content: 'правило проекта' },
      '<context_pack generated="auto">пакет</context_pack>',
      SKILL
    )
    // Ищем по реальным открывающим тегам наслоённых блоков. indexOf('context_pack')
    // нельзя — этот текст встречается ВНУТРИ immutable system-layer (он
    // документирует слои), поэтому опираемся на конкретные открывающие маркеры.
    const iSystem = system.indexOf('<verstak_system_layer')
    const iUser = system.indexOf('<user_layer source=')
    const iPack = system.indexOf('<context_pack generated=')
    const iSkill = system.indexOf('<skill_layer>')
    expect(iSystem).toBeGreaterThanOrEqual(0)
    expect(iSystem).toBeLessThan(iUser)
    expect(iUser).toBeLessThan(iPack)
    expect(iPack).toBeLessThan(iSkill)
  })

  it('пустой skillPrompt (whitespace) не добавляет секцию', () => {
    const { system } = composeSystemPrompt({ path: null, content: '' }, '', '   ')
    expect(system).not.toContain('skill_layer')
  })
})

describe('prepareSystemContext — skillPrompt прокидывается насквозь', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-skill-'))
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"vitest"}}')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('skillPrompt наслаивается ПОВЕРХ базы, протокол выполнения не теряется', async () => {
    const composed = await prepareSystemContext({
      projectPath: dir,
      messages: [{ role: 'user', content: 'сделай рефакторинг' }],
      recentWrites: [],
      skillPrompt: SKILL
    })
    expect(composed.system).toContain('verstak_system_layer')
    expect(composed.system).toContain('EXECUTION PROTOCOL')
    expect(composed.system).toContain(SKILL)
  })

  it('без skillPrompt секция skill_layer отсутствует', async () => {
    const composed = await prepareSystemContext({
      projectPath: dir,
      messages: [{ role: 'user', content: 'q' }],
      recentWrites: []
    })
    expect(composed.system).not.toContain('skill_layer')
  })
})
