/**
 * Recipe (Этап 4, Блок A) — валидация recipe-блока frontmatter.
 *
 * Чистый модуль без fs/провайдеров: превращает сырой распарсенный frontmatter-
 * объект в типизированный RecipeSpec ЛИБО возвращает undefined (fail-soft) — тогда
 * скилл остаётся обычным скиллом. Правило: любое структурное отклонение → undefined,
 * а не частично-битый рецепт. Обязательный минимум валидного рецепта — id + хотя бы
 * один ИЗВЕСТНЫЙ шаг; остальные поля деградируют до пустых/undefined, но не роняют.
 *
 * renderRecipeProtocol (инъекция протокола в system prompt) появится в Блоке C —
 * здесь его намеренно нет, чтобы Блок A не тянул неиспользуемый код.
 */

import type { RecipeSpec, RecipeStep, RecipeCompensation } from './types'

const KNOWN_STEPS: ReadonlySet<string> = new Set<RecipeStep>([
  'inspect_error',
  'locate_files',
  'read_context',
  'propose_patch',
  'apply_patch',
  'run_verify',
  'run_tests',
  'review',
  'summarize',
])

const TOOL_MODES: ReadonlySet<string> = new Set(['native', 'json'])
const EDIT_STRATEGIES: ReadonlySet<string> = new Set(['patch', 'search-replace', 'whole-file'])
const PROMPT_STYLES: ReadonlySet<string> = new Set(['strict-json', 'terse', 'stepwise'])

/** Массив непустых строк из произвольного значения. Не-массив/не-строки отбрасываются. */
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(s => s.trim())
}

function parseVerify(v: unknown): { commands: string[] } | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const commands = asStringArray((v as Record<string, unknown>).commands)
  return commands.length > 0 ? { commands } : undefined
}

function parseReviewer(v: unknown): { required: boolean } | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const required = (v as Record<string, unknown>).required
  if (typeof required !== 'boolean') return undefined
  return { required }
}

function parseCompensation(v: unknown): RecipeCompensation | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const r = v as Record<string, unknown>
  const out: RecipeCompensation = {}
  if (typeof r.toolMode === 'string' && TOOL_MODES.has(r.toolMode)) out.toolMode = r.toolMode as RecipeCompensation['toolMode']
  if (typeof r.editStrategy === 'string' && EDIT_STRATEGIES.has(r.editStrategy)) out.editStrategy = r.editStrategy as RecipeCompensation['editStrategy']
  if (typeof r.promptStyle === 'string' && PROMPT_STYLES.has(r.promptStyle)) out.promptStyle = r.promptStyle as RecipeCompensation['promptStyle']
  const knownIssues = asStringArray(r.knownIssues)
  if (knownIssues.length > 0) out.knownIssues = knownIssues
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Fail-soft парсинг recipe-блока. undefined = блока нет ИЛИ он невалиден
 * (скилл в обоих случаях остаётся обычным скиллом).
 */
export function parseRecipe(raw: unknown): RecipeSpec | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>

  const id = typeof r.id === 'string' ? r.id.trim() : ''
  if (!id) return undefined

  // Известные шаги — неизвестные молча отбрасываем. Нет ни одного валидного шага →
  // рецепт бессмыслен, деградируем до обычного скилла.
  const steps = asStringArray(r.steps).filter((s): s is RecipeStep => KNOWN_STEPS.has(s))
  if (steps.length === 0) return undefined

  const kind = typeof r.kind === 'string' && r.kind.trim() ? r.kind.trim() : 'coding'
  const verify = parseVerify(r.verify)
  const reviewer = parseReviewer(r.reviewer)
  const compensation = parseCompensation(r.compensation)

  return {
    id,
    kind,
    trigger: asStringArray(r.trigger),
    read_set: asStringArray(r.read_set),
    steps,
    stop: asStringArray(r.stop),
    ...(verify ? { verify } : {}),
    ...(reviewer ? { reviewer } : {}),
    ...(compensation ? { compensation } : {}),
  }
}

// --- Блок C: рендер протокола recipe и наслоение на skill-промпт ---

/** Человекочитаемое описание каждого шага для инструкции модели. */
const STEP_TEXT: Record<RecipeStep, string> = {
  inspect_error: 'Изучи точный текст ошибки/симптома (код, файл, строка) — не гадай о причине.',
  locate_files: 'Найди конкретные файлы и места, которых касается задача.',
  read_context: 'Прочитай найденные файлы и связанный контекст ПЕРЕД правкой.',
  propose_patch: 'Сформулируй минимальный патч; не расширяй scope.',
  apply_patch: 'Примени патч точечно, сохраняя стиль вокруг.',
  run_verify: 'Прогони верификацию и добейся зелёного результата.',
  run_tests: 'Прогони релевантные тесты и убедись, что они проходят по правильной причине.',
  review: 'Пройди независимое ревью изменений (review_before_commit) перед завершением.',
  summarize: 'Кратко объясни, что и почему изменил (diff в 1-2 строки).',
}

