// ChatSessionLifecycle (фаза 5, срез 3): чистые patch-билдеры переходов чата.
// Единый источник истины «что сбрасывается при переходе» — раньше литералы
// патчей были рукописно продублированы в switchChatSession / newChatSession /
// setProject (две фазы) / closeProject / leaveHelpMode и ДРЕЙФОВАЛИ (задокументированные
// баги: race-класс #3, #8 фоновых чатов, 2.0.1 протечка review/preview/sessionUsage,
// finding 2/3 per-chat checkpoint/preflights). Pure, store-agnostic — как
// session-snapshot.ts: ничего, что замыкается на zustand/window.api/React.
// Поведение 1-в-1: каждый билдер возвращает ровно тот патч, что был inline
// (харнес: tests/store/chat-lifecycle.test.ts).
//
// PerChatState 4.2: каждый билдер дополнительно поддерживает chats (SSOT) —
// chats = chatSnapshots ∪ {активный чат}, а запись активного по построению
// равна top-level bundle-полям (restoreBundle той же базы + chatId/hasUnread).
import type { ChatMessage, ChatSession } from '../types/api'
import {
  emptySessionUsage,
  freshSnapshot,
  restoreBundle,
  type SessionSnapshot,
} from './session-snapshot'

/** Вход в чат БЕЗ снапшота (switchChatSession, ветка «нет восстановления»):
 *  свежий bundle + сброс полей, не входящих в bundle. */
export function buildFreshSwitchPatch(opts: {
  activeChatId: number
  chatSnapshots: Record<number, SessionSnapshot>
}) {
  return {
    ...restoreBundle(freshSnapshot()),
    chatHasMoreBefore: false,
    chatTotalCount: 0,
    activeChatId: opts.activeChatId,
    chatSnapshots: opts.chatSnapshots,
    // 4.2: SSOT = фоновые + активный (свежий, как top-level выше).
    chats: {
      ...opts.chatSnapshots,
      [opts.activeChatId]: { ...restoreBundle(freshSnapshot()), chatId: opts.activeChatId, hasUnread: false },
    },
    openedReviewId: null,
    // Эти поля НЕ входят в bundle (top-level стора) — без явного сброса они
    // утекают от уходящего чата (артефакты/маркеры/preview).
    touchedFiles: {},
    artifacts: [],
    previewArtifactId: null,
  }
}

/** Вход в чат ИЗ снапшота (switchChatSession, ветка восстановления):
 *  bundle из снапшота (вкл. per-chat checkpoint/preflights/subagentRuns —
 *  чужие не утекают, finding 2/3) + сброс non-bundle полей. */
export function buildRestoredSwitchPatch(opts: {
  activeChatId: number
  restored: SessionSnapshot
  chatSnapshots: Record<number, SessionSnapshot>
}) {
  return {
    ...restoreBundle(opts.restored),
    activeChatId: opts.activeChatId,
    chatSnapshots: opts.chatSnapshots,
    // 4.2: активный в SSOT — тот же bundle, что ушёл в top-level; смотрится → hasUnread=false.
    chats: {
      ...opts.chatSnapshots,
      [opts.activeChatId]: { ...restoreBundle(opts.restored), chatId: opts.activeChatId, hasUnread: false },
    },
    openedReviewId: null,
    touchedFiles: {},
    artifacts: [],
    previewArtifactId: null,
  }
}

/** Вход в новосозданный чат (newChatSession). VSK-FIX: chatHasMoreBefore/
 *  chatTotalCount сбрасываем — раньше новый чат наследовал пагинацию истории
 *  уходящего (кнопка «загрузить старое» в пустом чате + врущий счётчик). */
export function buildNewChatPatch(opts: {
  activeChatId: number
  chatSnapshots: Record<number, SessionSnapshot>
  chatSessions: ChatSession[]
}) {
  return {
    ...restoreBundle(freshSnapshot()),
    chatHasMoreBefore: false,
    chatTotalCount: 0,
    chatSessions: opts.chatSessions,
    activeChatId: opts.activeChatId,
    chatSnapshots: opts.chatSnapshots,
    // 4.2: SSOT = фоновые + новый активный (свежий).
    chats: {
      ...opts.chatSnapshots,
      [opts.activeChatId]: { ...restoreBundle(freshSnapshot()), chatId: opts.activeChatId, hasUnread: false },
    },
    touchedFiles: {},
    artifacts: [],
    openedReviewId: null,
    previewArtifactId: null,
  }
}

/** Выход из справки с восстановлением чата из снапшота (leaveHelpMode).
 *  Стрим восстанавливаем ТОЛЬКО если он реально ещё в полёте (inflight) —
 *  иначе залипает баннер «отвечает». */
