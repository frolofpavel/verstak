/**
 * @-mentions контекста в композере — пользователь явно подмешивает файлы в контекст
 * модели, набрав @path. Прозрачный точечный отбор контекста (видно/выбираешь что
 * идёт в модель) поверх авто-context-pack.
 *
 * Здесь — только pure-парсер упоминаний (рендерер). Чтение файлов и редактирование
 * секретов — на бэкенде (files:resolveMentions, path-policy + scanText).
 */

// @ в начале строки или после пробела (не email вроде foo@bar), путь из безопасных
// символов: буквы/цифры/_/-/./слэш. Расширения и подпапки поддерживаются.
const MENTION_RE = /(?:^|\s)@([A-Za-z0-9._\-/\\]+)/g

/** Извлечь уникальные пути из @-упоминаний в тексте. Сохраняет порядок появления. */
export function extractMentions(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(MENTION_RE)) {
    let p = m[1].replace(/[.,;:]+$/, '') // снять хвостовую пунктуацию
    p = p.replace(/\\/g, '/')
    if (!p || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}
