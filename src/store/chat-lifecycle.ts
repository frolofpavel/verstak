// ChatSessionLifecycle (фаза 5, срез 3): чистые patch-билдеры переходов чата.
// Единый источник истины «что сбрасывается при переходе» — раньше литералы
// патчей были рукописно продублированы в switchChatSession / newChatSession /
// setProject (две фазы) / closeProject / leaveHelpMode и ДРЕЙФОВАЛИ (задокументированные
// баги: race-класс #3, #8 фоновых чатов, 2.0.1 протечка review/preview/sessionUsage,
// finding 2/3 per-chat checkpoint/preflights). Pure, store-agnostic — как
// session-snapshot.ts: ничего, что замыкается на zustand/window.api/React.
//
// PerChatState 4.4: хранилище состояния чатов ОДНО — `chats`. Билдеры больше не
// раскладывают bundle по top-level полям и не ведут вторую копию в chatSnapshots;
// переход = смена activeChatId плюс сброс полей, которые в bundle не входят
// (touchedFiles/artifacts/preview/пагинация) и потому утекли бы от уходящего чата.
import type { ChatMessage, ChatSession } from '../types/api'
import {
  freshSnapshot,
  type SessionSnapshot,
} from './session-snapshot'

/** Поля, не входящие в bundle чата: без явного сброса они утекают от уходящего
 *  чата в приходящий (артефакты, маркеры файлов, открытый предпросмотр). */
const nonBundleReset = {
  openedReviewId: null,
  touchedFiles: {},
  artifacts: [],
  previewArtifactId: null,
}

const freshFor = (chatId: number): SessionSnapshot => ({ ...freshSnapshot(), chatId, hasUnread: false })

/** Вход в чат БЕЗ сохранённого состояния (switchChatSession, ветка «нет восстановления»). */
export function buildFreshSwitchPatch(opts: {
  activeChatId: number
  chats: Record<number, SessionSnapshot>
}) {
  return {
    chatHasMoreBefore: false,
    chatTotalCount: 0,
    activeChatId: opts.activeChatId,
    chats: { ...opts.chats, [opts.activeChatId]: freshFor(opts.activeChatId) },
    ...nonBundleReset,
  }
}

/** Вход в чат С сохранённым состоянием (switchChatSession, ветка восстановления):
 *  per-chat checkpoint/preflights/subagentRuns остаются его собственными —
 *  чужие не утекают (finding 2/3). */
export function buildRestoredSwitchPatch(opts: {
  activeChatId: number
  restored: SessionSnapshot
  chats: Record<number, SessionSnapshot>
}) {
  return {
    activeChatId: opts.activeChatId,
    chats: {
      ...opts.chats,
      [opts.activeChatId]: { ...opts.restored, chatId: opts.activeChatId, hasUnread: false },
    },
    ...nonBundleReset,
  }
}

/** Вход в новосозданный чат (newChatSession). VSK-FIX: chatHasMoreBefore/
 *  chatTotalCount сбрасываем — раньше новый чат наследовал пагинацию истории
 *  уходящего (кнопка «загрузить старое» в пустом чате + врущий счётчик). */
export function buildNewChatPatch(opts: {
  activeChatId: number
  chats: Record<number, SessionSnapshot>
  chatSessions: ChatSession[]
}) {
  return {
    chatHasMoreBefore: false,
    chatTotalCount: 0,
    chatSessions: opts.chatSessions,
    activeChatId: opts.activeChatId,
    chats: { ...opts.chats, [opts.activeChatId]: freshFor(opts.activeChatId) },
    ...nonBundleReset,
  }
}

/** Выход из справки с возвратом к проектному чату (leaveHelpMode).
 *  Стрим восстанавливаем ТОЛЬКО если он реально ещё в полёте (inflight) —
 *  иначе залипает баннер «отвечает». */
export function buildLeaveHelpRestorePatch(opts: {
  snap: SessionSnapshot
  chatId: number
  chats: Record<number, SessionSnapshot>
  inflight: boolean
}) {
  const streaming = opts.inflight && opts.snap.isStreaming
  return {
    helpMode: false,
    chats: {
      ...opts.chats,
      [opts.chatId]: {
        ...opts.snap,
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
    chatHasMoreBefore: false,
    chatTotalCount: 0,
    pendingPlan: null, // #3 plan-gate: проект закрыт → снять модалку плана
    activeChatId: null,
    chatSessions: [],
    chats: {},
    sessions: {},
    sendOwners: {},
    chatLaneGenerations: {},
    reviews: {},
    openedReviewId: null,
    touchedFiles: {},
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
 *  Состояние чатов прошлого проекта не переносится: SQLite autoincrement ID
 *  разных проектов пересекаются, и чужой чат подменил бы одноимённый. */
export function buildSetProjectPatch(opts: {
  path: string
  target: SessionSnapshot
  sessions: Record<string, SessionSnapshot>
  messages: ChatMessage[]
  chatSessions: ChatSession[]
  activeChatId: number | null
}) {
  return {
    path: opts.path,
    tree: [],
    chatHasMoreBefore: false,
    chatTotalCount: opts.messages.length,
    activeView: 'chat' as const,
    chatSessions: opts.chatSessions,
    activeChatId: opts.activeChatId,
    chats: opts.activeChatId != null
      ? {
          [opts.activeChatId]: {
            ...opts.target,
            messages: opts.messages,
            chatId: opts.activeChatId,
            hasUnread: false,
          },
        }
      : {},
    sessions: opts.sessions,
    touchedFiles: {},
    // Dev Task Flow: активная задача привязана к чату/проекту.
    activeDevTaskId: null,
    devTask: null,
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
