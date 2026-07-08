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
  const agentProgress = reduceAgentProgress(snap.agentProgress ?? [], event)
  const baseSnap = agentProgress === snap.agentProgress ? snap : { ...snap, agentProgress }
  const t = event.type
  if (t === 'text' && typeof event.text === 'string') {
    return { ...baseSnap, messages: appendOrStartAssistant(baseSnap.messages, event.text) }
  }
  if (t === 'thought' && typeof event.text === 'string') {
    return { ...baseSnap, messages: appendThinkingToLastAssistant(baseSnap.messages, event.text) }
  }
  if (t === 'done' || t === 'error') {
    const messages = (t === 'error' && typeof event.message === 'string')
      ? appendToLastAssistant(baseSnap.messages, `\n\n[Ошибка: ${event.message}]`)
      : baseSnap.messages
    const base = { ...baseSnap, messages }
    return { ...base, ...stampDurationOnStreamEnd(base) }
  }
  // command-result → команда зарезолвлена в main ЛЮБЫМ путём (подтверждение/stop/
  // ошибка). Снять pendingCommand этого callId, иначе в Inbox висит ghost-approval
  // на уже завершённую команду (ревью 24.06). Покрывает все callers ядра.
  if (t === 'command-result' && baseSnap.pendingCommand
      && (typeof event.callId !== 'string' || baseSnap.pendingCommand.callId === event.callId)) {
    return { ...baseSnap, pendingCommand: null }
  }
  if (t === 'usage' && event.usage && typeof event.usage === 'object') {
    const u = event.usage as { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
    return {
      ...baseSnap,
      sessionUsage: {
        inputTokens: baseSnap.sessionUsage.inputTokens + (u.inputTokens ?? 0),
        outputTokens: baseSnap.sessionUsage.outputTokens + (u.outputTokens ?? 0),
        cachedInputTokens: baseSnap.sessionUsage.cachedInputTokens + (u.cachedInputTokens ?? 0),
      },
    }
  }
  return baseSnap
}
