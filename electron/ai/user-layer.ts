import { readFile, stat, writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { homedir } from 'os'

/**
 * Discovers and loads the user-defined "user layer" of agent instructions.
 * Двухуровневая иерархия (вдохновлено OpenCode instruction hierarchy):
 *   1. ГЛОБАЛЬНЫЙ слой — ~/.verstak/RULES.md (правила на ВСЕ проекты пользователя).
 *   2. ПРОЕКТНЫЙ слой — первый из кандидатов в корне проекта (first match wins):
 *        AGENTS.md → CLAUDE.md → GEMINI.md → .verstak/RULES.md
 * Глобальный идёт первым (с маркером источника), затем проектный. Оба капятся,
 * склейка обрезается до общего лимита.
 *
 * The user layer EXTENDS the system layer; it cannot override the protocol.
 * The combined prompt is built by `composeSystemPrompt`.
 */

const CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.verstak/RULES.md']
const MAX_BYTES = 64 * 1024  // 64 KB safety cap for user layer

export interface UserLayer {
  /** File the layer was loaded from, or null if nothing matched. */
  path: string | null
  /** Raw markdown content; empty string if nothing loaded. */
  content: string
}

/** Прочитать файл, если он есть и не превышает cap. Иначе null. */
async function readCappedFile(abs: string): Promise<string | null> {
  try {
    const st = await stat(abs)
    if (!st.isFile() || st.size > MAX_BYTES) return null
    return await readFile(abs, 'utf8')
  } catch {
    return null
  }
}

/**
 * @param projectRoot корень проекта (или null — тогда только глобальный слой)
 * @param globalRulesPath путь к глобальным правилам; по умолчанию ~/.verstak/RULES.md.
 *        Инъектируется для герметичности тестов.
 */
export async function loadUserLayer(
  projectRoot: string | null,
  globalRulesPath: string | null = join(homedir(), '.verstak', 'RULES.md')
): Promise<UserLayer> {
  const globalContent = globalRulesPath ? await readCappedFile(globalRulesPath) : null

  let projPath: string | null = null
  let projContent = ''
  if (projectRoot) {
    for (const rel of CANDIDATES) {
      const c = await readCappedFile(join(projectRoot, rel))
      if (c !== null) { projPath = rel; projContent = c; break }
    }
  }

  if (!globalContent && projPath === null) return { path: null, content: '' }
  // Только проектный слой → отдаём как есть (обратная совместимость).
  if (!globalContent) return { path: projPath, content: projContent }
  // Только глобальный / оба → склейка с маркером, глобальный первым.
  const paths = ['~/.verstak/RULES.md']
  const parts = [`# Глобальные правила (~/.verstak/RULES.md)\n\n${globalContent}`]
  if (projPath !== null) { paths.push(projPath); parts.push(projContent) }
  let content = parts.join('\n\n---\n\n')
  if (content.length > MAX_BYTES) content = content.slice(0, MAX_BYTES)
  return { path: paths.join(' + '), content }
}

const DEFAULT_RULES = `# Verstak Rules

Эти правила читает AI агент при каждой задаче в этом проекте.
Дополни их под свой стек и стиль — система прибавит их к встроенному
протоколу безопасности и поведения.

## Стек

- (опиши: язык, фреймворк, важные библиотеки)

## Стиль кода

- Минимализм: только запрошенное изменение.
- Сохранять существующий стиль, даже если можно иначе.
- Не удалять чужой неиспользуемый код без явной просьбы.

## Тесты

- Перед фиксом бага — тест, воспроизводящий баг.
- Перед фичей — критерий «как поймём что готово».

## Доменные правила

- (добавь правила специфичные для этого проекта)

## Запреты

- Не трогать секреты (.env, .ssh, credentials).
- Не запускать миграции/деплой без явного разрешения.
- Не расширять scope без подтверждения.
`

/**
 * Create a default `.verstak/RULES.md` if no user layer exists in this
 * project. Idempotent: returns false if any of the candidate files is already
 * present. Called on project open.
 */
export async function ensureUserLayer(projectRoot: string): Promise<{ created: boolean; path: string | null }> {
  for (const rel of CANDIDATES) {
    const abs = join(projectRoot, rel)
    try {
      const st = await stat(abs)
      if (st.isFile()) return { created: false, path: rel }
    } catch { /* not present, keep looking */ }
  }
  const target = join(projectRoot, '.verstak', 'RULES.md')
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, DEFAULT_RULES, 'utf8')
    return { created: true, path: '.verstak/RULES.md' }
  } catch {
    return { created: false, path: null }
  }
}