/**
 * Рендерит recipe в жёсткий workflow-протокол для system prompt. Чистая функция —
 * никакого fs/провайдеров. `profile` (forward-compat, Блок G) — per-model
 * compensation: если задан, его поля имеют приоритет над recipe.compensation.
 */
export function renderRecipeProtocol(recipe: RecipeSpec, profile?: RecipeCompensation): string {
  const L: string[] = []
  L.push(`<!-- recipe_protocol: ${recipe.id} -->`)
  L.push(`## Рабочий протокол задачи (recipe: ${recipe.id})`)
  L.push('Работай по этому жёсткому пошаговому протоколу, а не в свободном агентном режиме. Соблюдай порядок шагов и границы охвата — это важнее скорости.')

  if (recipe.read_set.length > 0) {
    L.push('\n### Контекст (read_set) — читай только релевантное из:')
    for (const g of recipe.read_set) L.push(`- ${g}`)
    L.push('Не выходи за пределы read_set без явной необходимости.')
  } else {
    L.push('\n### Контекст: читай только файлы, прямо относящиеся к задаче. Не расширяй охват.')
  }

  L.push('\n### Шаги (строго по порядку):')
  recipe.steps.forEach((s, i) => L.push(`${i + 1}. ${STEP_TEXT[s]}`))

  if (recipe.verify && recipe.verify.commands.length > 0) {
    L.push('\n### Верификация (обязательна):')
    for (const c of recipe.verify.commands) L.push(`- \`${c}\``)
    L.push('Задача не выполнена, пока верификация не зелёная. Учитывается baseline: ошибки, существовавшие ДО правки, не блокируют — блокируют только новые.')
  }

  if (recipe.reviewer?.required) {
    L.push('\n### Ревью перед завершением (обязательно):')
    L.push('Вызови инструмент review_before_commit — независимый ревьюер со свежим контекстом проверит diff + описание задачи + вывод verify. Вердикт fail-closed: невалидный/пустой JSON, confidence < 0.7, ревьюер не осмотрел diff или обязательная verify не запускалась = FAIL. Не завершай задачу без прохождения гейта.')
  }

  if (recipe.stop.length > 0) {
    L.push('\n### Готово, когда выполнено ВСЁ:')
    for (const x of recipe.stop) L.push(`- ${x}`)
  }

  // Forward-compat: model-compensation. profile перекрывает recipe.compensation.
  const comp = mergeCompensation(recipe.compensation, profile)
  if (comp) {
    if (comp.editStrategy) L.push(`\n### Стратегия правок: предпочитай ${comp.editStrategy}.`)
    if (comp.knownIssues && comp.knownIssues.length > 0) {
      L.push('\n### Известные слабые места модели (учитывай):')
      for (const k of comp.knownIssues) L.push(`- ${k}`)
    }
  }

  L.push('\nГраницы: минимальный патч, никаких несвязанных правок, не глуши ошибки заглушками (any/@ts-ignore/skip тестов) без явной причины.')
  return L.join('\n')
}

function mergeCompensation(base?: RecipeCompensation, over?: RecipeCompensation): RecipeCompensation | undefined {
  if (!base && !over) return undefined
  const merged: RecipeCompensation = { ...(base ?? {}), ...(over ?? {}) }
  const knownIssues = [...(base?.knownIssues ?? []), ...(over?.knownIssues ?? [])]
  if (knownIssues.length > 0) merged.knownIssues = knownIssues
  return Object.keys(merged).length > 0 ? merged : undefined
}

/**
 * Наслаивает recipe-протокол на skill-промпт (main-side glue для инъекции).
 * Нет recipe → возвращает исходный промпт как есть (обычный skill работает как раньше).
 */
export function applyRecipeToSkillPrompt(
  skillPrompt: string | null | undefined,
  recipe: RecipeSpec | undefined,
  profile?: RecipeCompensation,
): string | null | undefined {
  if (!recipe) return skillPrompt
  const protocol = renderRecipeProtocol(recipe, profile)
  if (!skillPrompt) return protocol
  return `${skillPrompt}\n\n${protocol}`
}
