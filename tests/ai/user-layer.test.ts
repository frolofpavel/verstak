import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadUserLayer } from '../../electron/ai/user-layer'

describe('loadUserLayer — глобальный + проектный слой (OpenCode instruction hierarchy)', () => {
  let dir: string
  let noGlobal: string // заведомо несуществующий путь глобальных правил (герметичность)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-ul-'))
    noGlobal = join(dir, 'no-such-global.md')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('только проектный слой → отдаётся как есть (обратная совместимость)', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'PROJECT RULES', 'utf8')
    const r = await loadUserLayer(dir, noGlobal)
    expect(r.path).toBe('CLAUDE.md')
    expect(r.content).toBe('PROJECT RULES')
  })

  it('глобальный + проектный → склейка с маркером, глобальный первым', async () => {
    const globalPath = join(dir, 'global.md')
    writeFileSync(globalPath, 'GLOBAL RULES', 'utf8')
    writeFileSync(join(dir, 'AGENTS.md'), 'PROJECT RULES', 'utf8')
    const r = await loadUserLayer(dir, globalPath)
    expect(r.content).toContain('Глобальные правила')
    expect(r.content).toContain('GLOBAL RULES')
    expect(r.content).toContain('PROJECT RULES')
    expect(r.content.indexOf('GLOBAL RULES')).toBeLessThan(r.content.indexOf('PROJECT RULES'))
    expect(r.path).toContain('AGENTS.md')
  })

  it('только глобальный (нет проекта/проектного файла) → глобальный с маркером', async () => {
    const globalPath = join(dir, 'global.md')
    writeFileSync(globalPath, 'GLOBAL ONLY', 'utf8')
    const r = await loadUserLayer(null, globalPath)
    expect(r.content).toContain('GLOBAL ONLY')
    expect(r.path).toBe('~/.verstak/RULES.md')
  })

  it('ничего нет → пусто', async () => {
    const r = await loadUserLayer(dir, noGlobal)
    expect(r).toEqual({ path: null, content: '' })
  })

  it('первый из кандидатов выигрывает (AGENTS.md > CLAUDE.md)', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'A', 'utf8')
    writeFileSync(join(dir, 'CLAUDE.md'), 'C', 'utf8')
    const r = await loadUserLayer(dir, noGlobal)
    expect(r.path).toBe('AGENTS.md')
    expect(r.content).toBe('A')
  })

  it('.verstak/RULES.md как проектный кандидат подхватывается', async () => {
    mkdirSync(join(dir, '.verstak'), { recursive: true })
    writeFileSync(join(dir, '.verstak', 'RULES.md'), 'VRULES', 'utf8')
    const r = await loadUserLayer(dir, noGlobal)
    expect(r.path).toBe('.verstak/RULES.md')
    expect(r.content).toBe('VRULES')
  })
})
