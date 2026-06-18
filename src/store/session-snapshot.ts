import type { ChatMessage } from '../types/api'

// Pure, store-agnostic building blocks вынесены из projectStore.ts:
// типы одной сессии/чата + фабрика пустого снапшота + touch-marker данные.
// Здесь НЕТ ничего, что замыкается на zustand set/get, window.api или React —
// только декларации и чистые значения. projectStore импортирует их обратно.

export interface PendingWrite {
  callId: string
  path: string
  before: string
  after: string
  /** sendId of the ai:send that produced this write — used for strict
   *  resolveWrite lookup in main (avoids endsWith-based collisions). */
  sendId?: number
}

export interface PendingCommand {
  callId: string
  command: string
  /** sendId for strict resolve lookup. */
  sendId?: number
}

export interface ActivityEntry {
  id: string
  kind: 'read' | 'list' | 'write' | 'command' | 'blocked'
  label: string
  detail?: string
  status: 'pending' | 'ok' | 'rejected' | 'error' | 'blocked'
  timestamp: number
}

export type TouchKind = 'read' | 'write' | 'list'
export const TOUCH_PRIORITY: Record<TouchKind, number> = { write: 3, read: 2, list: 1 }

export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
}

export interface RunningPlanStep {
  planId: number
  stepId: number
  title: string
}

export interface SessionSnapshot {
  messages: ChatMessage[]
  isStreaming: boolean
  pendingWrites: PendingWrite[]
  pendingCommand: PendingCommand | null
  activity: ActivityEntry[]
  sessionUsage: SessionUsage
  runningPlanStep: RunningPlanStep | null
  /** True when bg session got new content since user last viewed it. */
  hasUnread: boolean
}

export function freshSnapshot(): SessionSnapshot {
  return {
    messages: [],
    isStreaming: false,
    pendingWrites: [],
    pendingCommand: null,
    activity: [],
    sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    runningPlanStep: null,
    hasUnread: false
  }
}

/** Набор полей одного чата, путешествующих вместе при уходе в фон / возврате.
 *  Это SessionSnapshot без hasUnread — тот же набор держит top-level стора для
 *  активного чата. Единый источник истины формы «состояние одного чата». */
export type ChatStateBundle = Omit<SessionSnapshot, 'hasUnread'>

/** Снять bundle активного чата в снапшот (уход в фон). hasUnread=false —
 *  пользователь только что его смотрел. Заменяет 3 рукописные копии литерала
 *  bundle в setProject / switchChatSession / newChatSession (источник #8/#17:
 *  «забыли поле в одной из копий»). */
export function captureBundle(s: ChatStateBundle): SessionSnapshot {
  return {
    messages: s.messages,
    isStreaming: s.isStreaming,
    pendingWrites: s.pendingWrites,
    pendingCommand: s.pendingCommand,
    activity: s.activity,
    sessionUsage: s.sessionUsage,
    runningPlanStep: s.runningPlanStep,
    hasUnread: false
  }
}

/** Развернуть снапшот обратно в top-level поля активного чата (восстановление
 *  из фона). Обратная к captureBundle — отбрасывает hasUnread. */
export function restoreBundle(snap: SessionSnapshot): ChatStateBundle {
  return {
    messages: snap.messages,
    isStreaming: snap.isStreaming,
    pendingWrites: snap.pendingWrites,
    pendingCommand: snap.pendingCommand,
    activity: snap.activity,
    sessionUsage: snap.sessionUsage,
    runningPlanStep: snap.runningPlanStep
  }
}

/** «leaveChat»: положить активный чат в фон. Возвращает новую копию карты
 *  снапшотов с активным чатом, снятым в bundle. No-op (свежая копия без
 *  изменений), если активного чата нет или переключаемся на него же. Единый
 *  путь ухода для switchChatSession + newChatSession (раньше — две копии
 *  одного if + literal). */
export function backgroundActiveChat(
  snapshots: Record<number, SessionSnapshot>,
  activeChatId: number | null,
  movingToId: number | null,
  active: ChatStateBundle
): Record<number, SessionSnapshot> {
  const next = { ...snapshots }
  if (activeChatId != null && activeChatId !== movingToId) {
    next[activeChatId] = captureBundle(active)
  }
  return next
}
