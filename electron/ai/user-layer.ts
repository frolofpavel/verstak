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

export const PROJECT_RULE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.verstak/RULES.md'] as const
type ProjectRuleCandidate = typeof PROJECT_RULE_CANDIDATES[number]
const MAX_BYTES = 64 * 1024  // 64 KB safety cap for user layer

export interface UserLayer {
  /** File the layer was loaded from, or null if nothing matched. */
  path: string | null
  /** Raw markdown content; empty string if nothing loaded. */
  content: string
  /**
   * Проектные файлы правил, которые СУЩЕСТВУЮТ (readCappedFile !== null), но НЕ
   * были взяты: first-match-wins берёт только первый по PROJECT_RULE_CANDIDATES.
   * Пустой массив, когда конфликта нет (файл один или его нет) — контроль тишины.
   * Нужен, чтобы прогон предупредил: человек мог писать правила в файл, который
   * продукт молча игнорирует. Опционально ради обратной совместимости с местами,
   * что конструируют UserLayer-литералы вручную (loadUserLayer заполняет всегда).
   */
  ignored?: string[]
}

export interface RuleSourceStatus {
  id: string
  label: string
  path: string
  absPath: string
  exists: boolean
  active: boolean
  scope: 'global' | 'project'
  size: number | null
  tooLarge: boolean
}

export interface UserLayerStatus {
  activePath: string | null
  global: RuleSourceStatus
  project: RuleSourceStatus[]
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
  // Проектные файлы правил, которые есть в проекте, но проиграли first-match-wins.
  const ignored: string[] = []
  if (projectRoot) {
    for (const rel of PROJECT_RULE_CANDIDATES) {
      const c = await readCappedFile(join(projectRoot, rel))
      if (c === null) continue
      // НЕ прерываем цикл на первом (как раньше `break`): досматриваем остальных,
      // чтобы собрать существующие-но-проигнорированные. Приоритет НЕ меняется —
      // активным остаётся первый найденный.
      if (projPath === null) { projPath = rel; projContent = c }
      else ignored.push(rel)
    }
  }

  if (!globalContent && projPath === null) return { path: null, content: '', ignored }
  // Только проектный слой → отдаём как есть (обратная совместимость).
  if (!globalContent) return { path: projPath, content: projContent, ignored }
  // Только глобальный / оба → склейка с маркером, глобальный первым.
  const paths = ['~/.verstak/RULES.md']
  const parts = [`# Глобальные правила (~/.verstak/RULES.md)\n\n${globalContent}`]
  if (projPath !== null) { paths.push(projPath); parts.push(projContent) }
  let content = parts.join('\n\n---\n\n')
  if (content.length > MAX_BYTES) content = content.slice(0, MAX_BYTES)
  return { path: paths.join(' + '), content, ignored }
}

/**
 * Предупреждение о конфликте файлов правил проекта. ПОВЕДЕНИЕ (что предупреждаем и
 * когда) закреплено здесь. ФОРМУЛИРОВКА утверждена Павлом 07.08 (задача B) — НЕ
 * «улучшать» при правках: два коротких факта, без капса/эмодзи, одно мягкое
 * действие в конце, ни слова о самом продукте. Разделитель « · », потому что
 * compactProgressText (runner-progress.ts) схлопывает переносы строк в пробелы —
 * многострочный detail в ленте всё равно стал бы одной строкой. Возвращает null,
 * когда предупреждать не о чем (0 или 1 файл правил) — контрольный случай тишины.
 *
 * @param activePath активный источник правил (может включать глобальный слой:
 *        например `~/.verstak/RULES.md + AGENTS.md`) — то, что РЕАЛЬНО читается.
 * @param ignored существующие-но-проигнорированные проектные файлы (UserLayer.ignored).
 */
export function buildRuleConflictWarning(
  activePath: string | null,
  ignored: string[] | undefined
): { title: string; detail: string } | null {
  if (!ignored || ignored.length === 0) return null
  const active = activePath ?? '(нет активного файла)'
  return {
    title: 'Правила читаются из одного файла',
    detail: `Применяю: ${active} · Не читаются: ${ignored.join(', ')} · `
      + `Если правила писались в один из них — перенеси их в активный файл.`
  }
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
  for (const rel of PROJECT_RULE_CANDIDATES) {
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

async function inspectRuleSource(input: {
  id: string
  label: string
  path: string
  absPath: string
  scope: 'global' | 'project'
  active: boolean
}): Promise<RuleSourceStatus> {
  try {
    const st = await stat(input.absPath)
    const exists = st.isFile()
    return {
      ...input,
      exists,
      size: exists ? st.size : null,
      tooLarge: exists && st.size > MAX_BYTES,
      active: input.active && exists && st.size <= MAX_BYTES
    }
  } catch {
    return { ...input, exists: false, size: null, tooLarge: false, active: false }
  }
}

export async function inspectUserLayer(
  projectRoot: string | null,
  globalRulesPath: string = join(homedir(), '.verstak', 'RULES.md')
): Promise<UserLayerStatus> {
  let activeProjectPath: ProjectRuleCandidate | null = null
  if (projectRoot) {
    for (const rel of PROJECT_RULE_CANDIDATES) {
      const c = await readCappedFile(join(projectRoot, rel))
      if (c !== null) { activeProjectPath = rel; break }
    }
  }

  const globalExists = await readCappedFile(globalRulesPath)
  const global = await inspectRuleSource({
    id: 'global',
    label: 'Глобальные правила',
    path: '~/.verstak/RULES.md',
    absPath: globalRulesPath,
    scope: 'global',
    active: globalExists !== null
  })

  const project: RuleSourceStatus[] = []
  if (projectRoot) {
    for (const rel of PROJECT_RULE_CANDIDATES) {
      project.push(await inspectRuleSource({
        id: rel,
        label: rel,
        path: rel,
        absPath: join(projectRoot, rel),
        scope: 'project',
        active: rel === activeProjectPath
      }))
    }
  }

  const active: string[] = []
  if (global.active) active.push(global.path)
  if (activeProjectPath) active.push(activeProjectPath)
  return { activePath: active.length ? active.join(' + ') : null, global, project }
}
