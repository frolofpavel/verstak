import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateHtml, generateDocx, artifactsDir, resolveDocxDir } from '../../electron/ai/artifacts'
import { sep } from 'path'

let projectPath: string

beforeAll(async () => {
  projectPath = await mkdtemp(join(tmpdir(), 'gg-artifacts-'))
})

afterAll(async () => {
  if (projectPath) await rm(projectPath, { recursive: true, force: true })
})

describe('artifactsDir', () => {
  it('возвращает путь с сегодняшней датой', () => {
    const dir = artifactsDir('/x')
    expect(dir).toMatch(/[/\\]\.verstak[/\\]artifacts[/\\]\d{4}-\d{2}-\d{2}$/)
  })
})

describe('generateHtml', () => {
  it('создаёт файл с обёрткой и санитайзит имя', async () => {
    const r = await generateHtml(projectPath, {
      filename: 'kp/with/slash.html',  // спец-символы должны быть очищены
      title: 'Test KP',
      content_html: '<h1>Hello</h1><p>World</p>'
    })
    expect(r.kind).toBe('html')
    expect(r.filename).toMatch(/\.html$/)
    expect(r.filename).not.toMatch(/[\/\\]/)
    const content = await readFile(r.path, 'utf8')
    expect(content).toContain('<!DOCTYPE html>')
    expect(content).toContain('Test KP')
    expect(content).toContain('<h1>Hello</h1>')
  })

  it('экранирует HTML в title', async () => {
    const r = await generateHtml(projectPath, {
      filename: 'esc',
      title: 'Test <script>alert(1)</script>',
      content_html: '<p>body</p>'
    })
    const content = await readFile(r.path, 'utf8')
    expect(content).not.toContain('<script>alert(1)</script>')
    expect(content).toContain('&lt;script>')
  })
})

describe('generateDocx', () => {
  it('создаёт валидный DOCX', async () => {
    const r = await generateDocx(projectPath, {
      filename: 'audit-test',
      title: 'Аудит Direct: тестовый клиент',
      sections: [
        {
          heading: 'Что нашли',
          paragraphs: ['Параграф 1', 'Параграф 2'],
          bullets: ['пункт А', 'пункт Б']
        },
        {
          heading: 'Что рекомендуем',
          level: 2,
          paragraphs: ['Включить минус-слова', 'Обновить креативы']
        }
      ]
    })
    expect(r.kind).toBe('docx')
    expect(r.sizeBytes).toBeGreaterThan(1000)
    expect(r.filename).toBe('audit-test.docx')
    const buf = await readFile(r.path)
    // DOCX = ZIP archive, signature PK\x03\x04
    expect(buf[0]).toBe(0x50)
    expect(buf[1]).toBe(0x4b)
    expect(buf[2]).toBe(0x03)
    expect(buf[3]).toBe(0x04)
  })

  it('бросает если sections пустые', async () => {
    // Не бросает — но возвращает пустой docx. Логика «обязательность»
    // живёт на handler уровне, не на generator. Это OK.
    const r = await generateDocx(projectPath, { filename: 'empty', sections: [] })
    expect(r.sizeBytes).toBeGreaterThan(0)
  })
})

// VSK-PRODUCT-A1 шероховатость 1: «сохрани рядом»/«в загрузки» исполняются
// СРАЗУ, из ЗАКРЫТОГО перечня. Свободный путь в аргументе — примитив записи куда
// угодно; перечень + расчёт пути нашим кодом закрывают этот класс.
describe('generateDocx save_to (назначение перечнем)', () => {
  const sec = [{ paragraphs: ['x'] }]

  it('project (по умолчанию) → .verstak/artifacts/{дата}/', async () => {
    const r = await generateDocx(projectPath, { filename: 'p', sections: sec })
    expect(r.path.startsWith(artifactsDir(projectPath))).toBe(true)
  })

  it('alongside → корень открытой папки, НЕ .verstak', async () => {
    const r = await generateDocx(projectPath, { filename: 'a', sections: sec, save_to: 'alongside' })
    expect(r.path).toBe(join(projectPath, 'a.docx'))
    expect(r.path).not.toContain('.verstak')
  })

  it('downloads → переданная папка Загрузок', async () => {
    const dl = await mkdtemp(join(tmpdir(), 'gg-dl-'))
    try {
      const r = await generateDocx(projectPath, { filename: 'd', sections: sec, save_to: 'downloads' }, { downloadsDir: dl })
      expect(r.path).toBe(join(dl, 'd.docx'))
    } finally { await rm(dl, { recursive: true, force: true }) }
  })

  // ПИН БЕЗОПАСНОСТИ: произвольная строка в save_to НЕ становится путём — она вне
  // перечня, значит схлопывается в 'project'. Иначе параметр был бы записью куда угодно.
  it('произвольная строка save_to отвергается — схлопывается в project, не в путь', async () => {
    for (const evil of ['../../../etc', 'C:\\Windows\\System32', '/tmp/evil', 'downloads/../..']) {
      expect(resolveDocxDir(evil, { projectPath, downloadsDir: '/dl' })).toBe(artifactsDir(projectPath))
      const r = await generateDocx(projectPath, { filename: 'safe', sections: sec, save_to: evil })
      // файл лёг в артефакты проекта, а НЕ по «evil»-пути
      expect(r.path.startsWith(artifactsDir(projectPath))).toBe(true)
      expect(r.path).not.toContain('..' + sep)
    }
  })

  // filename с разделителями не выводит файл из каталога назначения (санитайз).
  it('filename с путём санитайзен — из каталога не выйти', async () => {
    const r = await generateDocx(projectPath, { filename: '../../evil', sections: sec, save_to: 'alongside' })
    expect(r.path.startsWith(projectPath + sep)).toBe(true)
    expect(r.filename).not.toMatch(/[/\\]/)
  })
})
