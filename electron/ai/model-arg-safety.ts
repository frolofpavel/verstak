/**
 * Open Design #2 (безопасность): безопасность имени модели, попадающего в argv
 * спавнящегося CLI (claude-cli / codex-cli / gemini-cli / grok-cli пушат
 * `args.push('-m', model)` в `spawn(bin, args)`).
 *
 * spawn() с МАССИВОМ аргументов не идёт через шелл, поэтому классической
 * шелл-инъекции нет. НО элемент argv, начинающийся с «-», ребёнок-CLI трактует как
 * ФЛАГ, а не как значение модели: модель вроде `--dangerously-…` протащила бы флаг
 * в дочерний процесс. Плюс отсекаем многотокенные/управляющие имена. Чистый модуль
 * без electron-импорта (его тянут провайдеры-раннеры).
 */

// Форма нормального id модели: старт/финиш — буква/цифра, в середине допустимы
// `. _ : / + -`. Никаких пробелов, кавычек, шелл-метасимволов, переводов строки.
const SAFE_MODEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._:/+-]*[A-Za-z0-9])?$/
const MAX_MODEL_LEN = 128

export function isSafeCliModel(model: unknown): boolean {
  if (typeof model !== 'string') return false
  const m = model.trim()
  if (!m || m.length > MAX_MODEL_LEN) return false
  if (m.startsWith('-')) return false // иначе ребёнок-CLI примет за флаг
  return SAFE_MODEL_RE.test(m)
}

/** Безопасная модель (с тримом) или null — null НЕ кладём в argv (CLI возьмёт дефолт). */
export function safeCliModelArg(model: string | undefined | null): string | null {
  if (!model) return null
  const m = model.trim()
  return isSafeCliModel(m) ? m : null
}
