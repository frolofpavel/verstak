import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { formalizeReleaseBody, polishReleaseNote } from '../electron/release-notes-official'
import { mergeReleaseNotes } from '../electron/rayner-changelog'
import type { ReleaseNote } from '../electron/update-remote'

/**
 * Враждебное ревью 2.6.4 §4. Формализация обрабатывала каждую ФИЗИЧЕСКУЮ строку
 * отдельно и дописывала точку на мягком переносе: «…страница без ваших. входов
 * и куки…». Шесть пунктов из шести релиз-нотов версии — то есть весь текст,
 * который человек видит после установки.
 *
 * Почему это не поймали четыре зелёных теста: во ВСЕХ четырёх фикстура была
 * ОДНОСТРОЧНЫМ пунктом, а продовый вход многострочный всегда (`CHANGELOG.md`
 * пишется с переносами). Это дословно случай из CLAUDE.md §3.1 — «тест, чья
 * фикстура не совпадает с продовой формой вызова, не защищает ничего и не
 * сообщает об этом». Ниже фикстура взята из НАСТОЯЩЕГО CHANGELOG.md.
 */
describe('release-notes-official: многострочный пункт (продовая форма)', () => {
  /** Так же, как markdown в модалке склеивает мягкие переносы при показе. */
  const asShown = (body: string) => body.replace(/\n(?!\s*[-*])\s*/g, ' ')
  /** Ложная точка: конец предложения, за которым идёт строчная буква. */
  const FALSE_STOP = /[а-яa-z]{3,}\. [а-яё]{2,}/g

  function changelogSection(version: string): string {
    const md = readFileSync(join(__dirname, '..', 'CHANGELOG.md'), 'utf8')
    const from = md.indexOf(`## ${version}`)
    expect(from).toBeGreaterThanOrEqual(0)
    const rest = md.slice(from)
    const to = rest.indexOf('\n## ', 1)
    return (to > 0 ? rest.slice(0, to) : rest).split('\n').slice(1).join('\n').trim()
  }

  it('перенос строки внутри пункта НЕ становится концом предложения', () => {
    const raw = [
      '- **Защита секретов одинаковая на всех путях.** Приватные ключи и файлы с паролями',
      '  в проекте закрыты одинаково, каким бы провайдером вы ни работали.',
    ].join('\n')

    const shown = asShown(formalizeReleaseBody(raw))

    expect(shown).toContain('файлы с паролями в проекте закрыты одинаково')
    expect(shown).not.toContain('паролями. в проекте')
    expect([...shown.matchAll(FALSE_STOP)]).toEqual([])
  })

  it('реальный CHANGELOG 2.6.4 проходит без единой ложной точки', () => {
    const shown = asShown(formalizeReleaseBody(changelogSection('2.6.4')))
    expect([...shown.matchAll(FALSE_STOP)].map(m => m[0])).toEqual([])
    // Контроль, что фикстура не выродилась в однострочник: в исходнике
    // переносы внутри пунктов есть, иначе тест ничего бы не измерял.
    expect(changelogSection('2.6.4')).toMatch(/\n {2,}\S/)
  })

  it('контроль: точка в конце пункта по-прежнему дописывается', () => {
    const out = formalizeReleaseBody('- Верстак научился открывать проект по ссылке')
    expect(out).toBe('- Верстак научился открывать проект по ссылке.')
  })

  it('вложенные пункты не приклеиваются к родительскому', () => {
    const raw = ['- Родительский пункт списка', '  - вложенный пункт списка'].join('\n')
    const out = formalizeReleaseBody(raw)
    expect(out.split('\n')).toHaveLength(2)
    expect(out).toContain('  - вложенный пункт списка')
  })

  it('пустые строки и заголовки разделов сохраняются', () => {
    const raw = ['### Раздел', '', '- Первый пункт списка версии', '', '### Другой раздел'].join('\n')
    expect(formalizeReleaseBody(raw).split('\n')).toEqual([
      '### Раздел', '', '- Первый пункт списка версии.', '', '### Другой раздел',
    ])
  })
})

