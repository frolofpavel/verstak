import { describe, it, expect } from 'vitest'
import { join, resolve } from 'node:path'
import { summarizeMaterials, formatMaterialsLine, type ReadOutcome } from '../../electron/ai/materials-summary'

// База АБСОЛЮТНА (как в проде: корень открытой папки), материалы — абсолютные пути.
const BASE = resolve('work', 'proj')
const m = (name: string) => join(BASE, name)

describe('summarizeMaterials — категории', () => {
  it('всё прочитано → строка null (нечего сказать)', () => {
    const s = summarizeMaterials({
      materials: [m('a.docx'), m('b.pdf')], base: BASE, source: 'folder',
      outcomes: [{ path: m('a.docx'), ok: true }, { path: m('b.pdf'), ok: true }],
    })
    expect(s.read).toHaveLength(2)
    expect(formatMaterialsLine(s)).toBeNull()
  })

  it('провал чтения → «не удалось» с причиной', () => {
    const s = summarizeMaterials({
      materials: [m('a.docx'), m('scan.pdf')], base: BASE, source: 'folder',
      outcomes: [{ path: m('a.docx'), ok: true }, { path: m('scan.pdf'), ok: false, reason: 'нет текстового слоя' }],
    })
    expect(s.failed).toEqual([{ path: m('scan.pdf'), reason: 'нет текстового слоя' }])
    const line = formatMaterialsLine(s)!
    expect(line).toContain('не удалось 1')
    expect(line).toContain('scan.pdf — нет текстового слоя')
    expect(line).toContain('В корне папки 2 документа')
  })

  it('не открывал → отдельная категория + названа граница', () => {
    const s = summarizeMaterials({
      materials: [m('a.docx'), m('b.pdf'), m('c.txt')], base: BASE, source: 'folder',
      outcomes: [{ path: m('a.docx'), ok: true }],
    })
    expect(s.notOpened).toEqual([m('b.pdf'), m('c.txt')])
    expect(formatMaterialsLine(s)!).toContain('не открывал 2')
  })

  // КОНТРОЛЬНЫЙ ПИН (штаб, задача 2): недобор не прячется. На здоровом наборе сводка
  // молчит (пин выше, «всё прочитано → null») — значит рядом ОБЯЗАН стоять случай, где
  // перечислять ЕСТЬ ЧТО: 5 материалов, модель молча прочла 2 → строка говорит
  // «прочитано 2» И НАЗЫВАЕТ три непрочитанных ПОИМЁННО. Зелёный на полном наборе не
  // измеряет ничего; измеряет вот этот.
  it('5 материалов, молча прочитано 2 → строка называет 3 непрочитанных поимённо', () => {
    const s = summarizeMaterials({
      materials: [m('a.docx'), m('b.pdf'), m('c.txt'), m('d.docx'), m('e.pdf')], base: BASE, source: 'folder',
      outcomes: [{ path: m('a.docx'), ok: true }, { path: m('b.pdf'), ok: true }],
    })
    const line = formatMaterialsLine(s)!
    expect(line).toContain('прочитано 2')
    expect(line).toContain('не открывал 3')
    for (const name of ['c.txt', 'd.docx', 'e.pdf']) expect(line).toContain(name)
  })

  // ПИН НАПРАВЛЕНИЯ ОШИБКИ (требование ревьюера): файл, прочитанный по пути с
  // ДРУГИМ РЕГИСТРОМ или в ОТНОСИТЕЛЬНОЙ форме, сопоставляется и НЕ уходит в
  // «не открывал». Иначе сводка соврёт про наш успех в сторону тревоги.
  it('материал, прочитанный в другой форме пути, НЕ попадает в «не открывал»', () => {
    const s = summarizeMaterials({
      materials: [m('Report.docx')], base: BASE, source: 'attachments',
      // относительная форма + другой регистр:
      outcomes: [{ path: 'report.DOCX', ok: true } as ReadOutcome],
    })
    expect(s.notOpened).toHaveLength(0)         // НЕ ложная тревога
    expect(s.read).toEqual([m('Report.docx')])  // сопоставлен как прочитанный
    expect(formatMaterialsLine(s)).toBeNull()   // сказать нечего — всё прочитано
  })

  // Успешный read, которого НЕТ в наборе, → «вне набора», а не «не открывал».
  it('успешный read вне набора идёт в readOutside, не в notOpened', () => {
    const s = summarizeMaterials({
      materials: [m('a.docx')], base: BASE, source: 'folder',
      outcomes: [
        { path: m('a.docx'), ok: false, reason: 'битый' },
        { path: m('src/util.ts'), ok: true },  // прочитан, но не материал
      ],
    })
    expect(s.notOpened).toHaveLength(0)
    expect(s.readOutside).toEqual([m('src/util.ts')])
    expect(s.failed).toHaveLength(1)
    expect(formatMaterialsLine(s)!).toContain('вне набора 1')
  })

  it('лучший исход: сначала провал, потом успех по тому же файлу → прочитано', () => {
    const s = summarizeMaterials({
      materials: [m('a.pdf')], base: BASE, source: 'attachments',
      outcomes: [{ path: m('a.pdf'), ok: false, reason: 'x' }, { path: m('a.pdf'), ok: true }],
    })
    expect(s.read).toEqual([m('a.pdf')])
    expect(s.failed).toHaveLength(0)
  })
})
