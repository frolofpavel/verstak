import { describe, it, expect } from 'vitest'
import { Buffer } from 'node:buffer'
// Реальный exceljs — не мок: доказываем настоящий путь разворачивания xlsx-вложения.
import { extractXlsxTextFromBuffer } from '../../electron/ai/office'
import { expandOfficeAttachments, isXlsxAttachment } from '../../electron/ai/attachment-text'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * Бюджет тестов, которые строят настоящую книгу через exceljs.
 *
 * Дорогое здесь — ХОЛОДНАЯ загрузка exceljs (тяжёлый CJS-модуль), а не работа с
 * таблицей: замер 10.08 — загрузка 414 мс, запись книги 38 мс, весь тест соло
 * 449 мс. Убрать эту работу нельзя: файл специально проверяет НАСТОЯЩИЙ путь
 * exceljs, а не мок (см. комментарий у импорта). Значит по правилу «сначала
 * измерить, ЧТО именно долгое, и только потом решать» остаётся поднять бюджет.
 *
 * Почему явный третий аргумент, а не глобальные 20 000: под реальным условием
 * отказа (полные ПАРАЛЛЕЛЬНЫЕ прогоны --maxWorkers=4, максимум по тесту из
 * json-отчётов) он дал 488 · 466 · 6447 · 753 мс. Максимум 6.4 с — запас всего
 * втрое, и релизный гейт его пробил (24 944 мс, гейт 2.4.9 красный): тесты там
 * стартуют сразу после распаковки 7z и запуска Electron в smoke, в самый тяжёлый
 * по диску момент конвейера. Бюджет, равный глобальному, запаса не даёт вовсе.
 *
 * Утверждения тестов НЕ тронуты: сломанное извлечение красит их сразу, как и
 * раньше; лимит стережёт только время. Продуктовая гипотеза («замедлил кто-то из
 * V2») закрыта графом импортов, а не мнением: office.ts тянет node:buffer,
 * fs/promises, secret-scanner, path-policy — ни одного модуля V2 там нет.
 */
const XLSX_BUILD_TEST_TIMEOUT_MS = 60_000

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
  }, XLSX_BUILD_TEST_TIMEOUT_MS)

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
    // Тот же бюджет: порядок тестов не гарантирован, и холодная загрузка exceljs
    // может достаться этому тесту, а не соседнему.
  }, XLSX_BUILD_TEST_TIMEOUT_MS)

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
