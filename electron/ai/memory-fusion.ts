/**
 * Ось 4 #1 — Reciprocal Rank Fusion (RRF) для recall памяти. Сливает несколько
 * РАНЖИРОВАННЫХ каналов (релевантность по FTS5/BM25 + недавность + др.) в единый топ
 * БЕЗ общей шкалы скоров и БЕЗ эмбеддингов — чисто на позициях в списках.
 *
 * Раньше recall был бинарным: релевантные ИЛИ (если пусто) недавние. Теперь блендим:
 * факт и релевантный, и недавний всплывает выше; релевантный-но-старый и недавний-но-
 * нерелевантный оба представлены. Формула: score(d) = Σ_i 1/(k + rank_i(d)), k≈60.
 */

export interface Ranked { id: string }

/**
 * Слить ранжированные каналы по RRF. Элементы матчатся по id. Возвращает единый
 * список, отсортированный по убыванию fused-скора (дедуп по id — первое вхождение).
 */
export function fuseRanks<T extends Ranked>(channels: ReadonlyArray<ReadonlyArray<T>>, k = 60): T[] {
  const score = new Map<string, number>()
  const item = new Map<string, T>()
  for (const channel of channels) {
    channel.forEach((d, idx) => {
      const rank = idx + 1 // 1-based позиция в канале
      score.set(d.id, (score.get(d.id) ?? 0) + 1 / (k + rank))
      if (!item.has(d.id)) item.set(d.id, d)
    })
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => item.get(id)!)
}
