/**
 * next-wave #3 — memory-nudge консолидации. Эпизодические воспоминания (memories)
 * со временем накапливаются и дублируются по смыслу (особенно session-summary). Это
 * шумит recall и распухает БД. У агента НЕТ delete-тулзы — поэтому консолидация =
 * поднять устойчивые факты в долговременную core-память (core_memory_append), а
 * разрозненные эпизодические воспоминания затухнут сами (Эббингауз-decay).
 *
 * Здесь — чистая логика: детектор перекоса (много воспоминаний с одним тегом) + текст
 * мягкого nudge для модели. Инжектится один раз на чат (с кулдауном), как и recall.
 */

export interface ConsolidationNudge {
  tag: string
  count: number
}

/** Порог: ≥ столько воспоминаний с ОДНИМ тегом → есть что консолидировать. */
export const CONSOLIDATE_THRESHOLD = 6

/**
 * Самый «перегруженный» тег (по числу воспоминаний) или null, если ни один не
 * перешагнул порог. Служебные одиночные теги вроде session-N (уникальны на сессию)
 * не накапливаются по одному значению — перекос даёт именно общий тег (session-summary
 * и т.п.). Пустые теги игнорируем.
 */
export function findConsolidationNudge(
  memories: Array<{ tags: string[] }>,
  threshold = CONSOLIDATE_THRESHOLD
): ConsolidationNudge | null {
  const counts = new Map<string, number>()
  for (const m of memories) {
    for (const t of m.tags ?? []) {
      const tag = (t ?? '').trim()
      if (!tag) continue
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  let best: ConsolidationNudge | null = null
  for (const [tag, count] of counts) {
    if (count >= threshold && count > (best?.count ?? 0)) best = { tag, count }
  }
  return best
}

/** Мягкий system-хинт модели: консолидировать в core-память, если уместно. */
export function buildConsolidationHint(nudge: ConsolidationNudge): string {
  return (
    `[system: в памяти проекта накопилось ${nudge.count} воспоминаний с тегом "${nudge.tag}". `
    + `Если среди них есть устойчивые, повторяющиеся факты/решения — консолидируй их в `
    + `долговременную память через core_memory_append (одной краткой записью), разрозненные `
    + `эпизодические воспоминания затухнут сами. Делай это ТОЛЬКО если консолидация реально `
    + `уместна и не мешает текущей задаче; иначе просто игнорируй этот хинт.]`
  )
}
