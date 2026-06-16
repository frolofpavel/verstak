import type { ReleaseNote } from './update-remote'

/**
 * Приводит changelog к нейтральному официальному стилю.
 * Вызывается после merge GitHub + bundled — не меняет приоритет источников.
 */
export function formalizeReleaseBody(body: string): string {
  if (!body.trim()) return body

  let text = body
    .replace(/\r\n/g, '\n')
    .replace(/\s*[—–-]\s*«[^»]*»/g, '')
    .replace(/\s*\([^)]*(?:жму|ничего не|тупит|не вижу|раньше|было)[^)]*\)/gi, '')

  const phraseFixes: Array<[RegExp, string]> = [
    [/жму[^.!\n]*ничего не (?:вижу|происходит)[^.!\n]*/gi, 'Добавлена прокрутка к целевому блоку настроек'],
    [/наконец появляется/gi, 'отображается'],
    [/больше нет/gi, 'отключено'],
    [/тупит/gi, 'не обрабатывает запрос'],
    [/не видит/gi, 'не получает'],
  ]
  for (const [re, rep] of phraseFixes) {
    text = text.replace(re, rep)
  }

  return text.split('\n').map(line => {
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
  }).filter(line => line.length > 0).join('\n')
}

export function polishReleaseNote(note: ReleaseNote): ReleaseNote {
  return { ...note, body: formalizeReleaseBody(note.body) }
}

export function polishReleaseNotes(notes: ReleaseNote[]): ReleaseNote[] {
  return notes.map(polishReleaseNote)
}