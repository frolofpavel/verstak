import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..')

/**
 * Враждебное ревью 2.6.4 §6. Продукт продавал себя цифрами, и ни одна не
 * подтверждалась: онбординг «10+ провайдеров», `README.md` «Providers (18)»,
 * реестр `PROVIDER_IDS` — 22; «Connectors (31)» при собственном аудите
 * «живьём с настоящим ключом проверен ОДИН»; «20+ tools» против 83 в рантайме.
 *
 * Решение Павла от 15.08 — числа УБРАТЬ, а не подгонять: счётчик провайдеров
 * не является позиционированием (`docs/PRODUCT_POSITIONING.md` §9). Из
 * установщика его убрали в 2.6.4, но до `README.md` — главной публичной
 * страницы — пункт релиза не доехал, и первый экран приложения продолжал
 * обещать «10+». Пин закрывает обе двери сразу.
 */
describe('счётчики витрины (§6 ревью)', () => {
  const PUBLIC_TEXTS = [
    'README.md',
    'docs/index.html',
    'src/i18n/ru.ts',
    'src/i18n/en.ts',
    'src/installer/constants.ts',
  ]

  /** «18 провайдеров», «20+ tools», «10+ AI-провайдеров». */
  const INLINE_COUNT = /\b\d+\s*\+?\s*(?:AI[-\s])?(?:провайдер|коннектор|инструмент|provider|connector|tool)[а-яa-z]*/i
  /** «### Providers (18)», «Коннекторы (31)». */
  const HEADING_COUNT = /(?:Providers|Connectors|Tools|Провайдеры|Коннекторы|Инструменты)\s*\(\s*\d+\s*\)/i

  /**
   * Пин судит ПОКАЗЫВАЕМЫЙ текст. Комментарии в коде под него не попадают
   * намеренно: запись «здесь стояло 18 и почему её сняли» — это история
   * решения, ровно та, которую регламент велит хранить, а не витрина.
   * В markdown комментариев не ищем — там `*` это пункт списка.
   */
  const isComment = (rel: string, line: string): boolean => {
    if (rel.endsWith('.md')) return false
    const t = line.trim()
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--')
  }

  it('в публичных текстах чисел провайдеров, коннекторов и инструментов нет', () => {
    const offenders: string[] = []
    for (const rel of PUBLIC_TEXTS) {
      const text = readFileSync(join(ROOT, rel), 'utf8')
      for (const line of text.split('\n')) {
        if (isComment(rel, line)) continue
        if (INLINE_COUNT.test(line) || HEADING_COUNT.test(line)) offenders.push(`${rel}: ${line.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('контроль: пин ловит ИМЕННО те формы, что стояли в 2.6.4', () => {
    const wasThere = [
      '### Providers (18)',
      '### Connectors (31)',
      '- **20+ tools:** read/write files, terminal, search',
      "      providers: '10+ AI-провайдеров в одном окне',",
      "      providers: '10+ AI providers in one window',",
      '«18 провайдеров в одном окне»',
    ]
    const missed = wasThere.filter(line => !INLINE_COUNT.test(line) && !HEADING_COUNT.test(line))
    expect(missed).toEqual([])
  })
})
