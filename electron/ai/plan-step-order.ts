/**
 * Порядок исполнения шагов плана (§4.4 и §4.5 ТЗ, блок D).
 *
 * ЧТО БЫЛО. Следующий шаг выбирался как `steps.find(s => s.status !== 'done')` —
 * первый не-готовый по порядку. Из этого следовали две вещи, которых ТЗ прямо
 * не хочет:
 *   · шаг, помеченный `failed` или `skipped`, выбирался СНОВА и снова — план
 *     упирался в него навсегда, хотя §4.4 требует «остальные независимые шаги
 *     продолжаются»;
 *   · `dependsOn` не учитывался вовсе: он проверялся только quality-гейтом при
 *     СОЗДАНИИ плана, а на исполнение не влиял — шаг мог начаться раньше того,
 *     от чего зависит.
 *
 * ЧТО ЗДЕСЬ. Чистая логика выбора и итога: без БД, без IPC, без агента —
 * поэтому проверяема прямо и целиком.
 *
 * ОТКАЗ ЧЕЛОВЕКА НЕ ПЕРЕСПРАШИВАЕТСЯ. `skipped` ставится, когда человек отказал
 * в подтверждении ответственного действия (см. `responsible-action.ts`). Такой
 * шаг в очередь НЕ возвращается: иначе отказ превращался бы в бесконечный
 * вопрос. `failed` — другое дело: это техническая неудача, её повтор осмыслен.
 */
import type { PlanStep } from '../storage/plans'

/** Шаг, который можно брать в работу прямо сейчас. */
export type RunnableStep = PlanStep

const isDone = (step: PlanStep) => step.status === 'done'
/** Кандидаты на исполнение: ещё не сделаны и не отвергнуты человеком. */
const isCandidate = (step: PlanStep) => step.status === 'pending' || step.status === 'failed'

/**
 * Готовы ли зависимости шага. Ключи берутся из structured spec; шаг без spec
 * (легаси-план) зависимостей не объявлял — считаем, что их нет.
 *
 * Зависимость, которая провалилась или пропущена, НЕ считается выполненной:
 * зависимый шаг ждёт, а не «идёт по-любому». Это и есть «зависимые ждут».
 */
export function dependenciesReady(step: PlanStep, all: readonly PlanStep[]): boolean {
  const deps = step.spec?.dependsOn ?? []
  if (deps.length === 0) return true
  const byKey = new Map(all.filter(item => item.spec?.key).map(item => [item.spec!.key, item]))
  return deps.every(key => {
    const dep = byKey.get(key)
    // Ссылка на несуществующий ключ — не повод стопорить план: quality-гейт
    // ловит такие графы при создании, а исполнение не должно вставать намертво.
    if (!dep) return true
    return isDone(dep)
  })
}

/**
 * Следующий шаг к исполнению: первый по порядку кандидат, чьи зависимости
 * готовы. Ничего подходящего — null (план дальше сам не поедет).
 */
export function pickNextStep(steps: readonly PlanStep[]): RunnableStep | null {
  for (const step of steps) {
    if (!isCandidate(step)) continue
    if (!dependenciesReady(step, steps)) continue
    return step
  }
  return null
}

export interface PlanProgress {
  done: PlanStep[]
  failed: PlanStep[]
  skipped: PlanStep[]
  /** Шаги, которые ещё можно выполнить (сами или после зависимостей). */
  pending: PlanStep[]
  /** Ждут чужих зависимостей и потому сейчас недоступны. */
  waiting: PlanStep[]
  /** План завершён: брать больше нечего. */
  finished: boolean
}

export function planProgress(steps: readonly PlanStep[]): PlanProgress {
  const done = steps.filter(isDone)
  const failed = steps.filter(s => s.status === 'failed')
  const skipped = steps.filter(s => s.status === 'skipped')
  const pending = steps.filter(s => s.status === 'pending')
  const waiting = steps.filter(s => isCandidate(s) && !dependenciesReady(s, steps))
  return { done, failed, skipped, pending, waiting, finished: pickNextStep(steps) === null }
}

/**
 * Итог плана человеческим языком (§4.5: «что сделано, где результат, что
 * осталось»). Чистая строка — её показывает чат, отправляет агент или пишет
 * журнал; здесь только формулировка по фактам плана.
 */
export function summarizePlan(title: string, steps: readonly PlanStep[]): string {
  const p = planProgress(steps)
  const lines: string[] = [`План «${title}»: ${p.done.length} из ${steps.length} шагов готово.`]

  if (p.done.length > 0) {
    lines.push('', 'Сделано:')
    for (const step of p.done) {
      // «Где результат» — это result шага, если он его записал.
      const where = step.result?.trim()
      lines.push(where ? `· ${step.title} — ${where}` : `· ${step.title}`)
    }
  }
  if (p.skipped.length > 0) {
    lines.push('', 'Пропущено по вашему решению:')
    for (const step of p.skipped) lines.push(`· ${step.title}`)
  }
  if (p.failed.length > 0) {
    lines.push('', 'Не получилось:')
    for (const step of p.failed) {
      const why = step.result?.trim()
      lines.push(why ? `· ${step.title} — ${why}` : `· ${step.title}`)
    }
  }
  const rest = p.pending.filter(step => !p.failed.includes(step))
  if (rest.length > 0) {
    lines.push('', 'Осталось:')
    for (const step of rest) {
      lines.push(p.waiting.includes(step) ? `· ${step.title} (ждёт другие шаги)` : `· ${step.title}`)
    }
  }
  if (p.finished && rest.length === 0 && p.failed.length === 0 && p.skipped.length === 0) {
    lines.push('', 'План выполнен полностью.')
  }
  return lines.join('\n')
}
