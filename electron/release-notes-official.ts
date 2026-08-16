import type { ReleaseNote } from './update-remote'

/** Пункт списка. Отступ разрешён — вложенные пункты формализация не трогает. */
const BULLET_RE = /^(\s*)(?:[-*]|\d+\.)\s+\S/
/** Блочные конструкции markdown: заголовок, цитата, линейка, код. */
const BLOCK_RE = /^(?:#{1,6}\s|>|-{3,}$|\*{3,}$|```)/

/**
 * Мягкие переносы внутри одного пункта склеиваются в ОДНУ строку до
 * форматирования.
 *
 * Повод (враждебное ревью 2.6.4 §4): формализация обрабатывала каждую
 * ФИЗИЧЕСКУЮ строку отдельно, поэтому пункт, перенесённый по ширине,
 * заканчивался «точкой» на переносе, а его продолжение шло со строчной буквы:
 * «…страница без ваших. входов и куки…». Испорчены были 6 пунктов из 6 —
 * то есть все релиз-ноты версии, первый текст, который видит человек.
 * Продовый вход многострочный ВСЕГДА: `CHANGELOG.md` пишется с переносами.
 */
function reflowSoftWraps(lines: string[]): string[] {
  const out: string[] = []
  let insideBullet = false
  for (const raw of lines) {
    const line = raw.trimEnd()
    const trimmed = line.trim()
    if (BULLET_RE.test(line)) {
      out.push(line)
      insideBullet = true
    } else if (!trimmed || BLOCK_RE.test(trimmed)) {
      out.push(line)
      insideBullet = false
    } else if (insideBullet && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1]} ${trimmed}`
    } else {
      out.push(line)
    }
  }
  return out
}

/**
 * Приводит changelog к нейтральному официальному стилю.
 * Вызывается после merge GitHub + bundled — не меняет приоритет источников.
 */
export function formalizeReleaseBody(body: string): string {
  if (!body.trim()) return body

  let text = body.replace(/\r\n/g, '\n')
  // Здесь же вырезались цитаты в кавычках после тире и скобки со «слишком
  // разговорными» словами. Снято тем же движением, что и словарь подмены ниже:
  // это удаление авторского текста, а не форматирование. Половинчатость хуже
  // обоих решений — либо машина не трогает смысл, либо трогает.

  // СЛОВАРЬ ПОДМЕНЫ СЛОВ СНЯТ 15.08 (решение штаба по заказу Павла).
  //
  // Здесь стояла таблица «формализации»: «больше нет»→«отключено», «тупит»→«не
  // обрабатывает запрос», «не видит»→«не получает», а первое правило подменяло
  // ПУНКТ ЦЕЛИКОМ заготовкой «Добавлена прокрутка к целевому блоку настроек».
  // Это редактура публичного текста машиной, и она работает против того, как ноты
  // пишутся с 2.6.0 — намеренно человеческим языком, про пользу человеку. Машина,
  // приводящая живой текст к «официальному стилю», в лучшем случае обесцвечивает
  // его, в худшем — пишет то, чего автор не говорил (случай первого правила).
  // Структурное форматирование ниже ОСТАВЛЕНО: оно чинит вёрстку (мягкие переносы,
  // двойные пробелы, префикс «fix:»), а не смысл.

  return reflowSoftWraps(text.split('\n')).map(line => {
    const trimmed = line.trimEnd()
    if (!trimmed) return ''
    if (trimmed === '---') return trimmed
    const bullet = trimmed.match(/^([-*]|\d+\.)\s+(.*)$/)
    if (!bullet) return trimmed
    let item = bullet[2]
      .replace(/^(?:fix|фикс|bugfix):\s*/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    if (!item) return `${bullet[1]} `
    if (item[0] === item[0].toLowerCase() && /[а-яa-z]/.test(item[0])) {
      item = item[0].toUpperCase() + item.slice(1)
    }
    if (!/[.!?]$/.test(item) && item.length > 20) item += '.'
    return `${bullet[1]} ${item}`
  // Пустые строки СОХРАНЯЮТСЯ. Их выбрасывание склеивало соседние абзацы и
  // список с предшествующим текстом в один абзац — вторая половина той же
  // порчи, что и точка на переносе (§4 ревью).
  }).join('\n')
}

export function polishReleaseNote(note: ReleaseNote): ReleaseNote {
  return { ...note, body: formalizeReleaseBody(note.body) }
}

export function polishReleaseNotes(notes: ReleaseNote[]): ReleaseNote[] {
  return notes.map(polishReleaseNote)
}