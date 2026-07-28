import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseSkillFile, loadAllSkills, SKILL_ROOTS_IN_PRIORITY_ORDER } from '../../electron/ai/skills/loader'
import { BUILT_IN_SKILLS } from '../../electron/ai/skills/built-in'
import { createSkillRegistry } from '../../electron/ai/skills/registry'

/**
 * parseSkillFile получал raw не строкой (сервер отдал элемент без поля raw →
 * undefined) и падал на raw.replace — исключение улетало выше. Теперь
 * не-строковый вход честно даёт null (скилл пропускается, а не роняет загрузку).
 */
describe('parseSkillFile — защита от не-строкового raw', () => {
  it('undefined raw → null, без исключения', () => {
    expect(() => parseSkillFile(undefined as unknown as string, 'server:bad', 'server')).not.toThrow()
    expect(parseSkillFile(undefined as unknown as string, 'server:bad', 'server')).toBeNull()
  })

  it('null / number / object raw → null', () => {
    for (const bad of [null, 42, { id: 'x' }] as unknown as string[]) {
      expect(parseSkillFile(bad, 'server:bad', 'server')).toBeNull()
    }
  })

  it('валидный raw по-прежнему парсится (BOM срезается)', () => {
    const skill = parseSkillFile('﻿---\nid: ok-skill\n---\nтело', 'skills/ok-skill.md', 'built-in')
    expect(skill?.id).toBe('ok-skill')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Папочный формат скиллов (Claude Code / Codex / канон Sistems).
//
// Было: loadFromDir читала только одиночные *.md прямо в корне, поэтому скиллы
// вида <root>/<имя>/SKILL.md молча пропадали — а именно так их кладут Claude Code
// и Codex. Папочный обход уже существовал, но применялся только к Grok.
// Стало: каждый корень читается в ОБОИХ формах.
// ─────────────────────────────────────────────────────────────────────────────
// ИЗОЛЯЦИЯ ОТ МАШИНЫ (28.07). Проверки загрузчика раньше звали loadAllSkills без
// ограничения корней — то есть каждый кейс обходил РЕАЛЬНЫЕ ~/.claude, ~/.codex,
// ~/.grok и ~/.verstak. Замером на этой машине: 272 скилла, 778 файлов, ~300 мс
// на вызов; тринадцать вызовов под параллельной нагрузкой давали падения в общий
// 20-секундный таймаут. Лимит тут ни при чём — тест делал лишнюю работу и зависел
// от того, что лежит в домашней папке у запускающего.
describe('изоляция загрузчика от домашних деревьев', () => {
  it('roots:[] читает ТОЛЬКО built-in — домашние корни не трогаются', async () => {
    const { skills, stats } = await loadAllSkills({ roots: [] })
    expect(stats.user, 'пришли скиллы с реальной машины — изоляция дырявая').toBe(0)
    expect(skills.map(s => s.id).sort()).toEqual(BUILT_IN_SKILLS.map(s => s.id).sort())
  })

  it('без roots поведение прежнее: стандартные корни в работе', async () => {
    const { stats } = await loadAllSkills({ roots: SKILL_ROOTS_IN_PRIORITY_ORDER })
    expect(stats.failed.filter(f => f.includes('ENOENT'))).toEqual([])
  })
})

describe('скиллы папками: оба формата в одном корне', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gg-skills-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const folderSkill = (name: string, body = 'тело скилла', fm = '') => {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, 'SKILL.md'), `---\n${fm}---\n${body}\n`, 'utf8')
  }

  it('папка со SKILL.md становится скиллом, id и slash — из имени папки', async () => {
    folderSkill('pavel-verstak')
    const { skills } = await loadAllSkills({ roots: [root] })
    const s = skills.find(x => x.id === 'pavel-verstak')
    expect(s, 'скилл из папки не найден').toBeTruthy()
    expect(s!.slash).toBe('pavel-verstak')
    expect(s!.systemPrompt).toContain('тело скилла')
  })

  it('sourceRef указывает на фактический SKILL.md, а не на папку', async () => {
    folderSkill('pavel-verstak')
    const { skills } = await loadAllSkills({ roots: [root] })
    const s = skills.find(x => x.id === 'pavel-verstak')!
    expect(s.sourceRef.endsWith('SKILL.md')).toBe(true)
    expect(existsSync(s.sourceRef), 'путь из sourceRef не существует на диске').toBe(true)
  })

  it('папка без SKILL.md пропускается молча, без ошибки', async () => {
    mkdirSync(join(root, 'не-скилл', 'references'), { recursive: true })
    writeFileSync(join(root, 'не-скилл', 'README.md'), 'просто файл', 'utf8')
    folderSkill('живой')
    const res = await loadAllSkills({ roots: [root] })
    expect(res.skills.some(x => x.id === 'живой')).toBe(true)
    expect(res.skills.some(x => x.id === 'не-скилл')).toBe(false)
    expect(res.stats.failed.filter(f => f.includes(root))).toEqual([])
  })

  it('одиночный .md рядом с папками виден так же', async () => {
    folderSkill('из-папки')
    writeFileSync(join(root, 'из-файла.md'), '---\nid: из-файла\n---\nтело\n', 'utf8')
    const { skills } = await loadAllSkills({ roots: [root] })
    expect(skills.some(x => x.id === 'из-папки')).toBe(true)
    expect(skills.some(x => x.id === 'из-файла')).toBe(true)
  })

  it('вложенная references/ не ломает скан и скиллом не становится', async () => {
    folderSkill('со-ссылками')
    mkdirSync(join(root, 'со-ссылками', 'references'), { recursive: true })
    writeFileSync(join(root, 'со-ссылками', 'references', 'servers.md'), '# справка', 'utf8')
    const { skills } = await loadAllSkills({ roots: [root] })
    expect(skills.some(x => x.id === 'со-ссылками')).toBe(true)
    expect(skills.some(x => x.id === 'references' || x.id === 'servers')).toBe(false)
  })

  it('frontmatter сильнее имени папки', async () => {
    folderSkill('имя-папки', 'тело', 'id: из-фронтматтера\nslash: свой-слэш\n')
    const { skills } = await loadAllSkills({ roots: [root] })
    expect(skills.some(x => x.id === 'из-фронтматтера')).toBe(true)
    expect(skills.find(x => x.id === 'из-фронтматтера')!.slash).toBe('свой-слэш')
    expect(skills.some(x => x.id === 'имя-папки')).toBe(false)
  })
})

describe('приоритет источников при совпадении id', () => {
  it('порядок корней: адаптеры чужих CLI слабее личной ~/.verstak', () => {
    const idx = (frag: string) => SKILL_ROOTS_IN_PRIORITY_ORDER.findIndex(p => p.includes(frag))
    expect(idx('.claude')).toBeGreaterThanOrEqual(0)
    expect(idx('.codex'), '~/.codex/skills не сканируется').toBeGreaterThanOrEqual(0)
    expect(idx('.claude')).toBeLessThan(idx('.codex'))
    expect(idx('.codex')).toBeLessThan(idx('.grok'))
    expect(idx('.grok')).toBeLessThan(idx('.verstak'))
  })

  it('extraDirs сильнее всех корней и сильнее друг друга по порядку', async () => {
    const weak = mkdtempSync(join(tmpdir(), 'gg-weak-'))
    const strong = mkdtempSync(join(tmpdir(), 'gg-strong-'))
    try {
      writeFileSync(join(weak, 'спорный.md'), '---\nid: спорный\n---\nСЛАБЫЙ\n', 'utf8')
      writeFileSync(join(strong, 'спорный.md'), '---\nid: спорный\n---\nСИЛЬНЫЙ\n', 'utf8')
      const { skills } = await loadAllSkills({ roots: [weak, strong] })
      const s = skills.find(x => x.id === 'спорный')!
      expect(s.systemPrompt).toContain('СИЛЬНЫЙ')
      expect(s.systemPrompt).not.toContain('СЛАБЫЙ')
    } finally {
      rmSync(weak, { recursive: true, force: true })
      rmSync(strong, { recursive: true, force: true })
    }
  })

  it('extraDirs перебивает built-in id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gg-over-'))
    try {
      const builtInId = BUILT_IN_SKILLS[0].id
      writeFileSync(join(dir, 'x.md'), `---\nid: ${builtInId}\n---\nМОЙ ВАРИАНТ\n`, 'utf8')
      const { skills } = await loadAllSkills({ roots: [dir] })
      const s = skills.find(x => x.id === builtInId)!
      expect(s.systemPrompt).toContain('МОЙ ВАРИАНТ')
      expect(s.source).toBe('user')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('внутри одного корня папочная форма сильнее одиночного файла', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gg-same-'))
    try {
      writeFileSync(join(dir, 'дубль.md'), '---\nid: дубль\n---\nФАЙЛ\n', 'utf8')
      mkdirSync(join(dir, 'дубль'), { recursive: true })
      writeFileSync(join(dir, 'дубль', 'SKILL.md'), '---\nid: дубль\n---\nПАПКА\n', 'utf8')
      const { skills } = await loadAllSkills({ roots: [dir] })
      expect(skills.find(x => x.id === 'дубль')!.systemPrompt).toContain('ПАПКА')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Проводка «поле в Настройках → loadAllSkills». Без неё папка из UI никуда не
// доедет, и скилл из канона не появится — при зелёном loader'е.
// ─────────────────────────────────────────────────────────────────────────────
describe('extraDirs из настроек доезжает до реестра', () => {
  it('реестр видит скилл из папки, указанной в конфиге', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gg-canon-'))
    try {
      mkdirSync(join(dir, 'pavel-verstak'), { recursive: true })
      writeFileSync(join(dir, 'pavel-verstak', 'SKILL.md'), '---\nid: pavel-verstak\n---\nканон\n', 'utf8')
      // Тот же путь, что в main.ts: значение настройки → extraDirs.
      const settingValue = dir
      const registry = createSkillRegistry(() => ({
        serverBase: null,
        extraDirs: [settingValue.trim()].filter(Boolean),
      }))
      await registry.refresh()
      const s = registry.list().find(x => x.id === 'pavel-verstak')
      expect(s, 'скилл из extraDirs не доехал до реестра').toBeTruthy()
      expect(s!.systemPrompt).toContain('канон')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('пустое поле не добавляет корней — сканируется как раньше', async () => {
    const registry = createSkillRegistry(() => ({
      serverBase: null,
      extraDirs: [''.trim()].filter(Boolean),
    }))
    await registry.refresh()
    // built-in на месте, лишних корней не появилось
    expect(registry.list().some(x => x.id === BUILT_IN_SKILLS[0].id)).toBe(true)
  })

  // Страж проводки: main.ts обязан читать ключ и класть его в extraDirs.
  it('main.ts прокидывает skills_extra_dir в extraDirs', () => {
    const src = readFileSync(join(process.cwd(), 'electron/main.ts'), 'utf8')
    expect(src).toContain("settings.getSecret('skills_extra_dir')")
    expect(src).toMatch(/extraDirs:\s*\[.*skills_extra_dir[\s\S]{0,80}?\]\.filter\(Boolean\)/)
  })
})