describe('release-notes-official', () => {
  // КОНТРАКТ ИЗМЕНЁН 15.08 (решение штаба по заказу Павла), утверждения переписаны
  // осознанно: прежний пин стерёг «убирает разговорные вставки» — то самое поведение,
  // которое отменено. Машина больше не редактирует публичный текст: ноты пишутся
  // человеческим языком специально, и словарь подмены («больше нет»→«отключено»,
  // подмена пункта заготовкой про прокрутку) работал против этого.
  it('formalizeReleaseBody НЕ трогает слова автора — только вёрстку', () => {
    const raw = '- Клик по коннектору скроллит к настройкам (раньше панель за экраном — «жму, ничего не происходит»).'
    const out = formalizeReleaseBody(raw)
    expect(out).toMatch(/жму/i)
    expect(out).toMatch(/«/)
    expect(out).toMatch(/^- /)
  })

  it('formalizeReleaseBody склеивает мягкий перенос внутри пункта', () => {
    // Ради чего форматирование вообще осталось: враждебное ревью 2.6.4 §4 —
    // перенос по ширине давал «…без ваших. входов», испорчены были 6 пунктов из 6.
    // Точка в конце пункта — законное форматирование и остаётся; ловим именно
    // ложную точку НА ПЕРЕНОСЕ, из-за которой пункт разрывался посередине.
    const out = formalizeReleaseBody('- Чистая сессия браузера без ваших\n  входов и куки')
    expect(out).toBe('- Чистая сессия браузера без ваших входов и куки.')
    expect(out).not.toMatch(/ваших\.\s/)
  })

  it('mergeReleaseNotes: GitHub основной, bundled — дополнение', () => {
    const github: ReleaseNote[] = [{
      version: '1.5.4',
      name: 'Verstak 1.5.4',
      body: '- Upstream change',
      htmlUrl: 'https://example.com/gh',
      publishedAt: '2026-06-16T10:00:00Z',
    }]
    const bundled: ReleaseNote[] = [{
      version: '1.5.4',
      name: 'Verstak 1.5.4',
      body: '- Rayner patch',
      htmlUrl: 'https://example.com/rayner',
      publishedAt: '2026-06-16T14:00:00Z',
    }]
    const merged = mergeReleaseNotes(github, bundled)
    expect(merged[0].body).toContain('Upstream change')
    expect(merged[0].body).toContain('Rayner patch')
    expect(merged[0].body).toContain('---')
  })

  it('polishReleaseNote формализует merge без подмены каталогом', () => {
    const merged = mergeReleaseNotes(
      [{
        version: '1.5.4',
        name: 'Verstak 1.5.4',
        body: '- Жму на коннектор — ничего не вижу',
        htmlUrl: 'https://example.com/gh',
      }],
      [{
        version: '1.5.4',
        name: 'Verstak 1.5.4',
        body: '- Добавлена прокрутка к карточке коннектора при выборе из списка.',
        htmlUrl: 'https://example.com/rayner',
      }],
    )
    const polished = polishReleaseNote(merged[0])
    // СНЯТО 15.08 вместе со словарём подмены: формализация больше не переписывает
    // слова автора и не подменяет пункт заготовкой. Живой текст доходит как есть.
    expect(polished.body).toContain('Жму')
    expect(polished.body).toContain('---')
    expect(polished.body).toContain('прокрутка к карточке')
    // текст автора доходит как есть — см. release-notes-official.ts
  })

  it('polishReleaseNote формализует версию без каталога', () => {
    const note: ReleaseNote = {
      version: '9.9.9',
      name: 'Test',
      body: '- fix: something broke — «тупит»',
      htmlUrl: 'https://example.com',
    }
    const polished = polishReleaseNote(note)
    expect(polished.body).toContain('тупит') // слово автора сохраняется
    expect(polished.body).toMatch(/^- Something broke/)
  })
})