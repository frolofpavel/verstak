// Троттлинг crash-resume чекпойнтов (1.9.7 #7).
//
// saveCheckpoint писал полную сериализованную историю loop'а UPSERT'ом на КАЖДОМ
// завершённом turn — O(turns × history) объём записи (десятки-сотни МБ churn за
// длинный прогон) поверх auto/micro-compact. Здесь — чистое решение «писать ли
// чекпойнт сейчас»: skip-if-unchanged (dedup), every-N для длинных прогонов и
// size-cap как backstop против патологического блоба. Resume best-effort: при
// троттлинге теряется максимум everyN-1 последних turn'ов (доиграются повтором).

export interface CheckpointThrottleState {
  lastHash: string
  lastSavedTurn: number
}

export type ThrottleReason = 'first' | 'unchanged' | 'throttled' | 'too-big' | 'changed'

export interface ThrottleDecision {
  save: boolean
  reason: ThrottleReason
  hash: string
}

export interface ThrottleOpts {
  /** С какого turn включается every-N троттлинг (короткие сессии пишут каждый turn). */
  everyNAfter?: number
  /** На длинных прогонах писать не чаще, чем раз в everyN turn'ов. */
  everyN?: number
  /** Размер-cap сериализации: больше — не пишем (backstop против патологии). */
  maxBytes?: number
}

// maxBytes — САНИТАРНЫЙ backstop против абсурдного runaway, НЕ регулятор частоты
// (её держит every-N). Ревью-фикс: 4МБ был слишком мал — сессия на 1M-context
// модели (Gemini/DeepSeek) копит несжатую историю ~4-8МБ JSON ДО срабатывания
// auto-compact, и чекпойнт пропускался → resume терял контекст (регрессия vs
// безусловного save). Именно такие Long Sessions — цель релиза. 32МБ выше любой
// легитимной 1M-истории, но ловит настоящую патологию.
const DEFAULTS: Required<ThrottleOpts> = { everyNAfter: 12, everyN: 3, maxBytes: 32 * 1024 * 1024 }

// Быстрый некриптографический хеш (djb2) для dedup идентичных снапшотов.
export function cheapHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  // Длина в хеш — защищает от коллизий при равной сумме символов.
  return `${(h >>> 0).toString(36)}:${s.length}`
}

/**
 * Решить, писать ли чекпойнт на этом turn. НЕ мутирует state — вызывающий
 * обновляет { lastHash, lastSavedTurn } при save===true.
 *  - unchanged: история идентична прошлому снапшоту → skip.
 *  - too-big: блоб больше maxBytes → skip (backstop; resume для патологии не критичен).
 *  - throttled: длинный прогон (turn>everyNAfter) и с прошлой записи < everyN turn'ов.
 *  - first/changed: пишем.
 */
export function decideCheckpointSave(
  turn: number,
  messagesJson: string,
  prev: CheckpointThrottleState | undefined,
  opts?: ThrottleOpts
): ThrottleDecision {
  const o = { ...DEFAULTS, ...opts }
  const hash = cheapHash(messagesJson)
  if (prev && prev.lastHash === hash) return { save: false, reason: 'unchanged', hash }
  if (messagesJson.length > o.maxBytes) return { save: false, reason: 'too-big', hash }
  if (prev && turn > o.everyNAfter && (turn - prev.lastSavedTurn) < o.everyN) {
    return { save: false, reason: 'throttled', hash }
  }
  return { save: true, reason: prev ? 'changed' : 'first', hash }
}