export function buildLeaveHelpRestorePatch(opts: {
  snap: SessionSnapshot
  chatId: number
  chatSnapshots: Record<number, SessionSnapshot>
  inflight: boolean
}) {
  const streaming = opts.inflight && opts.snap.isStreaming
  return {
    helpMode: false,
    ...restoreBundle(opts.snap),
    isStreaming: streaming,
    streamStartedAt: streaming ? opts.snap.streamStartedAt : null,
    chatSnapshots: opts.chatSnapshots,
    // 4.2: чат вернулся из фона справки — активный в SSOT тождествен top-level.
    chats: {
      ...opts.chatSnapshots,
      [opts.chatId]: {
        ...restoreBundle(opts.snap),
        isStreaming: streaming,
        streamStartedAt: streaming ? opts.snap.streamStartedAt : null,
        chatId: opts.chatId,
        hasUnread: false,
      },
    },
  }
}

/** Полное закрытие проекта (closeProject, 5.3 review P0): нет проекта = чистый
 *  лист. Полный сброс эфемерного состояния сессии/чата; projectList/composerDrafts —
 *  кросс-проектные, не входят сюда. */
export function buildCloseProjectPatch() {
  return {
    path: null,
    tree: [],
    messages: [],
    chatHasMoreBefore: false,
    chatTotalCount: 0,
    isStreaming: false,
    streamStartedAt: null,
    pendingWrites: [],
    pendingCommand: null,
    pendingPlan: null, // #3 plan-gate: проект закрыт → снять модалку плана
    activity: [],
    agentProgress: [],
    preflights: [],
    subagentRuns: [],
    sessionUsage: emptySessionUsage(),
    runningPlanStep: null,
    activeChatId: null,
    chatSessions: [],
    chatSnapshots: {},
    chats: {},
    sessions: {},
    sendOwners: {},
    chatLaneGenerations: {},
    reviews: {},
    openedReviewId: null,
    touchedFiles: {},
    checkpointId: null,
    checkpointMessageId: null,
    artifacts: [],
    resumableRuns: [],
    activePipeline: null,
    activeDevTaskId: null,
    devTask: null,
    helpMode: false,
  }
}

/** Общая форма двух фаз setProject (optimistic до загрузки сессий + финальная
 *  после). Фазы отличаются только messages/chatSessions/activeChatId — раньше
 *  литерал дублировался целиком (дрейф: правка одной фазы, забытая в другой).
 *  chatSnapshots/reviews/artifacts/resumableRuns/activePipeline сбрасываются
 *  при смене проекта всегда (не просачиваются между проектами). */
export function buildSetProjectPatch(opts: {
  path: string
  target: SessionSnapshot
  sessions: Record<string, SessionSnapshot>
  messages: ChatMessage[]
  chatSessions: ChatSession[]
  activeChatId: number | null
}) {
  const { target } = opts
  return {
    path: opts.path,
    tree: [],
    messages: opts.messages,
    chatHasMoreBefore: false,
    chatTotalCount: opts.messages.length,
    isStreaming: target.isStreaming,
    streamStartedAt: target.streamStartedAt,
    pendingWrites: target.pendingWrites,
    pendingCommand: target.pendingCommand,
    activity: target.activity,
    agentProgress: target.agentProgress ?? [],
    sessionUsage: target.sessionUsage,
    runningPlanStep: target.runningPlanStep,
    checkpointId: target.checkpointId,
    checkpointMessageId: target.checkpointMessageId,
    preflights: target.preflights,
    subagentRuns: target.subagentRuns,
    activeView: 'chat' as const,
    chatSessions: opts.chatSessions,
    activeChatId: opts.activeChatId,
    // 4.2: проект сменился — SSOT пересоздаётся от активного чата нового проекта
    // (фоновые чаты старого проекта не переносятся, как и chatSnapshots).
    chats: opts.activeChatId != null
      ? {
          [opts.activeChatId]: {
            ...restoreBundle(target),
            messages: opts.messages,
            chatId: opts.activeChatId,
            hasUnread: false,
          },
        }
      : {},
    sessions: opts.sessions,
    // touchedFiles/artifacts НЕ в bundle — сбрасываем при смене проекта.
    touchedFiles: {},
    // Dev Task Flow: активная задача привязана к чату/проекту.
    activeDevTaskId: null,
    devTask: null,
    // Снапшоты предыдущего проекта не должны просачиваться (SQLite autoincrement
    // ID могут пересечься).
    chatSnapshots: {},
    // Reviews нового проекта подгружаются заново (refreshReviewsFor).
    reviews: {},
    openedReviewId: null,
    artifacts: [],
    // Crash-resume: баннер предыдущего проекта сброшен; перезагрузится отдельно.
    resumableRuns: [],
    // Pipeline: не тащим прогон другого проекта.
    activePipeline: null,
    helpMode: false,
  }
}
