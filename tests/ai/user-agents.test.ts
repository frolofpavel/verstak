import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadUserAgents, findUserAgent } from '../../electron/ai/user-agents'
import { prepareSystemContext } from '../../electron/ai/compose-system'
import { SUBAGENT_FORBIDDEN_TOOLS } from '../../electron/ai/role-tools'

describe('user-agents — loader', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-agents-'))
    mkdirSync(join(dir, '.verstak', 'agents'), { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('парсит frontmatter: name/description/tools/model/provider + тело', () => {
    writeFileSync(join(dir, '.verstak', 'agents', 'ui-reviewer.md'),
      `---\nname: ui-reviewer\ndescription: Ревью UI\ntools: read_file, search_project, find_references\nmodel: claude-sonnet-4-6\nprovider: claude\n---\nТы ревьюишь React-компоненты на доступность.`)
    const agents = loadUserAgents(dir)
    const a = agents.find(x => x.name === 'ui-reviewer')!
    expect(a).toBeTruthy()
    expect(a.scope).toBe('project')
    expect(a.description).toBe('Ревью UI')
    expect(a.tools).toEqual(['read_file', 'search_project', 'find_references'])
    expect(a.model).toBe('claude-sonnet-4-6')
    expect(a.provider).toBe('claude')
    expect(a.systemPrompt).toContain('React-компоненты')
  })

  it('tools пустой при отсутствии поля', () => {
    writeFileSync(join(dir, '.verstak', 'agents', 'plain.md'), `---\nname: plain\n---\nтело`)
    const a = findUserAgent(dir, 'plain')!
    expect(a.tools).toEqual([])
  })

  it('имя по умолчанию = filename без .md', () => {
    writeFileSync(join(dir, '.verstak', 'agents', 'noname.md'), `тело без frontmatter`)
    expect(findUserAgent(dir, 'noname')).toBeTruthy()
  })

  it('findUserAgent возвращает null для несуществующего', () => {
    expect(findUserAgent(dir, 'ghost')).toBeNull()
    expect(findUserAgent(dir, '')).toBeNull()
  })

  it('игнорирует не-.md файлы', () => {
    writeFileSync(join(dir, '.verstak', 'agents', 'readme.txt'), `not a skill`)
    expect(loadUserAgents(dir).filter(a => a.scope === 'project')).toHaveLength(0)
  })

  it('ре-ревью MEDIUM: forbidden-tools (orchestrate/swarm) отсеиваются из набора file-субагента', () => {
    // Тот же фильтр, что применён в delegation.ts при непустом userAgent.tools —
    // инвариант «суб не оркеструет» должен держаться и для файлового набора.
    const declared = ['orchestrate', 'swarm', 'read_file', 'run_command']
    const allowed = declared.filter(t => !SUBAGENT_FORBIDDEN_TOOLS.has(t))
    expect(allowed).not.toContain('orchestrate')
    expect(allowed).not.toContain('swarm')
    expect(allowed).toContain('read_file')
  })

  it('объявленные субагенты инжектятся в системный промпт (фича достижима)', async () => {
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"vitest"}}')
    writeFileSync(join(dir, '.verstak', 'agents', 'ui-reviewer.md'),
      `---\nname: ui-reviewer\ndescription: Ревью UI на доступность\n---\nТы ревьюишь UI.`)
    const composed = await prepareSystemContext({
      projectPath: dir,
      messages: [{ role: 'user', content: 'q' }],
      recentWrites: []
    })
    expect(composed.system).toContain('user_subagents')
    expect(composed.system).toContain('ui-reviewer')
    expect(composed.system).toContain('Ревью UI на доступность')
  })
})
