import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { inspectUserLayer, loadUserLayer, buildRuleConflictWarning } from '../../electron/ai/user-layer'

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
    // ignored — всегда присутствующее поле (пустой массив, когда конфликта нет).
    expect(r).toEqual({ path: null, content: '', ignored: [] })
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

  it('inspectUserLayer показывает активный источник и кандидаты', async () => {
    const globalPath = join(dir, 'global.md')
    writeFileSync(globalPath, 'GLOBAL', 'utf8')
    writeFileSync(join(dir, 'AGENTS.md'), 'A', 'utf8')
    writeFileSync(join(dir, 'CLAUDE.md'), 'C', 'utf8')

    const status = await inspectUserLayer(dir, globalPath)

    expect(status.activePath).toBe('~/.verstak/RULES.md + AGENTS.md')
    expect(status.global.active).toBe(true)
    expect(status.project.find(x => x.path === 'AGENTS.md')?.active).toBe(true)
    expect(status.project.find(x => x.path === 'CLAUDE.md')?.active).toBe(false)
  })
})

// ЗАДАЧА B (штаб): «первый файл правил выигрывает — МОЛЧА». Раньше при двух файлах
// правил в проекте продукт молча читал первый по PROJECT_RULE_CANDIDATES, а человек
// мог писать правила в другой. Теперь loadUserLayer сообщает, какие СУЩЕСТВУЮЩИЕ
// файлы были проигнорированы (поле `ignored`), чтобы прогон мог предупредить.
describe('loadUserLayer.ignored — проигнорированные проектные файлы правил', () => {
  let dir: string
  let noGlobal: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-ul-ign-'))
    noGlobal = join(dir, 'no-such-global.md')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('один файл → ignored пуст (КОНТРОЛЬ ТИШИНЫ: без него любой пин зелен всегда)', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'C', 'utf8')
    const r = await loadUserLayer(dir, noGlobal)
    expect(r.path).toBe('CLAUDE.md')
    expect(r.ignored).toEqual([])
  })

  it('ничего нет → ignored пуст', async () => {
    const r = await loadUserLayer(dir, noGlobal)
    expect(r.ignored).toEqual([])
  })

  it('два файла → взят первый, второй в ignored (ПОРЯДОК ПРИОРИТЕТА НЕ МЕНЯЕТСЯ)', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'A', 'utf8')
    writeFileSync(join(dir, 'CLAUDE.md'), 'C', 'utf8')
    const r = await loadUserLayer(dir, noGlobal)
    expect(r.path).toBe('AGENTS.md')       // первый по PROJECT_RULE_CANDIDATES по-прежнему активный
    expect(r.content).toBe('A')
    expect(r.ignored).toEqual(['CLAUDE.md'])
  })

  it('три файла → ignored перечисляет все кроме первого В ПОРЯДКЕ КАНДИДАТОВ', async () => {
    mkdirSync(join(dir, '.verstak'), { recursive: true })
    writeFileSync(join(dir, 'CLAUDE.md'), 'C', 'utf8')
    writeFileSync(join(dir, 'GEMINI.md'), 'G', 'utf8')
    writeFileSync(join(dir, '.verstak', 'RULES.md'), 'V', 'utf8')
    const r = await loadUserLayer(dir, noGlobal)
    expect(r.path).toBe('CLAUDE.md')
    expect(r.ignored).toEqual(['GEMINI.md', '.verstak/RULES.md'])
  })

  it('глобальный + два проектных → ignored всё ещё второй проектный (склейка не теряет данные)', async () => {
    const globalPath = join(dir, 'global.md')
    writeFileSync(globalPath, 'GLOBAL', 'utf8')
    writeFileSync(join(dir, 'AGENTS.md'), 'A', 'utf8')
    writeFileSync(join(dir, 'CLAUDE.md'), 'C', 'utf8')
    const r = await loadUserLayer(dir, globalPath)
    expect(r.path).toContain('AGENTS.md')
    expect(r.ignored).toEqual(['CLAUDE.md'])
  })
})

describe('buildRuleConflictWarning — что предупреждаем и когда (текст утверждает Павел)', () => {
  it('два файла → предупреждение содержит и ВЗЯТЫЙ, и ПРОИГНОРИРОВАННЫЙ поимённо', () => {
    const w = buildRuleConflictWarning('AGENTS.md', ['CLAUDE.md'])
    expect(w).not.toBeNull()
    const text = `${w!.title} ${w!.detail}`
    expect(text).toContain('AGENTS.md')
    expect(text).toContain('CLAUDE.md')
  })

  it('несколько проигнорированных перечислены все', () => {
    const w = buildRuleConflictWarning('CLAUDE.md', ['GEMINI.md', '.verstak/RULES.md'])
    const text = `${w!.title} ${w!.detail}`
    expect(text).toContain('CLAUDE.md')
    expect(text).toContain('GEMINI.md')
    expect(text).toContain('.verstak/RULES.md')
  })

  it('пустой ignored → null (ТИШИНА — контрольный кейс)', () => {
    expect(buildRuleConflictWarning('AGENTS.md', [])).toBeNull()
  })

  it('undefined ignored → null (обратная совместимость)', () => {
    expect(buildRuleConflictWarning('AGENTS.md', undefined)).toBeNull()
  })
})
