import type { SessionSnapshot } from './session-snapshot'
import { stampDurationOnStreamEnd } from '../lib/response-duration'
import { appendOrStartAssistant, appendThinkingToLastAssistant, appendToLastAssistant } from '../lib/chat-messages'
import { reduceAgentProgress } from '../lib/agent-progress'

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
  const withProgress = (next: SessionSnapshot): SessionSnapshot => ({
    ...next,
    agentProgress: reduceAgentProgress(next.agentProgress ?? [], event)
  })
  const t = event.type
  if (t === 'text' && typeof event.text === 'string') {
    return withProgress({ ...snap, messages: appendOrStartAssistant(snap.messages, event.text) })
  }
  if (t === 'thought' && typeof event.text === 'string') {
    return withProgress({ ...snap, messages: appendThinkingToLastAssistant(snap.messages, event.text) })
  }
  if (t === 'done' || t === 'error') {
    const messages = (t === 'error' && typeof event.message === 'string')
      ? appendToLastAssistant(snap.messages, `\n\n[Ошибка: ${event.message}]`)
      : snap.messages
    const base = { ...snap, messages }
    return withProgress({ ...base, ...stampDurationOnStreamEnd(base) })
  }
  // command-result → команда зарезолвлена в main ЛЮБЫМ путём (подтверждение/stop/
  // ошибка). Снять pendingCommand этого callId, иначе в Inbox висит ghost-approval
  // на уже завершённую команду (ревью 24.06). Покрывает все callers ядра.
  if (t === 'command-result' && snap.pendingCommand
      && (typeof event.callId !== 'string' || snap.pendingCommand.callId === event.callId)) {
    return withProgress({ ...snap, pendingCommand: null })
  }
  if (t === 'usage' && event.usage && typeof event.usage === 'object') {
    const u = event.usage as { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
    return withProgress({
      ...snap,
      sessionUsage: {
        inputTokens: snap.sessionUsage.inputTokens + (u.inputTokens ?? 0),
        outputTokens: snap.sessionUsage.outputTokens + (u.outputTokens ?? 0),
        cachedInputTokens: snap.sessionUsage.cachedInputTokens + (u.cachedInputTokens ?? 0),
      },
    })
  }
  return withProgress(snap)
}
