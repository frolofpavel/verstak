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
