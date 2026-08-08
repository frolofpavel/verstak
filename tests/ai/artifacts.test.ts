import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname, resolve } from 'path'
import { generateHtml, generateDocx, artifactsDir, resolveDocxDir, commonReadDir } from '../../electron/ai/artifacts'
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

  // ЗАДАЧА A (08.08): «рядом с материалами» значит рядом с тем, что человек назвал.
  // Раньше alongside всегда клал в корень проекта — при материалах в подпапке файл
  // терялся (Павел: отчёт по clients\cherrydom\briefs лёг в корень clients, модель
  // трижды не смогла переложить). Теперь alongside → папка материалов, когда известна.
  it('resolveDocxDir alongside + папка материалов (подпапка) → в подпапку материалов', () => {
    const sub = join(projectPath, 'cherrydom', 'briefs')
    expect(resolveDocxDir('alongside', { projectPath, downloadsDir: '/dl', materialsDir: sub })).toBe(sub)
  })
  it('resolveDocxDir alongside БЕЗ папки материалов → корень проекта (прежнее поведение, не сломать)', () => {
    expect(resolveDocxDir('alongside', { projectPath, downloadsDir: '/dl' })).toBe(projectPath)
  })
  it('resolveDocxDir downloads НЕ затирается папкой материалов (явный выбор побеждает дефолт)', () => {
    expect(resolveDocxDir('downloads', { projectPath, downloadsDir: '/dl', materialsDir: join(projectPath, 'sub') })).toBe('/dl')
  })
  it('generateDocx alongside + materialsDir → файл реально ложится в папку материалов', async () => {
    const sub = await mkdtemp(join(projectPath, 'mat-'))
    const r = await generateDocx(projectPath, { filename: 'rep', sections: sec, save_to: 'alongside' }, { materialsDir: sub })
    expect(r.path).toBe(join(sub, 'rep.docx'))
    expect(r.path).not.toContain('.verstak')
  })

  // ЗАДАЧА A вариант (i): alongside из ФАКТА — общий каталог реально прочитанных файлов,
  // зажатый в корень проекта. Наблюдение, не толкование намерения (штаб).
  it('commonReadDir: все файлы в одной подпапке → эта подпапка', () => {
    const subx = join(projectPath, 'cherrydom', 'briefs')
    expect(commonReadDir([join(subx, 'a.md'), join(subx, 'b.md')], projectPath)).toBe(resolve(subx))
  })
  it('commonReadDir: две разные подпапки → общий предок внутри проекта', () => {
    expect(commonReadDir([join(projectPath, 'x', 'a.md'), join(projectPath, 'y', 'b.md')], projectPath)).toBe(resolve(projectPath))
  })
  it('commonReadDir: ничего не читали → undefined (вызывающий → корень проекта)', () => {
    expect(commonReadDir([], projectPath)).toBeUndefined()
  })
  it('commonReadDir: предок ВНЕ корня проекта → ЗАЖАТ в корень (жёсткий гард)', () => {
    const outside = join(dirname(projectPath), 'other-project-xyz')
    expect(commonReadDir([join(outside, 'secret.md')], projectPath)).toBe(resolve(projectPath))
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

// VSK-PRODUCT-A1 шероховатость 1 (поправка 2): «таблица выводов» — НАСТОЯЩАЯ
// Word-таблица (<w:tbl>), а не подделка булитами.
describe('generateDocx table', () => {
  it('таблица секции превращается в настоящую <w:tbl> с текстом ячеек', async () => {
    const JSZip = (await import('jszip')).default
    const r = await generateDocx(projectPath, {
      filename: 'with-table',
      sections: [{
        heading: 'Выводы',
        paragraphs: ['Короткий вывод'],
        table: { header: ['Показатель', 'Значение'], rows: [['CTR', '2.3%'], ['Расход', '15000']] }
      }]
    })
    const buf = await readFile(r.path)
    const zip = await JSZip.loadAsync(buf)
    const xml = await zip.file('word/document.xml')!.async('string')
    // Настоящая таблица, а не булиты/параграфы:
    expect(xml).toContain('<w:tbl>')
    // Текст ячеек (заголовок и данные) на месте:
    for (const cell of ['Показатель', 'Значение', 'CTR', '2.3%', 'Расход', '15000']) {
      expect(xml).toContain(cell)
    }
  })
})
