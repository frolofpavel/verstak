import type { ChatMessage } from './types'
import { IGNORED_TOOLS_NUDGE } from './tool-mode'

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

/**
 * Как summary попадает в запрос: отдельным блоком, честно помеченным.
 *
 * ФОРМУЛИРОВКА — НЕ КОСМЕТИКА (ревью B #10). Раньше блок обещал: «Дальше — сообщения
 * после него», то есть гарантировал модели непрерывность. Гарантировать её мы не можем:
 * renderer гидрирует чат ОКНОМ последних ~50 сообщений, поэтому в длинном чате между
 * границей итога и хвостом может не хватать сотен сообщений. Дыру создаёт окно, а не
 * сжатие (без итога модель получила бы то же окно) — но обещание превращало «модель не
 * видит середину» в «модель уверена, что ничего не пропущено» и строила ответ на этой лжи.
 *
 * Поэтому: говорим, что было раньше, и НЕ утверждаем, что дальше идёт всё подряд.
 */
export function summaryBlock(summary: string): ChatMessage {
  return {
    role: 'user',
    content: [
      '[Сжатый итог начала этого чата]',
      summary,
      '[Конец итога. Ниже — более поздние сообщения; часть промежуточных может отсутствовать.',
      'Если для ответа нужна деталь, которой нет ни в итоге, ни ниже — скажи об этом, не додумывай.]',
    ].join('\n'),
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
  // Протухшие corrective-nudge из ПРОШЛЫХ прогонов, осевшие в истории чата, продолжали
  // отравлять контекст будущих ходов (модель читала «Ты не вызвал инструмент…» как факт).
  // Вырезаем их из payload'а. ЖИВОЙ in-run nudge сюда НЕ попадает — он добавляется в
  // currentMessages (runner-api) уже ПОСЛЕ сборки payload'а, минуя эту функцию.
  const clean = messages.filter(m => m.content !== IGNORED_TOOLS_NUDGE)
  if (!snapshot || !snapshot.summary.trim()) return clean
  const tail = clean.filter(m => m.dbId == null || m.dbId > snapshot.throughMessageId)
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
