import type { ChatMessage } from '../types/api'
import type { SessionSnapshot } from './session-snapshot'
import { stampDurationOnStreamEnd } from '../lib/response-duration'

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
    return { ...snap, messages: appendAssistant(snap.messages, event.text) }
  }
  if (t === 'thought' && typeof event.text === 'string') {
    return { ...snap, messages: appendThinking(snap.messages, event.text) }
  }
  if (t === 'done' || t === 'error') {
    const messages = (t === 'error' && typeof event.message === 'string')
      ? appendErrorNote(snap.messages, event.message)
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

/** text: добить последний assistant или создать новый. */
function appendAssistant(messages: ChatMessage[], text: string): ChatMessage[] {
  const msgs = [...messages]
  const last = msgs[msgs.length - 1]
  if (last?.role === 'assistant') {
    msgs[msgs.length - 1] = { ...last, content: last.content + text }
  } else {
    msgs.push({ role: 'assistant', content: text })
  }
  return msgs
}

/** thought: дописать chain-of-thought к последнему assistant (если он есть). */
function appendThinking(messages: ChatMessage[], text: string): ChatMessage[] {
  const msgs = [...messages]
  const last = msgs[msgs.length - 1]
  if (last?.role === 'assistant') {
    msgs[msgs.length - 1] = { ...last, thinking: (last.thinking ?? '') + text }
  }
  return msgs
}

/** error: добавить пометку об ошибке в конец последнего assistant. */
function appendErrorNote(messages: ChatMessage[], message: string): ChatMessage[] {
  const msgs = [...messages]
  const last = msgs[msgs.length - 1]
  if (last?.role === 'assistant') {
    msgs[msgs.length - 1] = { ...last, content: last.content + `\n\n[Ошибка: ${message}]` }
  }
  return msgs
}
