import type { ChatMessage } from './types'

/**
 * Сборка истории для модели с учётом persistent context snapshot — срез 2.0.11-B.
 *
 * Что делает: берёт полную переписку и активный снапшот, и отдаёт модели СЖАТУЮ версию —
 * summary отдельным блоком плюс сообщения ПОСЛЕ границы (карточка B п.6).
 *
 * Чего НЕ делает: не трогает то, что видит человек. Здесь строится только payload запроса;
 * строки чата остаются как есть. Это разделение и есть главная защита: испортить сжатием
 * переписку невозможно.
 */

export interface HistoryMessage extends ChatMessage {
  /** id строки чата. Нужен, чтобы отрезать по границе снапшота. */
  dbId?: number
}

export interface ActiveSnapshot {
  summary: string
  /** До какого сообщения ВКЛЮЧИТЕЛЬНО summary покрывает историю. */
  throughMessageId: number
}

/** Как summary попадает в запрос: отдельным блоком, честно помеченным. */
export function summaryBlock(summary: string): ChatMessage {
  return {
    role: 'user',
    content: `[Сжатый итог предыдущей части этого чата]\n${summary}\n[Конец сжатого итога. Дальше — сообщения после него.]`,
  }
}

/**
 * История для отправки модели.
 *
 * Без снапшота — переписка как есть (поведение прежнее, ничего не меняется).
 * Со снапшотом — [summary] + всё, что ПОСЛЕ границы.
 *
 * Сообщения без dbId (оптимистичные, ещё не записанные в БД) считаются свежими и всегда
 * попадают в хвост: иначе только что напечатанное человеком исчезло бы из запроса.
 */
export function prepareHistoryForModel(messages: HistoryMessage[], snapshot: ActiveSnapshot | null): ChatMessage[] {
  if (!snapshot || !snapshot.summary.trim()) return messages
  const tail = messages.filter(m => m.dbId == null || m.dbId > snapshot.throughMessageId)
  // Снапшот покрыл всё, а хвоста нет — отдать один summary лучше, чем пустую историю.
  return [summaryBlock(snapshot.summary), ...tail]
}

/**
 * Сколько сообщений реально уходит модели (для честного ContextMeter: показываем эффект
 * сжатия, а не выдуманную экономию).
 */
export function historyStats(messages: HistoryMessage[], snapshot: ActiveSnapshot | null): {
  totalMessages: number
  sentMessages: number
  compacted: boolean
} {
  const prepared = prepareHistoryForModel(messages, snapshot)
  return {
    totalMessages: messages.length,
    sentMessages: prepared.length,
    compacted: !!snapshot && !!snapshot.summary.trim(),
  }
}
