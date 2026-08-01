import { describe, it, expect } from 'vitest'
import { Buffer } from 'node:buffer'
// Реальный exceljs — не мок: доказываем настоящий путь разворачивания xlsx-вложения.
import { extractXlsxTextFromBuffer } from '../../electron/ai/office'
import { expandOfficeAttachments, isXlsxAttachment } from '../../electron/ai/attachment-text'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

async function makeXlsxBase64(): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ExcelJS = require('exceljs') as typeof import('exceljs')
  const wb = new ExcelJS.Workbook()
  const sheet = wb.addWorksheet('Смета')
  sheet.addRow(['Услуга', 'Цена'])
  sheet.addRow(['Аудит', 15000])
  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf as ArrayBuffer).toString('base64')
}

describe('xlsx-вложения: реальный конвейер exceljs', () => {
  it('isXlsxAttachment по имени и по mime', () => {
    expect(isXlsxAttachment({ name: 'a.xlsx', mimeType: 'application/octet-stream', data: '', size: 1 })).toBe(true)
    expect(isXlsxAttachment({ name: 'a.docx', mimeType: 'application/pdf', data: '', size: 1 })).toBe(false)
  })

  it('extractXlsxTextFromBuffer возвращает имя листа и значения ячеек', async () => {
    const b64 = await makeXlsxBase64()
    const text = await extractXlsxTextFromBuffer(Buffer.from(b64, 'base64'))
    expect(text).toContain('Смета')
    expect(text).toContain('Услуга')
    expect(text).toContain('15000')
  })

  it('expandOfficeAttachments разворачивает xlsx в текст и убирает бинарь из attachments', async () => {
    const b64 = await makeXlsxBase64()
    const out = await expandOfficeAttachments([
      {
        role: 'user',
        content: 'собери отчёт по смете',
        attachments: [{ name: 'смета.xlsx', mimeType: XLSX_MIME, data: b64, size: 10 }],
      },
    ])
    expect(out[0].content).toContain('собери отчёт по смете')
    expect(out[0].content).toContain('Услуга')     // содержимое таблицы инлайнено
    expect(out[0].attachments).toBeUndefined()      // бинарь убран
  })

  it('битый xlsx → пометка «не удалось извлечь текст», без броска', async () => {
    const out = await expandOfficeAttachments([
      {
        role: 'user',
        content: 'x',
        attachments: [{ name: 'broken.xlsx', mimeType: XLSX_MIME, data: Buffer.from('not-a-zip').toString('base64'), size: 9 }],
      },
    ])
    expect(out[0].content).toContain('не удалось извлечь текст')
  })
})
