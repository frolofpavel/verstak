import type { Database } from 'better-sqlite3'
import { pickBoundary, buildCompactionPrompt, estimateTokens } from './manual-compaction'
import type { CompactableMessage } from './manual-compaction'
import { saveSnapshot, maxMessageId, activeSnapshot } from '../storage/chat-context-snapshots'
import type { ChatContextSnapshot } from '../storage/chat-context-snapshots'

/**
 * Ручная компакция целиком — срез 2.0.11-B.
 *
 * Собирает уже проверенные части в один ход: гейт → граница → summary моделью → запись
 * со стражем гонки. Держим отдельно от IPC, чтобы порядок шагов проверялся тестами, а не
 * глазами в electron.
 *
 * ГЛАВНЫЙ ИНВАРИАНТ (DoD карточки): при ЛЮБОЙ осечке предыдущий контекст остаётся
 * рабочим. Поэтому единственная запись — в самом конце, после успешного summary. Упала
 * модель, пришло новое сообщение, пустой ответ — не пишем ничего и говорим почему.
 */

export interface CompactionDeps {
  /** Сообщения чата в хронологическом порядке (из storage). */
  loadMessages: (chatId: number) => CompactableMessage[]
  /** Вызов модели для summary. Отдельный от основного прогона (карточка B п.4). */
  summarize: (prompt: { system: string; user: string }) => Promise<string>
  /** Идёт ли сейчас стрим в этом чате (runner-shared). */
  hasActiveRun: (chatId: number) => boolean
  now: () => number
  providerId?: string | null
  model?: string | null
}

export type CompactionResult =
  | { ok: true; snapshot: ChatContextSnapshot; compactedCount: number; keptCount: number }
  /** Идёт прогон — сжимать нельзя (увели бы историю из-под работающей модели). */
  | { ok: false; reason: 'busy'; detail: string }
  /** Сжимать нечего: чат пуст или слишком короткий. */
  | { ok: false; reason: 'nothing-to-compact'; detail: string }
  /** Модель не смогла. Активный snapshot не тронут. */
  | { ok: false; reason: 'summary-failed'; detail: string }
  /** Чат пополнился, пока считали summary. Не записали ничего. */
  | { ok: false; reason: 'conflict'; detail: string }

export async function compactChatContext(
  db: Database,
  chatId: number,
  deps: CompactionDeps,
): Promise<CompactionResult> {
  // 1. Гейт. Сжатие под работающим прогоном увело бы историю из-под него на полуслове.
  if (deps.hasActiveRun(chatId)) {
    return { ok: false, reason: 'busy', detail: 'идёт ответ — дождитесь окончания и повторите' }
  }

  const messages = deps.loadMessages(chatId)
  const boundary = pickBoundary(messages)
  if (!boundary.ok) return { ok: false, reason: 'nothing-to-compact', detail: boundary.detail }

  // 2. Фиксируем максимум ДО долгого вызова модели — это и есть страж гонки.
  const sourceMax = maxMessageId(db, chatId)

  // 3. Summary. Всё, что здесь упадёт, не должно стоить пользователю контекста.
  let summary: string
  try {
    summary = await deps.summarize(buildCompactionPrompt(messages, boundary.boundary.throughMessageId))
  } catch (err) {
    return { ok: false, reason: 'summary-failed', detail: err instanceof Error ? err.message : String(err) }
  }
  if (!summary || !summary.trim()) {
    // Пустой ответ модели — тоже осечка. Записать пустой summary = молча стереть
    // начало разговора из контекста, ничего не дав взамен.
    return { ok: false, reason: 'summary-failed', detail: 'модель вернула пустой итог' }
  }

  // 4. Запись. saveSnapshot ещё раз сверит максимум внутри транзакции.
  const before = estimateTokens(messages)
  const after = estimateTokens([
    { content: summary },
    ...messages.filter(m => m.dbId == null || m.dbId > boundary.boundary.throughMessageId),
  ])
  const saved = saveSnapshot(db, {
    chatId,
    summary: summary.trim(),
    throughMessageId: boundary.boundary.throughMessageId,
    sourceMaxMessageId: sourceMax,
    providerId: deps.providerId ?? null,
    model: deps.model ?? null,
    estimatedTokensBefore: before,
    estimatedTokensAfter: after,
  }, deps.now())

  if (!saved.ok) {
    if (saved.reason === 'conflict') {
      return {
        ok: false,
        reason: 'conflict',
        detail: 'во время сжатия пришло новое сообщение — контекст не тронут, попробуйте ещё раз',
      }
    }
    return { ok: false, reason: 'nothing-to-compact', detail: saved.detail }
  }

  return {
    ok: true,
    snapshot: saved.snapshot,
    compactedCount: boundary.boundary.compactedCount,
    keptCount: boundary.boundary.keptCount,
  }
}

/** Состояние контекста чата для ContextMeter — честные факты, без обещаний. */
export function contextState(db: Database, chatId: number, messages: CompactableMessage[]): {
  totalMessages: number
  estimatedTokens: number
  compacted: boolean
  compactedThroughMessageId: number | null
  canCompact: boolean
} {
  const snap = activeSnapshot(db, chatId)
  const boundary = pickBoundary(messages)
  return {
    totalMessages: messages.length,
    estimatedTokens: estimateTokens(messages),
    compacted: !!snap,
    compactedThroughMessageId: snap?.throughMessageId ?? null,
    canCompact: boundary.ok,
  }
}
