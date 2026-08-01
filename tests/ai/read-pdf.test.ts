import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { readPdf } from '../../electron/ai/office'

// VSK-PRODUCT-A1 (кусок 5, PDF): read_pdf через unpdf. Три страховки —
// размер / таймаут / скан-без-текста. Здесь детерминированно проверяем
// извлечение текста, ошибку на скане и ошибку на размере.

/** Минимальный валидный PDF; contentStream — операторы страницы (пусто = «скан»). */
function makePdf(contentStream: string): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const off: number[] = []
  objs.forEach((o, i) => { off.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = pdf.length
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    off.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}

let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'gg-pdf-')) })
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

describe('read_pdf', () => {
  it('извлекает текстовый слой', async () => {
    await writeFile(join(dir, 'ok.pdf'), makePdf('BT /F1 24 Tf 100 700 Td (Hello Verstak) Tj ET'))
    const text = await readPdf(dir, 'ok.pdf')
    expect(text).toContain('Hello Verstak')
  }, 20000)

  it('скан без текстового слоя → ЯВНАЯ ошибка, а не пустая строка', async () => {
    // Пустой content stream — валидный PDF без текста (эмуляция скана).
    await writeFile(join(dir, 'scan.pdf'), makePdf(''))
    await expect(readPdf(dir, 'scan.pdf')).rejects.toThrow(/нет текстового слоя|скан|OCR/i)
  }, 20000)

  it('слишком большой файл → ошибка размера до разбора', async () => {
    await writeFile(join(dir, 'big.pdf'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x20))
    await expect(readPdf(dir, 'big.pdf')).rejects.toThrow(/слишком большой/i)
  })
})
