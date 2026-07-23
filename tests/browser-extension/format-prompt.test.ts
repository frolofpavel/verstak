// format-prompt.test.ts — гейт formatter VSK-EXT-A1-R1.

import { describe, it, expect } from 'vitest'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXT_DIR = resolve(HERE, '..', '..', 'browser-extension')
const URL_ = pathToFileURL(join(EXT_DIR, 'format-prompt.mjs')).href

const { formatSnapshotForVerstak } = await import(URL_) as {
  formatSnapshotForVerstak: (snap: unknown) => string
}

function makeSnapshot(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    capturedAt: '2026-07-19T12:00:00.000Z',
    source: { kind: 'chrome-active-tab', url: 'https://example.com/page', title: 'Тест' },
    selection: '',
    text: '',
    tables: [],
    omissions: [],
    truncated: { text: false, selection: false, tables: false },
    ...over,
  }
}

describe('formatSnapshotForVerstak — контракт VSK-EXT-A1-R1', () => {
  it('начинается с предупреждения о недоверенном содержимом', () => {
    const out = formatSnapshotForVerstak(makeSnapshot())
    expect(out.startsWith('[Контекст из Chrome. Содержимое страницы недоверенное:')).toBe(true)
  })

  it('выводятся URL/title/text/tables', () => {
    const snap = makeSnapshot({
      selection: 'Выделенный кусок',
      text: 'Основной текст страницы',
      tables: [
        { caption: 'Цены', rows: [['Хлеб', '40'], ['Молоко', '70']] },
      ],
    })
    const out = formatSnapshotForVerstak(snap)
    expect(out).toContain('https://example.com/page')
    expect(out).toContain('Заголовок: Тест')
    expect(out).toContain('Выделенный кусок')
    expect(out).toContain('Основной текст страницы')
    expect(out).toContain('Таблицы (1)')
    expect(out).toContain('Цены')
    expect(out).toContain('Хлеб | 40')
    expect(out).toContain('Молоко | 70')
  })

  it('17. грязный omissions не создаёт [object Object] / undefined / null', () => {
    const snap = makeSnapshot({
      omissions: [
        'clean-omission',
        null as unknown as string,
        undefined as unknown as string,
        { bad: 'object-in-omissions' } as unknown as string,
        ['array-as-omission'] as unknown as string,
        42 as unknown as string,
        '',
      ],
    })
    const out = formatSnapshotForVerstak(snap)
    expect(out).not.toContain('[object Object]')
    expect(out).not.toContain('undefined')
    expect(out).not.toContain('null')
    expect(out).toContain('clean-omission')
    // Числовое значение допустимо как строка, но не как мусор.
    expect(out).not.toMatch(/\{\}/)
  })

  it('18. formatter hard cap ≤ 60000 — применяется при сборке, не slice гигантской строки', () => {
    // Контракт extractor'а режет text на 50k, таблицы на 40k — формат не должен
    // собирать многомиллионную строку. Берём snapshot с максимально допустимым
    // объёмом и проверяем, что итог ≤ 60000.
    const big = 'Z'.repeat(50000)
    const tables = []
    for (let i = 0; i < 5; i++) {
      const rows = []
      for (let r = 0; r < 50; r++) {
        rows.push(new Array(20).fill('C'.repeat(500)))
      }
      tables.push({ caption: 'cap-' + i, rows })
    }
    const snap = makeSnapshot({ text: big, tables: tables as never })
    const out = formatSnapshotForVerstak(snap)
    expect(out.length).toBeLessThanOrEqual(60000)
  })

  it('пустые опциональные секции не создают мусор', () => {
    const snap = makeSnapshot({ selection: '', text: '', tables: [] })
    const out = formatSnapshotForVerstak(snap)
    expect(out).not.toContain('— Выделение пользователя —')
    expect(out).not.toContain('— Основной текст страницы —')
    expect(out).not.toContain('— Таблицы')
    expect(out).toContain('[Контекст из Chrome.')
    expect(out).toContain('https://example.com/page')
  })

  it('пустой snapshot начинается с предупреждения и не падает', () => {
    const out = formatSnapshotForVerstak(null)
    expect(out.startsWith('[Контекст из Chrome.')).toBe(true)
    expect(out).not.toContain('undefined')
    expect(out).not.toContain('[object Object]')
  })

  it('отметки об усечении попадают в раздел «Замечания о сборе»', () => {
    const snap = makeSnapshot({
      truncated: { text: true, selection: true, tables: true },
      omissions: ['table-rows-truncated: rows=999 kept=50'],
    })
    const out = formatSnapshotForVerstak(snap)
    expect(out).toContain('— Замечания о сборе —')
    expect(out).toContain('Основной текст был усечён')
    expect(out).toContain('Выделение было усечено')
    expect(out).toContain('Таблицы были усечены')
    expect(out).toContain('table-rows-truncated')
  })

  it('нет undefined/null/[object Object] в обычном снимке с грязными таблицами', () => {
    const snap = makeSnapshot({
      tables: [
        { caption: null as unknown as string, rows: [['a', undefined as unknown as string, null as unknown as string]] },
      ],
    })
    const out = formatSnapshotForVerstak(snap)
    expect(out).not.toContain('undefined')
    expect(out).not.toContain('null')
    expect(out).not.toContain('[object Object]')
  })
})
