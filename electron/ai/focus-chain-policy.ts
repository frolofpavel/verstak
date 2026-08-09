/**
 * V2-1 (agent-runtime-v2.md §4): когда возвращать агенту незакрытый Focus Chain.
 *
 * Прежнее условие жило прямо в runner-api: `turn > 0 && turn % FOCUS_REINJECT_EVERY === 0`
 * при FOCUS_REINJECT_EVERY = DEFAULT_AGENT_TURNS = 8. Цикл прогона идёт turn ∈ 0..7,
 * поэтому модуль восьми внутри дефолтного бюджета недостижим ПО ПОСТРОЕНИЮ: на
 * обычном чат-пути реинжект не случался ни разу за всё время существования механизма.
 * Механизм был построен и мёртв — ровно то, что аудит назвал B3.
 *
 * Здесь правило выражено признаком, а не совпадением константы с номером хода:
 * есть незакрытые пункты И (прошло cadence ходов С ПРОШЛОГО реинжекта ИЛИ между
 * ними была компакция). Компакция вынесена отдельным поводом: она выбрасывает из
 * истории именно то состояние, ради которого Focus Chain и существует.
 */

/** Ходов между реинжектами. Заведомо меньше DEFAULT_AGENT_TURNS — пин стережёт. */
export const FOCUS_REINJECT_EVERY = 4

export interface FocusReinjectInput {
  /** Текущий ход прогона (0-based). */
  turn: number
  /** Ход последнего реинжекта; 0, если реинжекта ещё не было. */
  lastReinjectTurn: number
  /** Есть ли незакрытые пункты в Focus Chain. */
  hasOpenItems: boolean
  /** Была ли компакция истории после последнего реинжекта. */
  compactedSinceReinject: boolean
}

export function shouldReinjectFocus({
  turn,
  lastReinjectTurn,
  hasOpenItems,
  compactedSinceReinject,
}: FocusReinjectInput): boolean {
  // Нечего напоминать — не шумим (и не тратим контекст).
  if (!hasOpenItems) return false
  // Нулевой ход: цель только что поставлена человеком, напоминать нечего.
  if (turn <= 0) return false
  if (compactedSinceReinject) return true
  return turn - lastReinjectTurn >= FOCUS_REINJECT_EVERY
}
