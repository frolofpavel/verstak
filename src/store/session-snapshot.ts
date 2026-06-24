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

/** Preflight-карточка: агент объявил план перед сложной/деструктивной задачей.
 *  Эфемерное в рамках чата — чистится на новом send (как activity), но путешествует
 *  с чатом при уходе в фон / возврате (входит в bundle). */
export interface PreflightCard {
  callId: string
  summary: string
  affectedZones: string[]
  risk: 'low' | 'medium' | 'high'
  riskReason: string
  verifyAfter: string[]
  outOfScope: string[]
}

/** Sub-agent run card (fan-out V1): delegate_task делегировал подзадачу.
 *  Эфемерное в рамках чата — чистится на новом send как preflights. Upsert по
 *  callId (running → done/error). Входит в bundle (per-chat). */
export interface SubagentRunCard {
  callId: string
  label: string
  provider?: string
  skill?: string
  task: string
  status: 'running' | 'done' | 'error'
  result?: string
  role?: string
  /** Сколько tool-вызовов выполнил субагент (Фаза 1 — субы используют tools). */
  toolCount?: number
}

export interface SessionSnapshot {
  messages: ChatMessage[]
  isStreaming: boolean
  /** Когда начался текущий прогон ассистента (для live-таймера). */
  streamStartedAt: number | null
  pendingWrites: PendingWrite[]
  pendingCommand: PendingCommand | null
  activity: ActivityEntry[]
  sessionUsage: SessionUsage
  runningPlanStep: RunningPlanStep | null
  /** Undo entry ID точки «📍 Чекпоинт» этого чата — кнопка отката. Per-chat:
   *  раньше зануляли на restore (anti-leak), из-за чего кнопка отката пропадала
   *  при переключении чатов. Теперь носим в bundle → сохраняется per-chat, при
   *  этом чужой checkpoint не утекает (каждый чат восстанавливает свой). */
  checkpointId: number | null
  /** Эфемерные карточки активности чата — путешествуют с ним (per-chat). */
  preflights: PreflightCard[]
  subagentRuns: SubagentRunCard[]
  /** True when bg session got new content since user last viewed it. */
  hasUnread: boolean
}

export interface InboxApproval {
  chatId: number
  command: PendingCommand
}

/**
 * T1.3 Inbox: все ожидающие подтверждения команды по ВСЕМ чатам (активный +
 * фоновые снапшоты) одним списком. Раньше approval фонового чата был не виден,
 * пока не переключишься в него — агент в фоне молча ждал. Resolve работает по
 * callId+sendId (ai:resolve-command), т.е. одобрять можно не заходя в чат.
 */
export function selectInboxApprovals(state: {
  activeChatId: number | null
  pendingCommand: PendingCommand | null
  chatSnapshots: Record<number, Pick<SessionSnapshot, 'pendingCommand'>>
}): InboxApproval[] {
  const out: InboxApproval[] = []
  if (state.pendingCommand && state.activeChatId != null) {
    out.push({ chatId: state.activeChatId, command: state.pendingCommand })
  }
  for (const [id, snap] of Object.entries(state.chatSnapshots)) {
    if (snap?.pendingCommand) out.push({ chatId: Number(id), command: snap.pendingCommand })
  }
  return out
}

export function freshSnapshot(): SessionSnapshot {
  return {
    messages: [],
    isStreaming: false,
    streamStartedAt: null,
    pendingWrites: [],
    pendingCommand: null,
    activity: [],
    sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    runningPlanStep: null,
    checkpointId: null,
    preflights: [],
    subagentRuns: [],
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
    streamStartedAt: s.streamStartedAt,
    pendingWrites: s.pendingWrites,
    pendingCommand: s.pendingCommand,
    activity: s.activity,
    sessionUsage: s.sessionUsage,
    runningPlanStep: s.runningPlanStep,
    checkpointId: s.checkpointId,
    preflights: s.preflights,
    subagentRuns: s.subagentRuns,
    hasUnread: false
  }
}

/** Развернуть снапшот обратно в top-level поля активного чата (восстановление
 *  из фона). Обратная к captureBundle — отбрасывает hasUnread. */
export function restoreBundle(snap: SessionSnapshot): ChatStateBundle {
  return {
    messages: snap.messages,
    isStreaming: snap.isStreaming,
    streamStartedAt: snap.streamStartedAt,
    pendingWrites: snap.pendingWrites,
    pendingCommand: snap.pendingCommand,
    activity: snap.activity,
    sessionUsage: snap.sessionUsage,
    runningPlanStep: snap.runningPlanStep,
    checkpointId: snap.checkpointId,
    preflights: snap.preflights,
    subagentRuns: snap.subagentRuns
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
