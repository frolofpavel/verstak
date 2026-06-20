import type { SessionSnapshot } from './session-snapshot'
import { stampDurationOnStreamEnd } from '../lib/response-duration'
import { appendOrStartAssistant, appendThinkingToLastAssistant, appendToLastAssistant } from '../lib/chat-messages'

/** Стрим-событие из main (ai:event) — минимум полей для роутинга в снапшот. */
export interface SnapshotEvent {
  type: string
  text?: unknown
  message?: unknown
  usage?: unknown
  [k: string]: unknown
}

/**
 * Применить стрим-событие к снапшоту сессии — общее ядро роутинга, вынесенное
 * из трёх near-duplicate методов projectStore (applyEventToSession/Chat/Help).
 * Обрабатывает text / thought / done / error / usage поверх messages + usage +
 * stream-таймера. НЕ трогает hasUnread, pending-write/command, info и DB-persist —
 * это варианты конкретных вызывающих (остаются в сторе). Неизвестный тип →
 * снапшот без изменений, чтобы caller добил его своими ветками.
 */
export function applySnapshotEvent(snap: SessionSnapshot, event: SnapshotEvent): SessionSnapshot {
  const t = event.type
  if (t === 'text' && typeof event.text === 'string') {
    return { ...snap, messages: appendOrStartAssistant(snap.messages, event.text) }
  }
  if (t === 'thought' && typeof event.text === 'string') {
    return { ...snap, messages: appendThinkingToLastAssistant(snap.messages, event.text) }
  }
  if (t === 'done' || t === 'error') {
    const messages = (t === 'error' && typeof event.message === 'string')
      ? appendToLastAssistant(snap.messages, `\n\n[Ошибка: ${event.message}]`)
      : snap.messages
    const base = { ...snap, messages }
    return { ...base, ...stampDurationOnStreamEnd(base) }
  }
  if (t === 'usage' && event.usage && typeof event.usage === 'object') {
    const u = event.usage as { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
    return {
      ...snap,
      sessionUsage: {
        inputTokens: snap.sessionUsage.inputTokens + (u.inputTokens ?? 0),
        outputTokens: snap.sessionUsage.outputTokens + (u.outputTokens ?? 0),
        cachedInputTokens: snap.sessionUsage.cachedInputTokens + (u.cachedInputTokens ?? 0),
      },
    }
  }
  return snap
}
