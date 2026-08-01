import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createFileTools } from '../../electron/ai/tools'

// VSK-PRODUCT-A1 шероховатость 3: read_file отдаёт ТЕКСТ. Раньше бинарь (PDF,
// office, изображение) декодировался utf8 в молчаливый мусор — пользователь не
// узнавал, что файл не прочитан. Теперь честная ошибка с подсказкой инструмента.
let root: string
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'gg-readbin-')) })
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

describe('read_file честность: бинарь не отдаётся мусором', () => {
  it('текстовый файл читается как раньше', async () => {
    await writeFile(join(root, 'ok.txt'), 'привет мир\nвторая строка', 'utf8')
    const r = await createFileTools(root).execute('read_file', { path: 'ok.txt' })
    expect(String(r)).toContain('привет мир')
  })

  it('бинарь (нулевые байты) → честная ошибка, а не мусор', async () => {
    // %PDF + нулевой байт — как настоящий PDF.
    await writeFile(join(root, 'blob.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02, 0x00, 0xff, 0xfe]))
    await expect(createFileTools(root).execute('read_file', { path: 'blob.pdf' }))
      .rejects.toThrow(/не текстовый|бинарн/i)
  })

  it('бинарный .docx подсказывает read_document', async () => {
    // PK zip-сигнатура + нулевой байт.
    await writeFile(join(root, 'doc.docx'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x01]))
    await expect(createFileTools(root).execute('read_file', { path: 'doc.docx' }))
      .rejects.toThrow(/read_document/)
  })
})
