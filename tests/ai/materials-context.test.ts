import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Attachment, ChatMessage } from '../../electron/ai/types'
import {
  deriveAttachmentMaterials,
  listFolderMaterials,
  isDocumentName,
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
