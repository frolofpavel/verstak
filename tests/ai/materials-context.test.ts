import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Attachment, ChatMessage } from '../../electron/ai/types'
import {
  deriveAttachmentMaterials,
  listFolderMaterials,
  isDocumentName,
  buildMaterialsManifest,
  appendMaterialsManifest,
} from '../../electron/ai/materials-context'

// Реальный docx-байт нужен только для проверки успеха извлечения; для набора
// достаточно имени/типа. extractDocxTextFromBuffer на мусорном base64 бросит —
// это и есть «не удалось развернуть», честная категория конвейера.
function att(name: string, mimeType: string, data = 'AAAA'): Attachment {
  return { name, mimeType, data, size: 3 }
}
const PDF = 'application/pdf'
const TXT = 'text/plain'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PNG = 'image/png'

describe('isDocumentName', () => {
  it('документные расширения — да, изображения/код — нет', () => {
    expect(isDocumentName('a.pdf')).toBe(true)
    expect(isDocumentName('B.DOCX')).toBe(true)
    expect(isDocumentName('data.csv')).toBe(true)
    expect(isDocumentName('pic.png')).toBe(false)
    expect(isDocumentName('main.ts')).toBe(false)
  })
})

describe('deriveAttachmentMaterials — исход из КОНВЕЙЕРА', () => {
  it('нет документных вложений → null', async () => {
    const m: ChatMessage = { role: 'user', content: 'hi', attachments: [att('pic.png', PNG)] }
    expect(await deriveAttachmentMaterials(m)).toBeNull()
  })

  it('нет вложений вовсе → null', async () => {
    expect(await deriveAttachmentMaterials({ role: 'user', content: 'hi' })).toBeNull()
    expect(await deriveAttachmentMaterials(null)).toBeNull()
  })

  it('pdf/txt доставляются инлайном → все прочитаны, каждый материал имеет исход', async () => {
    const m: ChatMessage = {
      role: 'user', content: 'разбери',
      attachments: [att('report.pdf', PDF), att('notes.txt', TXT), att('pic.png', PNG)],
    }
    const res = (await deriveAttachmentMaterials(m))!
    // Изображение в набор НЕ входит — материалами считаем только документы.
    expect(res.items).toEqual(['report.pdf', 'notes.txt'])
    // КАЖДЫЙ материал получает исход → notOpened у вложений пуст по построению.
    expect(res.outcomes).toHaveLength(2)
    expect(res.outcomes.every(o => o.ok)).toBe(true)
  })

  it('битый docx → исход конвейера ok=false с причиной (не тревога «не открывал»)', async () => {
    const m: ChatMessage = { role: 'user', content: 'x', attachments: [att('broken.docx', DOCX, 'not-a-zip')] }
    const res = (await deriveAttachmentMaterials(m))!
    expect(res.items).toEqual(['broken.docx'])
    expect(res.outcomes[0].ok).toBe(false)
    expect(res.outcomes[0].reason).toBeTruthy()
  })

  // xlsx — office-вложение: исход из конвейера (exceljs), а НЕ «доставлено инлайном».
  it('битый xlsx → исход конвейера ok=false (разворачивается, а не инлайнится как есть)', async () => {
    const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    const m: ChatMessage = { role: 'user', content: 'x', attachments: [att('broken.xlsx', XLSX, 'not-a-zip')] }
    const res = (await deriveAttachmentMaterials(m))!
    expect(res.items).toEqual(['broken.xlsx'])
    expect(res.outcomes[0].ok).toBe(false)
    expect(res.outcomes[0].reason).toBeTruthy()
  })
})

describe('listFolderMaterials — только КОРЕНЬ, только документы', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mat-ctx-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('берёт документы корня, игнорирует код/изображения и подпапки (без рекурсии)', () => {
    writeFileSync(join(dir, 'a.docx'), 'x')
    writeFileSync(join(dir, 'b.pdf'), 'x')
    writeFileSync(join(dir, 'c.txt'), 'x')
    writeFileSync(join(dir, 'code.ts'), 'x')     // не документ
    writeFileSync(join(dir, 'photo.png'), 'x')   // не документ
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'deep.pdf'), 'x') // в подпапке — вне набора
    const items = listFolderMaterials(dir)
    expect(items).toEqual([join(dir, 'a.docx'), join(dir, 'b.pdf'), join(dir, 'c.txt')])
    expect(items.some(p => p.includes('deep.pdf'))).toBe(false)
  })

  it('несуществующая папка → пустой список, без броска', () => {
    expect(listFolderMaterials(join(dir, 'nope'))).toEqual([])
  })
})

// ЗАДАЧА 2, пункт 2: набор папки уходит в контекст как ПЕРЕЧЕНЬ-ФАКТ (данные, не
// директива). Модель ВИДИТ назначенный набор с именами/типами/размерами, а не
// растворённые в карте проекта файлы. Содержимое НЕ инжектим (контекст/деньги).
describe('buildMaterialsManifest — набор как перечень-факт', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mat-man-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('перечисляет имя+тип+размер каждого документа, обрамлён как «Материалы задачи»', () => {
    writeFileSync(join(dir, 'a.docx'), 'x'.repeat(2048))
    writeFileSync(join(dir, 'b.pdf'), 'y')
    const md = buildMaterialsManifest(listFolderMaterials(dir))
    expect(md).toContain('Материалы задачи (2 документа')
    expect(md).toMatch(/a\.docx · DOCX · 2\.0 КБ/)
    expect(md).toContain('b.pdf · PDF')
    // Содержимого файлов в перечне НЕТ — только факт-метаданные.
    expect(md).not.toContain('xxxx')
  })

  it('пустой набор → пустая строка (инжектить нечего)', () => {
    expect(buildMaterialsManifest([])).toBe('')
  })
})

describe('appendMaterialsManifest — дописывает к ПОСЛЕДНЕМУ user', () => {
  it('перечень уходит в последнее user-сообщение; system/assistant/прошлый user не тронуты', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'старый' },
      { role: 'assistant', content: 'ответ' },
      { role: 'user', content: 'собери отчёт' },
    ]
    const out = appendMaterialsManifest(msgs, '## Материалы задачи (1 документ)')
    expect(out[3].content).toContain('собери отчёт')
    expect(out[3].content).toContain('Материалы задачи')
    expect(out[1].content).toBe('старый')
    expect(out[0].content).toBe('sys')
    expect(msgs[3].content).toBe('собери отчёт')   // исходный массив не мутирован
  })

  it('пустой манифест → массив как есть; нет user → не падает', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'x' }]
    expect(appendMaterialsManifest(msgs, '')).toBe(msgs)
    expect(appendMaterialsManifest([{ role: 'system', content: 's' }], 'M')[0].content).toBe('s')
  })
})
