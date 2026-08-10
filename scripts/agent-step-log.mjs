// V2-5 (agent-runtime-v2.md §4) — наблюдаемость шага: одна строка на ход в
// едином формате «шаг · цель · действие · результат · решение · прогресс».
//
// Событий у прогона и без того много (agent_run_events, agent-progress, трейс
// CLI), и новой шины здесь НЕТ по прямому указанию постановки. Не хватало
// другого: одной СОПОСТАВИМОЙ строки. Существующие события отвечают на вопрос
// «что произошло», каждое в своём формате и своём месте; сравнить по ним две
// версии рантайма между собой нельзя — а именно это и требуется, чтобы увидеть,
// где агент буксует, и чем V2 отличается от того, что было.
//
// Поэтому строка одна, поля фиксированы, и главное — в ней есть РЕШЕНИЕ рантайма
// и ПРОГРЕСС хода. Без них лог остаётся перечислением вызовов: видно, что агент
// делал, и не видно, продвинулся ли он и почему цикл поступил так, а не иначе.
//
// Почему .mjs: тот же формат нужен CLI-циклу (scripts/verstak-cli.mjs), который
// исполняется без сборки и без Electron. Десктоп берёт этот же файл через
// electron/ai/step-log.ts. Схема та же, что у V2-3 и V2-4.

const SEP = ' · '
const MAX_ACTIONS = 3

function clip(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

/** Короткий «предмет» вызова: путь или команда, если они есть в аргументах. */
function subject(args) {
  if (!args || typeof args !== 'object') return ''
  const value = args.path ?? args.command ?? args.query ?? args.file
  return typeof value === 'string' && value ? clip(value, 40) : ''
}

function describeActions(calls) {
  const list = Array.isArray(calls) ? calls : []
  if (list.length === 0) return 'без инструментов'
  const shown = list.slice(0, MAX_ACTIONS).map(call => {
    const name = String(call?.name ?? 'unknown')
    const arg = subject(call?.args)
    return arg ? `${name}(${arg})` : name
  })
  const rest = list.length - shown.length
  return rest > 0 ? `${shown.join(', ')} +${rest}` : shown.join(', ')
}

function describeResult(calls) {
  const list = Array.isArray(calls) ? calls : []
  if (list.length === 0) return 'текст'
  const failed = list.filter(call => call?.error)
  if (failed.length === 0) return 'ok'
  const first = clip(failed[0].error, 60)
  return failed.length === list.length ? `ошибка: ${first}` : `частично: ${list.length - failed.length} из ${list.length}, первая ошибка — ${first}`
}

/**
 * Одна строка шага. Поля соответствуют постановке буквально и в этом порядке:
 * шаг · цель · действие · результат · решение · прогресс.
 *
 * @param {{
 *   step: number, budget?: number|null, goal?: string|null,
 *   calls?: Array<{name?: string, args?: unknown, error?: unknown}>,
 *   decision?: string|null, progressed?: boolean, newFacts?: number, staleTurns?: number,
 * }} input
 */
export function formatStepLine(input) {
  const step = input?.budget ? `шаг ${input.step}/${input.budget}` : `шаг ${input?.step ?? 0}`
  const goal = `цель: ${clip(input?.goal, 80) || 'не задана'}`
  const action = `действие: ${describeActions(input?.calls)}`
  const result = `результат: ${describeResult(input?.calls)}`
  const decision = `решение: ${clip(input?.decision, 60) || 'продолжаю'}`
  // Прогресс — не украшение строки, а единственное поле, по которому видно
  // буксование: «нет» подряд и есть тот самый застой, который ловит V2-4.
  const progress = input?.progressed
    ? `прогресс: да (+${Number(input?.newFacts ?? 0)})`
    : `прогресс: нет (${Number(input?.staleTurns ?? 0)} подряд)`
  return [step, goal, action, result, decision, progress].join(SEP)
}
