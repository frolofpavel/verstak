import { create } from 'zustand'
import type { FileNode, ChatMessage, ProjectMeta, ChatSession, DevTask, ResumableRun } from '../types/api'
import { sortProjectsByName } from '../lib/project-sort'
import { isModelValidForProvider } from '../hooks/useProvider'
import type { PromptRouteOverride } from '../../shared/contracts/provider'
import type { InputAccounting } from '../../shared/contracts/usage'
import { isGenericChatTitle, titleFromFirstMessage } from '../lib/chat-session-title'
import { useSkills } from './skillStore'
import {
  freshSnapshot,
  keepStreamingOnlyWhenInflight,
  TOUCH_PRIORITY,
  type PendingWrite,
  type PendingCommand,
  type PendingPlanCard,
  type PlanCreatedCard,
  type ActivityEntry,
  type TouchKind,
  type SessionUsage,
  type RunningPlanStep,
  type SessionSnapshot,
  type PreflightCard,
  type SubagentRunCard
} from './session-snapshot'
import { applySnapshotEvent } from './apply-snapshot-event'
import { applyBundleUpdate, type BundleUpdater } from './chat-bundle-update'
import {
  buildCloseProjectPatch,
  buildFreshSwitchPatch,
  buildLeaveHelpRestorePatch,
  buildNewChatPatch,
  buildRestoredSwitchPatch,
  buildSetProjectPatch,
} from './chat-lifecycle'
import { appendThinkingToLastAssistant, appendToLastAssistant } from '../lib/chat-messages'
import { reduceAgentProgress, upsertAgentProgress, type AgentProgressEntry } from '../lib/agent-progress'
import { createPipelineSlice, type PipelineSlice } from './pipeline-slice'
import { createReviewSlice, type ReviewSlice } from './review-slice'
import { HELP_PROJECT_PATH } from '../lib/help-scope'
import {
  EMPTY_COMPOSER_DRAFT,
  isEmptyComposerDraft,
  pruneComposerDraftsForProject,
  projectChatDraftKey,
  type ComposerDraft,
} from '../lib/composer-drafts'
import { forkPointForMessage } from '../lib/fork-edit'
import { stampDurationOnStreamEnd } from '../lib/response-duration'

// PreflightCard / SubagentRunCard перенесены в session-snapshot.ts (store-agnostic),
// т.к. теперь входят в per-chat bundle. Re-export для существующих импортов (Chat.tsx).
export type { PreflightCard, SubagentRunCard } from './session-snapshot'

export type ViewId = 'chat' | 'tasks' | 'journal' | 'reminders' | 'plan' | 'workflow' | 'calendar' | 'feedback' | 'browser' | 'skills' | 'design' | 'video' | 'inspector' | 'project-rules' | 'memory-gov' | 'agents' | 'tasks-manager' | 'project-map' | 'task' | 'files' | 'decisions' | 'brain' | 'scheduler'

/**
 * Owner для in-flight sendId. Заменил собой 2 параллельных мапа
 * (sendIdToChatId + sendIdToReviewChatId). Единый источник правды снимает
 * класс race-багов: события из main роутятся через ОДИН lookup, не два.
 *
 * - 'chat': обычная переписка в main-чате. ownerId = chat_sessions.id.
 * - 'review': sub-chat ревьюера. parentChatId — какой main-чат он ревьюит.
 */
export type SendOwner =
  | { kind: 'chat'; chatId: number; isHelp?: boolean; projectPath?: string | null; laneGeneration?: number }
  | { kind: 'review'; reviewChatId: number; parentChatId: number }

export interface ProjectState extends PipelineSlice, ReviewSlice {
  path: string | null
  tree: FileNode[]
  chatHasMoreBefore: boolean
  chatTotalCount: number
  /** Preflight-карточки текущей сессии. Эфемерные — чистятся на новом send. */
  /** Sub-agent runs текущей сессии (fan-out V1). Эфемерные — чистятся на send. */
  /** Per-session "the AI has touched these files" map — feeds Sidebar markers
   *  (Gemini Ultra audit: Context Depth Visualizer). Keyed by project-relative
   *  path; value is the highest-priority kind observed. */
  touchedFiles: Record<string, TouchKind>
  /** Undo entry ID at the moment the user pressed "📍 Чекпоинт". Revert-to-
   *  checkpoint pops every entry whose id > this until back at this mark.
   *  Null when no checkpoint set. */
  /** Dev Task Flow (Фаза 2): id активной dev_task текущего чата (или null).
   *  Привязывается при openDevTask, питает бейдж и вкладку «Задача». */
  activeDevTaskId: number | null
  /** Снимок активной dev_task — обновляется refreshDevTask. null если задачи нет. */
  devTask: DevTask | null
  activeView: ViewId
  projectList: ProjectMeta[]
  /** Chat sessions of the active project. */
  chatSessions: ChatSession[]
  /** Currently active chat session id within the project. */
  activeChatId: number | null
  /** 2.0.7-F: маршрут модели на ОДНУ следующую отправку (не меняет дефолт чата).
   *  Сбрасывается после отправки (one-shot) и при switchChatSession (не течёт между чатами). */
  promptRouteOverride: PromptRouteOverride | null
  /** 2.1.3-CD: причина раннего маршрутного стопа (pin/one-shot на удалённый/остывающий/
   *  требующий входа аккаунт). main шлёт её событием id=0 БЕЗ owner'а — до появления
   *  sendId, поэтому обычный роутер событий её не несёт. Диспетчер кладёт сюда (только
   *  для активного чата), send() забирает при sendId<=0 и показывает вместо общего
   *  «провайдер недоступен». Эфемерно: живёт секунды, не персистится. */
  earlyRouteStop: { chatId: number; message: string; at: number } | null
  /** Глобальный чат справки (kind=help) — отдельно от проектов. */
  helpChatId: number | null
  /** Пользователь смотрит экран справки, а не рабочий чат проекта. */
  helpMode: boolean
  /** Состояние справки: сообщения, стрим, активность. */
  help: SessionSnapshot
  /** Per-project session snapshots for backgrounded projects. */
  sessions: Record<string, SessionSnapshot>
  /** Per-chat snapshots within active project — preserve state when switching
   *  between chats so a backgrounded chat's stream isn't lost. */
  chats: Record<number, SessionSnapshot>
  /** Единый реестр in-flight sendId. Раньше было 2 параллельных мапа
   *  (sendIdToChatId + sendIdToReviewChatId), каждый со своим жизненным
   *  циклом — это давало race-баги в роутинге событий. Теперь один источник
   *  правды: каждый sendId привязан к owner'у с известным kind.
   *
   *  See SendOwner type для возможных видов владельцев. */
  sendOwners: Record<number, SendOwner>
  /** Monotonic per-chat lane generation. New send in the same lane invalidates stale owners. */
  chatLaneGenerations: Record<string, number>
  /** Артефакты сгенерированные агентом в активной сессии (generate_html /
   *  generate_docx). Сбрасываются при switchChatSession. */
  artifacts: Array<{ kind: 'html' | 'docx' | 'verification'; filename: string; path: string; sizeBytes: number; ts: number; overall?: 'passed' | 'failed' | 'partial' | 'not_run'; checksPassed?: number; checksTotal?: number }>
  /** Текущий артефакт открытый в preview pane (path как ID). null = закрыт. */
  previewArtifactId: string | null
  /** Crash-resume (P1): зависшие после краха прогоны текущего проекта для баннера
   *  «сессия прервана». Заполняется loadResumableRuns при открытии проекта. */
  resumableRuns: ResumableRun[]
  setProject: (path: string) => Promise<void>
  closeProject: () => void
  refreshProjectList: () => Promise<void>
  updateProjectMeta: (path: string, patch: Partial<Pick<ProjectMeta, 'name' | 'iconPath' | 'hidden' | 'notes' | 'accentColor' | 'notificationsMuted' | 'status'>>) => Promise<ProjectMeta | null>
  removeProject: (path: string, options?: { deleteData?: boolean }) => Promise<{ ok: boolean; error?: string }>
  setActiveView: (v: ViewId) => void
  refreshFileTree: (path?: string | null) => Promise<void>
  loadOlderMessages: () => Promise<void>
  addMessage: (msg: ChatMessage) => void
  /** Вставить сообщение перед последним (обычно — перед стримящим assistant). */
  insertMessageBeforeLast: (msg: ChatMessage) => void
  updateLastAssistant: (text: string) => void
  /** 2.2: one immutable bundle update for all text/thought deltas collected in a frame. */
  appendChatStreamDelta: (chatId: number, text: string, thought: string) => void
  /** Append chain-of-thought text to the last assistant message. Rendered as
   *  a collapsible block, not as part of the visible answer. */
  appendLastAssistantThinking: (text: string) => void
  setStreaming: (v: boolean) => void
  addPendingWrite: (w: PendingWrite) => void
  resolvePendingWrite: (callId: string) => void
  clearPendingWrites: () => void
  setPendingCommand: (c: PendingCommand | null) => void
  /** §10: карточка плана АКТИВНОГО чата. */
  setPendingPlan: (p: PendingPlanCard | null) => void
  /** §10 хвост: карточка КОНКРЕТНОГО чата — событие может прийти по фоновому
   *  прогону, и класть его карточку в активный чат нельзя (там своя работа). */
  setChatPendingPlan: (chatId: number, p: PendingPlanCard | null) => void
  /** §2.3: вернуть карточки согласования из БД после перезапуска/открытия проекта. */
  restorePlanCards: (projectPath: string) => Promise<void>
  /** §10 хвост: снять карточку БЕЗ решения (Stop, Shift+Esc, закрытие проекта) и
   *  освободить удержанный чекпойнт прогона — продолжения уже не будет. */
  dismissPendingPlan: (chatId: number) => void
  /** Аварийные выходы (Shift+Esc, закрытие проекта) — по всем чатам сразу. */
  dismissAllPendingPlans: () => void
  /** Stop прогона: снять карточку ИМЕННО его плана, в каком бы чате она ни висела. */
  dismissPendingPlanForSend: (sendId: number) => void
  /** T1.3 Inbox: снять pendingCommand конкретного чата (активного или фонового
   *  снапшота) — резолв approval из общего Inbox, не заходя в чат. */
  clearChatPendingCommand: (chatId: number) => void
  pushActivity: (entry: ActivityEntry) => void
  updateActivity: (id: string, patch: Partial<ActivityEntry>) => void
  clearActivity: () => void
  setAgentProgress: (entries: AgentProgressEntry[]) => void
  pushAgentProgress: (entry: AgentProgressEntry) => void
  applyAgentProgressEvent: (event: { type: string; [k: string]: unknown }) => void
  /** Добавить preflight-карточку (агент объявил план). */
  pushPreflight: (card: PreflightCard) => void
  /** §7.2: карточка созданного плана в поток КОНКРЕТНОГО чата (событие может
   *  прийти по фоновому прогону). Повторное событие того же плана обновляет
   *  карточку на месте, а не плодит вторую. */
  pushPlanCard: (chatId: number, card: PlanCreatedCard) => void
  /** Upsert sub-agent run card по callId (running → done/error). */
  upsertSubagentRun: (card: SubagentRunCard) => void
  /** Record that the AI just touched a file (read / write / list). Upgrades
   *  the marker if a higher-priority kind is observed. */
  markFileTouched: (path: string, kind: TouchKind) => void
  clearTouchedFiles: () => void
  /** Snap a checkpoint at the current undo head. Subsequent writes can be
   *  rolled back to this mark in one click. */
  setCheckpoint: (id: number | null, msgId?: number | null) => void
  /** Dev Task Flow (Фаза 2): сделать задачу активной (id + снимок) и открыть
   *  вкладку «Задача». */
  openDevTask: (task: DevTask) => void
  /** Перечитать снимок активной dev_task из main (devtask:get). No-op без id. */
  refreshDevTask: () => Promise<void>
  /** Сбросить активную задачу (снимок + id). Вкладку не переключает. */
  closeDevTask: () => void
  addUsage: (delta: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; cacheCreationInputTokens?: number; inputAccounting?: InputAccounting }) => void
  resetUsage: () => void
  setRunningPlanStep: (s: RunningPlanStep | null) => void
  /** Apply an ai:event to a background session (used when projectPath !== current). */
  applyEventToSession: (projectPath: string, event: { type: string; [k: string]: unknown }) => void
  /** Mark a session as read (clear the unread badge). */
  markSessionRead: (projectPath: string) => void
  /** Зарегистрировать in-flight sendId с его владельцем (chat / review).
   *  Единая точка регистрации — все ai:event поступают сюда через lookup. */
  registerSendOwner: (sendId: number, owner: SendOwner) => void
  /** Найти владельца sendId. Используется в Chat.tsx event handler для
   *  роутинга событий (text/done/error в нужный snapshot). */
  lookupSendOwner: (sendId: number) => SendOwner | null
  /** True when the chat/help lane already has a live owner. Used to queue instead of racing. */
  hasActiveChatLane: (chatId: number, isHelp?: boolean) => boolean
  /** Убрать sendId из реестра — обычно при done/error event. */
  forgetSendOwner: (sendId: number) => void
  /** ЕДИНАЯ точка мутации состояния одного чата: патч ложится в chats[chatId]
   *  (записи ещё нет → freshSnapshot). chatId == null = «текущий активный»
   *  (семантика старых экшенов без явного chatId). Все writers идут через неё. */
  updateChatBundle: (chatId: number | null, updater: BundleUpdater) => void
  /** Apply an ai:event to a background chat's record in chats (within the active
   *  project, but not the active chat). */
  applyEventToChat: (chatId: number, event: { type: string; [k: string]: unknown }) => void
  /** Replace the message list of a background CHAT snapshot. Used by SideChat
   *  to seed persisted history on first open without touching the active chat. */
  seedChatSnapshot: (chatId: number, messages: ChatMessage[]) => void
  /** Push a user message + empty assistant placeholder into a background CHAT
   *  snapshot. Used by SideChat's composer — streamed assistant text then lands
   *  via applyEventToChat (text events append to the last assistant message). */
  pushUserToChatSnapshot: (chatId: number, content: string, meta?: Partial<ChatMessage>, assistantDbId?: number) => void
  /** Switch to a different chat session within the active project. */
  switchChatSession: (id: number) => Promise<void>
  /** 2.0.7-F: задать/снять one-shot маршрут модели для следующей отправки. */
  setPromptRouteOverride: (route: PromptRouteOverride | null) => void
  /** 2.1.3-CD: запомнить/снять причину раннего маршрутного стопа (см. earlyRouteStop). */
  setEarlyRouteStop: (stop: { chatId: number; message: string; at: number } | null) => void
  /** Refresh the chat sessions list (after create/rename/delete). */
  refreshChatSessions: () => Promise<void>
  /** Optimistically update a chat-session row without refetching the list.
   *  Used by rename — avoids the stream-disrupting re-render cascade. */
  patchChatSession: (id: number, patch: Partial<ChatSession>) => void
  /** Первое сообщение → осмысленный заголовок вместо «Новый чат» / Parallel chat. */
  autoTitleChatSession: (chatId: number, firstUserText: string) => Promise<void>
  /** Create a new chat session in the active project and switch to it. */
  newChatSession: (title?: string) => Promise<ChatSession | null>
  /** Tier-2 #3 — ветвление: форк сессии (копия истории) + переключение на ветку. */
  forkChat: (sourceId: number) => Promise<ChatSession | null>
  /** 2.0.11-D: правка сообщения через Fork. Форкает историю ДО редактируемого, кладёт его
   *  текст черновиком в ветку (не отправляет), переключает на ветку. Оригинал неизменен,
   *  стрим оригинала не трогается. null — нельзя (нет проекта / не user / нет сообщения). */
  editViaFork: (sourceId: number, messageId: number) => Promise<ChatSession | null>
  /** Открыть глобальный чат справки (скилл verstak-guide). */
  openHelpChat: () => Promise<void>
  /** Выйти из экрана справки в рабочий чат проекта. */
  leaveHelpMode: () => void
  applyEventToHelp: (event: { type: string; [k: string]: unknown }) => void
  markHelpRead: () => void
  setHelpStreaming: (v: boolean) => void
  addHelpMessage: (msg: ChatMessage) => void
  insertHelpMessageBeforeLast: (msg: ChatMessage) => void
  updateHelpLastAssistant: (text: string) => void
  appendHelpLastAssistantThinking: (text: string) => void
  clearHelpActivity: () => void
  pushHelpActivity: (entry: ActivityEntry) => void
  setHelpAgentProgress: (entries: AgentProgressEntry[]) => void
  pushHelpAgentProgress: (entry: AgentProgressEntry) => void
  addHelpUsage: (delta: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; cacheCreationInputTokens?: number; inputAccounting?: InputAccounting }) => void
  /** Зарегистрировать сгенерированный артефакт (для Timeline pill). */
  recordArtifact: (a: { kind: 'html' | 'docx' | 'verification'; filename: string; path: string; sizeBytes: number; overall?: 'passed' | 'failed' | 'partial' | 'not_run'; checksPassed?: number; checksTotal?: number }) => void
  /** Прикрепить DoD-бейдж (overall/N/M) к последнему verification-артефакту. */
  setVerificationBadge: (badge: { overall: 'passed' | 'failed' | 'partial' | 'not_run'; checksPassed: number; checksTotal: number }) => void
  /** Сбросить артефакты (вызывается при смене чата / нового чата). */
  clearArtifacts: () => void
  /** Открыть preview панель для артефакта (по path как ID), или закрыть (null). */
  setPreviewArtifact: (path: string | null) => void
  /** Уровень усилий модели. Влияет на max_tokens / extended thinking. */
  effortLevel: 'quick' | 'standard' | 'deep'
  setEffortLevel: (level: 'quick' | 'standard' | 'deep') => void
  /** Crash-resume: подгрузить зависшие прогоны проекта для баннера. Fire-and-forget. */
  loadResumableRuns: (path: string) => Promise<void>
  reconcileStreamingState: (path: string) => Promise<void>
  /** Crash-resume: отклонить баннер для прогона (убрать из resumableRuns + main). */
  dismissResumableRun: (runId: string) => void
  /** Несохранённые черновики композера (текст + вложения) до выхода из приложения. */
  composerDrafts: Record<string, ComposerDraft>
  setComposerDraft: (key: string, draft: ComposerDraft) => void
  getComposerDraft: (key: string) => ComposerDraft
  clearComposerDraft: (key: string) => void
  /** Зафиксировать длительность ответа и сбросить таймер активного проектного чата. */
  finalizeActiveStreamDuration: () => void
  /** То же для глобальной справки. */
  finalizeHelpStreamDuration: () => void
}

// Monotonic token used by setProject to cancel its own stale concurrent runs.
// If the user clicks project A then project B before A's async work finishes,
// only B's set() should land. We bump on entry, snapshot the value, and bail
// on every await boundary if our token is no longer current.
let setProjectToken = 0
let switchChatSessionToken = 0
// 2.0.11-D reentrancy-гард: правка через Fork в полёте. Двойной клик по «править» без
// него плодил две ветки (одна осиротевшая с черновиком). Снимается в finally.
let editViaForkInFlight = false

export const LAST_PROJECT_PATH_KEY = 'last_project_path'

function hasInflightChatSend(
  sendOwners: ProjectState['sendOwners'],
  chatId: number,
  isHelp: boolean,
  chatLaneGenerations?: ProjectState['chatLaneGenerations']
): boolean {
  return Object.values(sendOwners).some(o => {
    if (o.kind !== 'chat' || !!o.isHelp !== isHelp || o.chatId !== chatId) return false
    if (!chatLaneGenerations || o.laneGeneration == null) return true
    return chatLaneGenerations[chatLaneKey(o.chatId, !!o.isHelp)] === o.laneGeneration
  })
}

function chatLaneKey(chatId: number, isHelp: boolean): string {
  return `${isHelp ? 'help' : 'chat'}:${chatId}`
}

function hasInflightProjectSend(
  sendOwners: ProjectState['sendOwners'],
  projectPath: string
): boolean {
  return Object.values(sendOwners).some(
    o => o.kind === 'chat' && !o.isHelp && o.projectPath === projectPath
  )
}

/**
 * PerChatState 4.4: подготовить chats к уходу активного чата в фон.
 *
 * Раньше здесь снималась копия top-level полей в chatSnapshots (leaveChat). Теперь
 * состояние чата и так лежит в chats — остаётся единственное реальное действие:
 * привести стрим-флаг уходящего к реальности. Без этого фантомный isStreaming
 * (send уже завершён) держал залипший индикатор «отвечает» у фонового чата, а живой
 * in-flight стрим, наоборот, обязан сохраниться — иначе теряется ответ (drift-класс #3).
 */
/** Bundle активного чата. Активного нет — пустой: читателю нужен объект, а не ветвление. */
function activeChatBundle(s: ProjectState): SessionSnapshot {
  return (s.activeChatId != null ? s.chats[s.activeChatId] : undefined) ?? freshSnapshot()
}

function settleLeavingChat(s: ProjectState, movingToId: number | null): Record<number, SessionSnapshot> {
  const leavingId = s.activeChatId
  if (leavingId == null || leavingId === movingToId) return s.chats
  const leaving = s.chats[leavingId]
  if (!leaving) return s.chats
  const inflight = hasInflightChatSend(s.sendOwners, leavingId, false, s.chatLaneGenerations)
  return { ...s.chats, [leavingId]: keepStreamingOnlyWhenInflight(leaving, inflight) }
}

export const useProject = create<ProjectState>((set, get, store) => ({
  path: null,
  tree: [],
  messages: [],
  chatHasMoreBefore: false,
  chatTotalCount: 0,
  isStreaming: false,
  streamStartedAt: null,
  pendingWrites: [],
  pendingCommand: null,
  activity: [],
  agentProgress: [],
  preflights: [],
  subagentRuns: [],
  touchedFiles: {},
  checkpointId: null, checkpointMessageId: null,
  activeDevTaskId: null,
  devTask: null,
  activeView: 'chat',
  sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 },
  runningPlanStep: null,
  projectList: [],
  chatSessions: [],
  activeChatId: null,
  promptRouteOverride: null,
  earlyRouteStop: null,
  helpChatId: null,
  helpMode: false,
  help: freshSnapshot(),
  sessions: {},
  chats: {},
  sendOwners: {},
  chatLaneGenerations: {},
  artifacts: [],
  previewArtifactId: null,
  effortLevel: 'standard',
  resumableRuns: [],
  composerDrafts: {},
  setComposerDraft: (key, draft) => set(s => {
    if (isEmptyComposerDraft(draft)) {
      if (!(key in s.composerDrafts)) return {}
      const next = { ...s.composerDrafts }
      delete next[key]
      return { composerDrafts: next }
    }
    return { composerDrafts: { ...s.composerDrafts, [key]: draft } }
  }),
  getComposerDraft: (key) => get().composerDrafts[key] ?? EMPTY_COMPOSER_DRAFT,
  clearComposerDraft: (key) => get().setComposerDraft(key, EMPTY_COMPOSER_DRAFT),
  finalizeActiveStreamDuration: () => get().updateChatBundle(get().activeChatId, b =>
    stampDurationOnStreamEnd({
      messages: b.messages,
      isStreaming: b.isStreaming,
      streamStartedAt: b.streamStartedAt,
    })
  ),
  finalizeHelpStreamDuration: () => set(s => {
    const stamped = stampDurationOnStreamEnd(s.help)
    return { help: { ...s.help, ...stamped } }
  }),
  setProject: async (path) => {
    const myToken = ++setProjectToken
    const s = get()
    const wasHelp = s.helpMode
    if (wasHelp) get().leaveHelpMode()
    // Вернулись из справки в тот же проект — leaveHelpMode уже восстановил чат.
    if (wasHelp && s.path === path) {
      set({ activeView: 'chat' })
      return
    }
    // 1) Snapshot current session before switching (so background streams keep their state)
    let nextSessions = s.sessions
    if (s.path && s.path !== path) {
      nextSessions = {
        ...s.sessions,
        [s.path]: keepStreamingOnlyWhenInflight(
          activeChatBundle(s),
          hasInflightProjectSend(s.sendOwners, s.path)
        )
      }
    }
    const existing = nextSessions[path]
    let target: SessionSnapshot
    if (existing) {
      // Returning to a backgrounded session — keep its state, clear unread badge
      target = {
        ...keepStreamingOnlyWhenInflight(existing, hasInflightProjectSend(s.sendOwners, path)),
        hasUnread: false
      }
      // Remove from sessions map since it becomes the active one
      const { [path]: _drop, ...rest } = nextSessions
      void _drop
      nextSessions = rest
    } else {
      target = freshSnapshot()
    }

    void window.api.projects.setCurrent(path)
    void window.api.settings.setKey(LAST_PROJECT_PATH_KEY, path)

    const optimisticChatId = target.chatId ?? null
    const optimisticMessages = existing ? target.messages : []
    // Единая форма патча двух фаз setProject — chat-lifecycle.ts (срез 3).
    set(buildSetProjectPatch({
      path,
      target,
      sessions: nextSessions,
      messages: optimisticMessages,
      chatSessions: [],
      activeChatId: optimisticChatId,
    }))

    void window.api.projects.list().then(projectList => {
      if (myToken !== setProjectToken) return
      if (get().path !== path) return
      set({ projectList })
    }).catch(() => { /* project list stays cached */ })

    const chatSessionsRaw = await window.api.chatSessions.list(path)
    if (myToken !== setProjectToken) return

    let chatSessions = chatSessionsRaw
    if (chatSessions.length === 0) {
      const created = await window.api.chatSessions.create(path, { title: 'Основной чат' })
      if (myToken !== setProjectToken) return
      chatSessions = [created]
    }

    const restoredChatId = target.chatId != null && chatSessions.some(c => c.id === target.chatId)
      ? target.chatId
      : null
    const activeChatId = restoredChatId ?? chatSessions[0]?.id ?? null
    const needsDbHydrate = Boolean(
      activeChatId && (!existing || existing.messages.length === 0)
    )
    const initialMessages = needsDbHydrate ? [] : target.messages

    if (myToken !== setProjectToken) return
    // checkpointId/preflights/subagentRuns — per-chat в bundle: восстанавливаем
    // сохранённое для активного чата нового проекта (finding 2/3).
    set(buildSetProjectPatch({
      path,
      target,
      sessions: nextSessions,
      messages: initialMessages,
      chatSessions,
      activeChatId,
    }))
    // §2.3: карточки согласования этого проекта — обратно на экран. Не блокирует
    // открытие проекта: приезжают, когда приедут.
    void get().restorePlanCards(path)
    if (needsDbHydrate && activeChatId != null) {
      const hydrateChatId = activeChatId
      void (async () => {
        const history = await window.api.chats.listWindow(hydrateChatId, { limit: 50 })
        if (myToken !== setProjectToken) return
        const cur = get()
        if (cur.path !== path || cur.activeChatId !== hydrateChatId) return
        // 4.2: messages через единую точку (поддерживает chats SSOT); пагинация
        // вне bundle — отдельным патчем (как в loadOlderMessages).
        get().updateChatBundle(hydrateChatId, () => ({
          messages: history.messages.map(m => ({ role: m.role, content: m.content, thinking: m.thinking, appliedSkills: m.appliedSkills, createdAt: m.createdAt, dbId: m.id })),
        }))
        set({
          chatHasMoreBefore: history.hasMoreBefore,
          chatTotalCount: history.totalCount
        })
      })()
    }

    if (activeChatId != null) {
      void get().refreshReviewsFor(activeChatId)
    }
    // Crash-resume: подгружаем зависшие после краха прогоны этого проекта для
    // баннера «сессия прервана». Fire-and-forget.
    void get().loadResumableRuns(path)
    void get().reconcileStreamingState(path)
    void get().loadActivePipeline(path)
  },
  // 5.3 (review P0): нет проекта = чистый лист. Полный сброс эфемерного
  // состояния сессии/чата — единая форма в chat-lifecycle.ts (срез 3).
  // projectList/composerDrafts — кросс-проектные, не трогаем.
  closeProject: () => {
    // §10 хвост: карточки уходят вместе с проектом, решения по ним не будет —
    // освобождаем удержанные чекпойнты, иначе снапшоты истории висят вечно.
    get().dismissAllPendingPlans()
    set(buildCloseProjectPatch())
  },
  refreshProjectList: async () => {
    const projectList = await window.api.projects.list()
    set({ projectList })
  },
  updateProjectMeta: async (path, patch) => {
    const updated = await window.api.projects.updateMeta(path, patch)
    if (!updated) return null
    set(s => ({
      projectList: sortProjectsByName(s.projectList.map(p => (p.path === path ? updated : p)))
    }))
    return updated
  },
  removeProject: async (path: string, options?: { deleteData?: boolean }) => {
    const result = await window.api.projects.remove(path, options)
    if (!result.ok) return result
    const projectList = await window.api.projects.list()
    const state = get()
    const composerDrafts = pruneComposerDraftsForProject(state.composerDrafts, path)
    if (state.path === path) {
      set({ path: null, tree: [], chatHasMoreBefore: false, chatTotalCount: 0, projectList, activeChatId: null, chatSessions: [], chats: {}, composerDrafts })
    } else {
      set({ projectList, composerDrafts })
    }
    return result
  },
  setActiveView: (v) => {
    set({ activeView: v })
    if (v === 'files') void get().refreshFileTree()
  },
  refreshFileTree: async (projectPath) => {
    const path = projectPath ?? get().path
    if (!path) return
    try {
      const tree = await window.api.files.tree(path)
      if (get().path !== path) return
      set({ tree })
    } catch {
      // The files panel will keep its empty state if the tree cannot be loaded.
    }
  },
  loadOlderMessages: async () => {
    const state = get()
    const chatId = state.activeChatId
    const beforeId = activeChatBundle(state).messages.find(m => typeof m.dbId === 'number')?.dbId
    if (!chatId || !beforeId || !state.chatHasMoreBefore) return
    const result = await window.api.chats.listWindow(chatId, { beforeId, limit: 50 })
    const older = result.messages.map(m => ({ role: m.role, content: m.content, thinking: m.thinking, appliedSkills: m.appliedSkills, createdAt: m.createdAt, dbId: m.id }))
    const existingIds = new Set(activeChatBundle(get()).messages.map(m => m.dbId).filter((id): id is number => typeof id === 'number'))
    const uniqueOlder = older.filter(m => typeof m.dbId !== 'number' || !existingIds.has(m.dbId))
    // PerChatState 4.1: пагинация (chatHasMoreBefore/chatTotalCount) живёт вне
    // bundle — патчится отдельно; messages — через единую точку. Поведение 1-в-1
    // со старым кодом (писал в top-level активного на момент применения чата):
    // известная гонка «loadOlder во время switch чата» здесь НЕ чинится — в план.
    get().updateChatBundle(get().activeChatId, b => ({ messages: [...uniqueOlder, ...b.messages] }))
    set({ chatHasMoreBefore: result.hasMoreBefore, chatTotalCount: result.totalCount })
  },
  addMessage: (msg) => get().updateChatBundle(get().activeChatId, b => ({
    messages: [...b.messages, { ...msg, createdAt: msg.createdAt ?? Date.now() }],
  })),
  insertMessageBeforeLast: (msg) => get().updateChatBundle(get().activeChatId, b => {
    const stamped = { ...msg, createdAt: msg.createdAt ?? Date.now() }
    const msgs = [...b.messages]
    if (msgs.length === 0) return { messages: [stamped] }
    const last = msgs[msgs.length - 1]
    const at = last?.role === 'assistant' ? msgs.length - 1 : msgs.length
    msgs.splice(at, 0, stamped)
    return { messages: msgs }
  }),
  updateLastAssistant: (text) => get().updateChatBundle(get().activeChatId, b => ({ messages: appendToLastAssistant(b.messages, text) })),
  appendChatStreamDelta: (chatId, text, thought) => get().updateChatBundle(chatId, b => {
    let messages = b.messages
    if (thought) messages = appendThinkingToLastAssistant(messages, thought)
    if (text) messages = appendToLastAssistant(messages, text)
    return { messages }
  }),
  appendLastAssistantThinking: (text) => get().updateChatBundle(get().activeChatId, b => ({ messages: appendThinkingToLastAssistant(b.messages, text) })),
  setStreaming: (v) => get().updateChatBundle(get().activeChatId, b => ({
    isStreaming: v,
    streamStartedAt: v ? Date.now() : b.streamStartedAt,
  })),
  addPendingWrite: (w) => get().updateChatBundle(get().activeChatId, b => ({ pendingWrites: [...b.pendingWrites, w] })),
  resolvePendingWrite: (callId) => get().updateChatBundle(get().activeChatId, b => ({ pendingWrites: b.pendingWrites.filter(w => w.callId !== callId) })),
  clearPendingWrites: () => get().updateChatBundle(get().activeChatId, () => ({ pendingWrites: [] })),
  setPendingCommand: (c) => get().updateChatBundle(get().activeChatId, () => ({ pendingCommand: c })),
  setPendingPlan: (p) => get().updateChatBundle(get().activeChatId, () => ({ pendingPlan: p })),
  setChatPendingPlan: (chatId, p) => get().updateChatBundle(chatId, () => ({ pendingPlan: p })),
  /**
   * §2.3: вернуть карточки согласования, потерянные вместе с памятью renderer.
   *
   * Карточку рождало ЖИВОЕ событие прогона, поэтому перезапуск (и закрытие
   * проекта) терял её безвозвратно: план оставался `draft` с удержанным
   * чекпойнтом, а одобрить его было нечем. Состояние всё это время лежало в БД —
   * здесь оно просто читается обратно.
   *
   * Раскладываем ПОКАРТОЧНО в bundle СВОЕГО чата, а не в общую ячейку: иначе
   * вернётся дефект 4 §10 (28.07) — вторая карточка затирала первую, и
   * продолжение уезжало в чужой чат. Живую карточку не трогаем: если в чате уже
   * висит своя, восстановленная её не подменяет.
   */
  restorePlanCards: async (projectPath) => {
    let cards: Array<{ planId: number; chatId: number; title: string; stepCount: number; resumable: boolean }>
    try {
      cards = await window.api.plans.pendingCards(projectPath)
    } catch { return }
    if (get().path !== projectPath) return
    for (const c of cards) {
      if (get().chats[c.chatId]?.pendingPlan) continue
      get().updateChatBundle(c.chatId, () => ({
        pendingPlan: {
          // callId нужен форме карточки; у восстановленной живого вызова нет.
          callId: `restored-${c.planId}`,
          planId: c.planId,
          title: c.title,
          stepCount: c.stepCount,
          resumable: c.resumable,
        },
      }))
    }
  },
  dismissPendingPlan: (chatId) => {
    const card = get().chats[chatId]?.pendingPlan
    if (!card) return
    // Решения не было — статус плана не трогаем, он остаётся в «Планах». Но
    // продолжение запускала карточка, а её больше нет: чекпойнт освобождаем.
    // Мост может отсутствовать (тестовое окружение, ранний teardown) — уборка
    // чекпойнта не повод уронить закрытие проекта.
    void window.api?.plans?.releaseApproval?.(card.planId)?.catch(() => {})
    get().updateChatBundle(chatId, () => ({ pendingPlan: null }))
  },
  dismissAllPendingPlans: () => {
    for (const id of Object.keys(get().chats)) get().dismissPendingPlan(Number(id))
  },
  dismissPendingPlanForSend: (sendId) => {
    for (const [id, snap] of Object.entries(get().chats)) {
      if (snap?.pendingPlan?.sendId === sendId) get().dismissPendingPlan(Number(id))
    }
  },
  clearChatPendingCommand: (chatId) => get().updateChatBundle(chatId, b =>
    b.pendingCommand ? { pendingCommand: null } : null
  ),
  // Дедуп по id: один и тот же tool-call (callId+name) может прийти дважды
  // (повторная доставка события / реплей) — иначе React ловит дубль-key на
  // одинаковых id в стриме активности. Существующий → обновляем на месте.
  pushActivity: (entry) => get().updateChatBundle(get().activeChatId, b => (
    b.activity.some(a => a.id === entry.id)
      ? { activity: b.activity.map(a => a.id === entry.id ? { ...a, ...entry } : a) }
      : { activity: [...b.activity, entry] }
  )),
  updateActivity: (id, patch) => get().updateChatBundle(get().activeChatId, b => ({
    activity: b.activity.map(a => a.id === id ? { ...a, ...patch } : a)
  })),
  clearActivity: () => get().updateChatBundle(get().activeChatId, () => ({ activity: [], agentProgress: [], preflights: [], subagentRuns: [], planCards: [] })),
  setAgentProgress: (entries) => get().updateChatBundle(get().activeChatId, () => ({ agentProgress: entries })),
  pushAgentProgress: (entry) => get().updateChatBundle(get().activeChatId, b => ({ agentProgress: upsertAgentProgress(b.agentProgress ?? [], entry) })),
  applyAgentProgressEvent: (event) => get().updateChatBundle(get().activeChatId, b => {
    const current = b.agentProgress ?? []
    const next = reduceAgentProgress(current, event)
    return next === current ? null : { agentProgress: next }
  }),
  pushPreflight: (card) => get().updateChatBundle(get().activeChatId, b => ({ preflights: [...b.preflights, card] })),
  pushPlanCard: (chatId, card) => get().updateChatBundle(chatId, b => {
    const idx = b.planCards.findIndex(c => c.planId === card.planId)
    if (idx === -1) return { planCards: [...b.planCards, card] }
    const next = b.planCards.slice()
    next[idx] = { ...next[idx], ...card }
    return { planCards: next }
  }),
  upsertSubagentRun: (card) => get().updateChatBundle(get().activeChatId, b => {
    const idx = b.subagentRuns.findIndex(r => r.callId === card.callId)
    if (idx === -1) return { subagentRuns: [...b.subagentRuns, card] }
    const next = b.subagentRuns.slice()
    next[idx] = { ...next[idx], ...card }
    return { subagentRuns: next }
  }),
  markFileTouched: (path, kind) => set(s => {
    if (!path) return {}
    const existing = s.touchedFiles[path]
    if (existing && TOUCH_PRIORITY[existing] >= TOUCH_PRIORITY[kind]) return {}
    return { touchedFiles: { ...s.touchedFiles, [path]: kind } }
  }),
  clearTouchedFiles: () => set({ touchedFiles: {} }),
  setCheckpoint: (id, msgId) => get().updateChatBundle(get().activeChatId, () => ({ checkpointId: id, checkpointMessageId: msgId ?? null })),
  openDevTask: (task) => set({ activeDevTaskId: task.id, devTask: task, activeView: 'task' }),
  refreshDevTask: async () => {
    const id = get().activeDevTaskId
    if (id == null) return
    try {
      const detail = await window.api.devtask.get(id)
      // Задача могла быть удалена/не найдена — снимаем активность.
      if (!detail?.task) { set({ devTask: null, activeDevTaskId: null }); return }
      set({ devTask: detail.task })
    } catch { /* IPC недоступен в dev — оставляем текущий снимок */ }
  },
  closeDevTask: () => set({ activeDevTaskId: null, devTask: null }),
  addUsage: (delta) => get().updateChatBundle(get().activeChatId, b => ({
    sessionUsage: {
      inputTokens: b.sessionUsage.inputTokens + (delta.inputTokens ?? 0),
      outputTokens: b.sessionUsage.outputTokens + (delta.outputTokens ?? 0),
      cachedInputTokens: b.sessionUsage.cachedInputTokens + (delta.cacheReadTokens ?? delta.cachedInputTokens ?? 0),
      cacheWriteTokens: (b.sessionUsage.cacheWriteTokens ?? 0) + (delta.cacheWriteTokens ?? delta.cacheCreationInputTokens ?? 0),
      // 2.0.8-E хвост: держим семантику фактического провайдера (последнее событие
      // побеждает — как в runner'ах). Без неё ценник занижал Claude (дефект B).
      inputAccounting: delta.inputAccounting ?? b.sessionUsage.inputAccounting
    }
  })),
  resetUsage: () => get().updateChatBundle(get().activeChatId, () => ({ sessionUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 } })),
  setRunningPlanStep: (s) => get().updateChatBundle(get().activeChatId, () => ({ runningPlanStep: s })),
  applyEventToSession: (projectPath, event) => set(s => {
    const existing = s.sessions[projectPath] ?? freshSnapshot()
    let next = applySnapshotEvent({ ...existing, hasUnread: true }, event)
    if (typeof event.chatId === 'number') {
      next = { ...next, chatId: event.chatId }
    }
    // pending-write/command — специфика фоновой ПРОЕКТНОЙ сессии (не в общем ядре).
    const t = event.type
    if (t === 'pending-write' && typeof event.callId === 'string') {
      next = { ...next, pendingWrites: [...next.pendingWrites, {
        callId: event.callId,
        path: String(event.path ?? ''),
        before: String(event.before ?? ''),
        after: String(event.after ?? '')
      }] }
    } else if (t === 'pending-command' && typeof event.callId === 'string') {
      next = { ...next, pendingCommand: { callId: event.callId, command: String(event.command ?? ''), sendId: typeof event.sendId === 'number' ? event.sendId : undefined } }
    }
    return { sessions: { ...s.sessions, [projectPath]: next } }
  }),
  markSessionRead: (projectPath) => set(s => {
    const existing = s.sessions[projectPath]
    if (!existing) return {}
    return { sessions: { ...s.sessions, [projectPath]: { ...existing, hasUnread: false } } }
  }),
  setPromptRouteOverride: (route) => set({ promptRouteOverride: route }),
  setEarlyRouteStop: (stop) => set({ earlyRouteStop: stop }),
  switchChatSession: async (id) => {
    const myToken = ++switchChatSessionToken
    const s = get()
    if (!s.path) return
    // 2.0.7-F: one-shot маршрут не течёт между чатами — сбрасываем при переключении.
    if (s.promptRouteOverride) set({ promptRouteOverride: null })
    get().leaveHelpMode()
    // Единый leaveChat: снять уходящий чат в фон + привести стрим-флаг к реальности
    // (drift-класс #3 — раньше двухшаг был продублирован здесь и в newChatSession).
    // 4.4: уходящий чат уже живёт в chats — снимать его копию некуда и незачем.
    // Остаётся привести его стрим-флаг к реальности (drift-класс #3).
    const nextChats = settleLeavingChat(s, id)
    const restored = nextChats[id]
    const session = s.chatSessions.find(c => c.id === id)

    if (restored) {
      const restoredSafe = keepStreamingOnlyWhenInflight(
        restored,
        hasInflightChatSend(s.sendOwners, id, false, s.chatLaneGenerations)
      )
      set(buildRestoredSwitchPatch({ activeChatId: id, restored: restoredSafe, chats: nextChats }))
    } else {
      set(buildFreshSwitchPatch({ activeChatId: id, chats: nextChats }))
      void (async () => {
        const history = await window.api.chats.listWindow(id, { limit: 50 })
        if (myToken !== switchChatSessionToken) return
        if (get().activeChatId !== id) return
        // 4.2: messages через единую точку (поддерживает chats SSOT); пагинация
        // вне bundle — отдельным патчем.
        get().updateChatBundle(id, () => ({
          messages: history.messages.map(m => ({ role: m.role, content: m.content, thinking: m.thinking, appliedSkills: m.appliedSkills, createdAt: m.createdAt, dbId: m.id })),
        }))
        set({
          chatHasMoreBefore: history.hasMoreBefore,
          chatTotalCount: history.totalCount
        })
      })()
    }

    if (session?.providerId) {
      void (async () => {
        try {
          await window.api.settings.setKey('provider', session.providerId!)
          // Гонка (срез 4): к моменту резолва пользователь мог переключиться на другой
          // чат — тогда дописывать модель ЭТОГО (уже устаревшего) чата нельзя, иначе
          // model_<provider>/setModel затрёт настройку нового активного чата. Зеркалим
          // token-guard history-загрузки выше. Сам provider-write выше безопасен по
          // порядку (issued синхронно в порядке switch), guard'им только пост-await часть.
          if (myToken !== switchChatSessionToken) return
          if (session.model && isModelValidForProvider(session.providerId!, session.model)) {
            await window.api.settings.setKey(`model_${session.providerId}`, session.model)
          } else if (session.model) {
            await window.api.settings.setKey(`model_${session.providerId}`, '')
            await window.api.chatSessions.setModel(id, session.providerId!, null)
          }
        } catch { /* settings write failure shouldn't block chat switch */ }
      })()
    }
    void get().refreshReviewsFor(id)
  },
  registerSendOwner: (sendId, owner) => set(s => {
    if (owner.kind !== 'chat') {
      return { sendOwners: { ...s.sendOwners, [sendId]: owner } }
    }
    const key = chatLaneKey(owner.chatId, !!owner.isHelp)
    const laneGeneration = (s.chatLaneGenerations[key] ?? 0) + 1
    return {
      chatLaneGenerations: { ...s.chatLaneGenerations, [key]: laneGeneration },
      sendOwners: { ...s.sendOwners, [sendId]: { ...owner, laneGeneration } }
    }
  }),
  lookupSendOwner: (sendId) => {
    const owner = get().sendOwners[sendId] ?? null
    if (owner?.kind !== 'chat') return owner
    const current = get().chatLaneGenerations[chatLaneKey(owner.chatId, !!owner.isHelp)]
    return owner.laneGeneration === current ? owner : null
  },
  hasActiveChatLane: (chatId, isHelp = false) => {
    const s = get()
    return hasInflightChatSend(s.sendOwners, chatId, isHelp, s.chatLaneGenerations)
  },
  forgetSendOwner: (sendId) => set(s => {
    if (!(sendId in s.sendOwners)) return {}
    const next = { ...s.sendOwners }
    delete next[sendId]
    return { sendOwners: next }
  }),
  updateChatBundle: (chatId, updater) => {
    const patch = applyBundleUpdate(get(), chatId, updater)
    // Zustand publishes even when an updater returns an empty object. Avoid a
    // global subscriber wake-up for repeated stream progress deltas/no-ops.
    if (Object.keys(patch).length > 0) set(patch)
  },
  applyEventToChat: (chatId, event) => get().updateChatBundle(chatId, b => {
    let next = applySnapshotEvent({ ...b, hasUnread: true }, event)
    // 5.1 (review P0): pending-write/command фонового чата — в его snapshot (как
    // applyEventToSession). Иначе после switchChatSession confirm-модалка не
    // всплывёт (restoreBundle поднимает pending из снапшота в top-level) и main
    // зависнет на resolveWrite/resolveCommand.
    const t = event.type
    if (t === 'pending-write' && typeof event.callId === 'string') {
      next = { ...next, pendingWrites: [...next.pendingWrites, {
        callId: event.callId,
        path: String(event.path ?? ''),
        before: String(event.before ?? ''),
        after: String(event.after ?? '')
      }] }
    } else if (t === 'pending-command' && typeof event.callId === 'string') {
      next = { ...next, pendingCommand: { callId: event.callId, command: String(event.command ?? ''), sendId: typeof event.sendId === 'number' ? event.sendId : undefined } }
    }
    // Персист завершённого assistant-сообщения в БД (переживёт reload).
    // persistedByChat: активный чат уже персистит сам (Chat.tsx) — не дублируем.
    if ((t === 'done' || t === 'error') && !event.persistedByChat) {
      const lastMsg = next.messages[next.messages.length - 1]
      const persistProjectPath = typeof event.projectPath === 'string' ? event.projectPath : get().path
      if (lastMsg?.role === 'assistant' && lastMsg.content && persistProjectPath) {
        void window.api.chats.append(chatId, persistProjectPath, 'assistant', lastMsg.content).catch(() => {})
      }
    }
    return next
  }),
  seedChatSnapshot: (chatId, messages) => get().updateChatBundle(chatId, () => ({ messages })),
  pushUserToChatSnapshot: (chatId, content, meta, assistantDbId) => get().updateChatBundle(chatId, b => ({
    messages: [...b.messages, { ...meta, role: 'user', content }, { role: 'assistant', content: '', ...(assistantDbId ? { dbId: assistantDbId } : {}) }],
    isStreaming: true,
    streamStartedAt: Date.now(),
    hasUnread: false
  })),
  refreshChatSessions: async () => {
    const s = get()
    if (!s.path) return
    const list = await window.api.chatSessions.list(s.path)
    set({ chatSessions: list })
  },
  /**
   * Patch one chat-session in place — used by rename so we don't have to
   * refetch the whole list. переименование чата
   * во время стрима ломало ответ. Полная перезагрузка списка чатов давала
   * re-render волну, которая в некоторых условиях прерывала входящий
   * ai:event поток. Локальный optimistic patch убирает этот класс багов
   * целиком — ничего, кроме одного title, не меняется.
   */
  patchChatSession: (id, patch) => set(s => ({
    chatSessions: s.chatSessions.map(c => c.id === id ? { ...c, ...patch } : c)
  })),
  autoTitleChatSession: async (chatId, firstUserText) => {
    const s = get()
    const session = s.chatSessions.find(c => c.id === chatId)
    if (!session || !isGenericChatTitle(session.title)) return
    const title = titleFromFirstMessage(firstUserText)
    if (!title) return
    get().patchChatSession(chatId, { title })
    try {
      await window.api.chatSessions.rename(chatId, title)
    } catch (err) {
      console.warn('[projectStore] autoTitleChatSession rename failed:', err)
      await get().refreshChatSessions()
    }
  },
  newChatSession: async (title) => {
    const s = get()
    if (!s.path) return null
    // Inherit the currently-selected provider/model so a new chat doesn't
    // reset back to gemini-api when user is e.g. in the middle of working
    // with Claude.
    const currentProvider = await window.api.settings.getKey('provider')
    const currentModel = currentProvider ? await window.api.settings.getKey(`model_${currentProvider}`) : null
    const created = await window.api.chatSessions.create(s.path, {
      title,
      providerId: currentProvider ?? null,
      model: currentModel ?? null
    })
    const list = await window.api.chatSessions.list(s.path)
    // Снапшотим уходящий активный чат тем же leaveChat, что и switchChatSession.
    // Иначе при создании нового чата во время стрима частичный ответ старого чата
    // теряется, а его фоновые события (включая финальный done) уходят в пустой
    // freshSnapshot (#8). Единый путь ухода — без дрейфа между switch и new (#3).
    const nextChats = settleLeavingChat(s, created.id)
    // 2.0.1 bug (+ ре-ревью): патч нового чата сбрасывает openedReviewId/
    // previewArtifactId/sessionUsage/preflights/subagentRuns — иначе ревью/превью и
    // счётчик стоимости прошлого чата протекают в новый (компаундинг cost).
    // Единая форма — chat-lifecycle.ts (срез 3).
    set(buildNewChatPatch({ activeChatId: created.id, chats: nextChats, chatSessions: list }))
    return created
  },
  forkChat: async (sourceId) => {
    const s = get()
    if (!s.path) return null
    // Не форкаем СТРИМЯЩИЙ чат: in-flight ответ ещё не персистнут в БД → ветка
    // получила бы усечённую историю без последней реплики (ревью 26.06).
    const streaming = s.chats[sourceId]?.isStreaming
    if (streaming) return null
    try {
      const branch = await window.api.chatSessions.fork(sourceId)
      if (!branch) return null
      const list = await window.api.chatSessions.list(s.path)
      set({ chatSessions: list })
      // switchChatSession снапшотит уходящий чат и грузит скопированную историю ветки.
      await get().switchChatSession(branch.id)
      return branch
    } catch (e) {
      console.error('[forkChat] fork failed:', e instanceof Error ? e.message : e)
      return null
    }
  },
  editViaFork: async (sourceId, messageId) => {
    const s = get()
    if (!s.path) return null
    // Двойной клик по «править» без гарда делал два форка (одна ветка осиротевшая). Флаг
    // ставится синхронно до первого await — второй клик отклоняется, пока первый в полёте.
    if (editViaForkInFlight) return null
    // Сообщения оригинала: активный чат берёт из messages, фоновый — из снапшота.
    const messages = s.chats[sourceId]?.messages ?? []
    const point = forkPointForMessage(messages, messageId)
    if (!point.ok) return null
    editViaForkInFlight = true
    // Весь путь под try/catch/finally: флаг снимается при ЛЮБОМ исходе (иначе залипнет и
    // правка станет недоступна до перезагрузки), а сбой list/switch не крешит void-вызов
    // из UI. В ОТЛИЧИЕ от forkChat здесь НЕТ гарда «не форкать стримящий»: правим ПРОШЛОЕ
    // сообщение (uptoMessageId давно в БД), текущий стрим в форк не входит и продолжается
    // в оригинале — снапшотится через switchChatSession (инвариант «стрим не трогается»).
    try {
      // ВСЕГДА передаём границу, даже для первого сообщения (uptoMessageId null → 0 = ПУСТАЯ
      // ветка). undefined тут форкнул бы ВСЮ историю — при правке первого сообщения это дало
      // бы ветку с оригинальным первым сообщением, которое мы как раз заменяем.
      const branch = await window.api.chatSessions.fork(sourceId, { uptoMessageId: point.uptoMessageId ?? 0 })
      if (!branch) return null
      const list = await window.api.chatSessions.list(s.path)
      set({ chatSessions: list })
      await get().switchChatSession(branch.id)
      // Отредактированный текст — ЧЕРНОВИКОМ в композер ветки. НЕ отправляем: сбой отправки
      // не должен рушить правку (инвариант «черновик не теряется»). Человек правит и шлёт сам.
      get().setComposerDraft(projectChatDraftKey(s.path, branch.id), {
        text: point.originalText,
        attachments: [],
      })
      return branch
    } catch (e) {
      console.error('[editViaFork] failed:', e instanceof Error ? e.message : e)
      return null
    } finally {
      editViaForkInFlight = false
    }
  },
  leaveHelpMode: () => {
    const s = get()
    if (!s.helpMode) return
    useSkills.getState().setActiveSkill(null)
    const chatId = s.activeChatId
    const snap = chatId != null ? s.chats[chatId] : undefined
    if (snap && chatId != null) {
      const inflight = hasInflightChatSend(s.sendOwners, chatId, false, s.chatLaneGenerations)
      // restoreBundle — единая форма восстановления (вкл. checkpointId/preflights/
      // subagentRuns per-chat). Стрим — только если реально ещё в полёте.
      set(buildLeaveHelpRestorePatch({ snap, chatId, chats: s.chats, inflight }))
      return
    }
    // 4.2: стрим-флаги — через единую точку (поддерживает chats SSOT).
    get().updateChatBundle(chatId, () => ({ isStreaming: false, streamStartedAt: null }))
    set({ helpMode: false })
  },
  markHelpRead: () => set(s => ({
    help: { ...s.help, hasUnread: false }
  })),
  setHelpStreaming: (v) => set(s => ({
    help: {
      ...s.help,
      isStreaming: v,
      streamStartedAt: v ? Date.now() : s.help.streamStartedAt,
    }
  })),
  addHelpMessage: (msg) => set(s => ({
    help: { ...s.help, messages: [...s.help.messages, msg] }
  })),
  insertHelpMessageBeforeLast: (msg) => set(s => {
    const msgs = [...s.help.messages]
    if (msgs.length === 0) return { help: { ...s.help, messages: [msg] } }
    msgs.splice(msgs.length - 1, 0, msg)
    return { help: { ...s.help, messages: msgs } }
  }),
  updateHelpLastAssistant: (text) => set(s => {
    const msgs = [...s.help.messages]
    const last = msgs[msgs.length - 1]
    if (last?.role === 'assistant') {
      msgs[msgs.length - 1] = { ...last, content: text }
    }
    return { help: { ...s.help, messages: msgs } }
  }),
  appendHelpLastAssistantThinking: (text) => set(s => ({ help: { ...s.help, messages: appendThinkingToLastAssistant(s.help.messages, text) } })),
  clearHelpActivity: () => set(s => ({
    help: { ...s.help, activity: [], agentProgress: [] }
  })),
  pushHelpActivity: (entry) => set(s => ({
    help: { ...s.help, activity: [...s.help.activity, entry] }
  })),
  setHelpAgentProgress: (entries) => set(s => ({
    help: { ...s.help, agentProgress: entries }
  })),
  pushHelpAgentProgress: (entry) => set(s => ({
    help: { ...s.help, agentProgress: upsertAgentProgress(s.help.agentProgress ?? [], entry) }
  })),
  addHelpUsage: (delta) => set(s => ({
    help: {
      ...s.help,
      sessionUsage: {
        inputTokens: s.help.sessionUsage.inputTokens + (delta.inputTokens ?? 0),
        outputTokens: s.help.sessionUsage.outputTokens + (delta.outputTokens ?? 0),
        cachedInputTokens: s.help.sessionUsage.cachedInputTokens + (delta.cacheReadTokens ?? delta.cachedInputTokens ?? 0),
        cacheWriteTokens: (s.help.sessionUsage.cacheWriteTokens ?? 0) + (delta.cacheWriteTokens ?? delta.cacheCreationInputTokens ?? 0),
        inputAccounting: delta.inputAccounting ?? s.help.sessionUsage.inputAccounting,
      }
    }
  })),
  applyEventToHelp: (event) => set(s => {
    const next = applySnapshotEvent({ ...s.help, hasUnread: s.helpMode ? false : true }, event)
    const t = event.type
    if ((t === 'done' || t === 'error') && !event.persistedByChat) {
      // Персист завершённого assistant-сообщения справки в БД.
      // persistedByChat: активный чат уже персистит сам (Chat.tsx) — не дублируем.
      const lastMsg = next.messages[next.messages.length - 1]
      const chatId = s.helpChatId
      if (lastMsg?.role === 'assistant' && lastMsg.content && chatId != null) {
        void window.api.chats.append(chatId, HELP_PROJECT_PATH, 'assistant', lastMsg.content).catch(() => {})
      }
    } else if (t === 'info' && typeof event.text === 'string') {
      // info → активити-плашка (специфика справки, не в общем ядре).
      return { help: { ...next, activity: [...next.activity, {
        id: `info-${Date.now()}`,
        kind: 'read',
        label: event.text,
        detail: '',
        status: 'ok',
        timestamp: Date.now()
      }] } }
    }
    return { help: next }
  }),
  openHelpChat: async () => {
    const initial = get()
    if (initial.helpMode) {
      get().leaveHelpMode()
      return
    }
    const helpSession = await window.api.chatSessions.getOrCreateHelp()
    let helpState = get().help
    if (helpState.messages.length === 0) {
      const history = await window.api.chats.list(helpSession.id)
      helpState = {
        ...helpState,
        messages: history.map(m => ({ role: m.role, content: m.content, thinking: m.thinking, appliedSkills: m.appliedSkills, createdAt: m.createdAt, dbId: m.id }))
      }
    }
    const current = get()
    if (current.helpMode) return

    const patch: Partial<ProjectState> = {
      helpChatId: helpSession.id,
      helpMode: true,
      help: { ...helpState, hasUnread: false },
      activeView: 'chat'
    }

    if (current.path && current.activeChatId != null) {
      // keepStreamingOnlyWhenInflight — паритет со switch/new (ревью #3): без него
      // фантомный стрим-флаг (isStreaming=true при УЖЕ завершённом send) уносится в
      // снапшот и держит залипший индикатор фонового чата, пока пользователь в справке.
      // Живой (in-flight) стрим при этом обязан сохраниться — иначе ответ теряется.
      const activeProjectSnapshot = keepStreamingOnlyWhenInflight(
        current.chats[current.activeChatId] ?? { ...freshSnapshot(), chatId: current.activeChatId },
        hasInflightChatSend(current.sendOwners, current.activeChatId, false, current.chatLaneGenerations)
      )
      patch.chats = {
        ...current.chats,
        [current.activeChatId]: activeProjectSnapshot
      }
      patch.sessions = {
        ...current.sessions,
        [current.path]: {
          ...activeProjectSnapshot,
          hasUnread: false
        }
      }
    }

    set(patch)
    useSkills.getState().setActiveSkill('verstak-guide')
  },
  recordArtifact: (a) => set(s => ({
    artifacts: [...s.artifacts, { ...a, ts: Date.now() }]
  })),
  setVerificationBadge: (badge) => set(s => {
    // Патчим последний verification-артефакт DoD-бейджем. Хендлер шлёт
    // artifact-created(kind=verification) синхронно перед verification-attested,
    // так что последний verification в списке — наш.
    const idx = [...s.artifacts].map(a => a.kind).lastIndexOf('verification')
    if (idx < 0) return {}
    const next = s.artifacts.slice()
    next[idx] = { ...next[idx], ...badge }
    return { artifacts: next }
  }),
  clearArtifacts: () => set({ artifacts: [], previewArtifactId: null }),
  setPreviewArtifact: (path) => set({ previewArtifactId: path }),
  setEffortLevel: (level) => set({ effortLevel: level }),
  loadResumableRuns: async (path) => {
    try {
      const runs = await window.api.agentRuns.listResumable(path)
      // Гонка смены проекта: применяем только если проект всё ещё активен.
      if (get().path !== path) return
      set({ resumableRuns: runs })
    } catch (err) {
      console.warn('[crash-resume] loadResumableRuns failed:', err)
    }
  },
  reconcileStreamingState: async (path) => {
    try {
      const [running, queued] = await Promise.all([
        window.api.agentRuns.list(path, { status: 'running', owner: 'main', limit: 1 }),
        window.api.agentRuns.list(path, { status: 'queued', owner: 'main', limit: 1 }),
      ])
      // PerChatState 4.2: per-chat правки — через единую точку (поддерживает chats
      // SSOT). Раньше был один атомарный set; теперь несколько последовательных —
      // reconcile идёт на открытии проекта, промежуточные рендеры безвредны.
      // sessions (проектный уровень) — вне chat-bundle, патчится отдельно.
      const s = get()
      const hasLiveOwner = hasInflightProjectSend(s.sendOwners, path)
      if ((running.length > 0 || queued.length > 0) && hasLiveOwner) return
      if (s.path === path && activeChatBundle(s).isStreaming && !hasLiveOwner) {
        get().updateChatBundle(s.activeChatId, () => ({ isStreaming: false, streamStartedAt: null }))
      }
      if (s.sessions[path]?.isStreaming && !hasLiveOwner) {
        set(s2 => ({
          sessions: {
            ...s2.sessions,
            [path]: { ...s2.sessions[path], isStreaming: false, streamStartedAt: null }
          }
        }))
      }
      for (const [chatIdRaw, snap] of Object.entries(s.chats)) {
        const chatId = Number(chatIdRaw)
        if (chatId === s.activeChatId) continue
        if (!snap.isStreaming || hasInflightChatSend(s.sendOwners, chatId, false, s.chatLaneGenerations)) continue
        get().updateChatBundle(chatId, () => ({ isStreaming: false, streamStartedAt: null }))
      }
    } catch (err) {
      console.warn('[projectStore] reconcileStreamingState failed:', err)
    }
  },
  dismissResumableRun: (runId) => {
    void window.api.agentRuns.dismissResumable(runId)
    set(s => ({ resumableRuns: s.resumableRuns.filter(r => r.runId !== runId) }))
  },
  // §5 распил: pipeline + review вынесены в отдельные слайсы (спред справа от main-полей).
  ...createPipelineSlice(set, get, store),
  ...createReviewSlice(set, get, store),
}))

// Re-export pure session types из нового модуля, чтобы публичная поверхность
// projectStore не менялась (ActivityEntry/PendingCommand/SessionUsage/TouchKind
// раньше экспортировались отсюда).
export type { ActivityEntry, PendingCommand, SessionUsage, TouchKind }
// §5 распил: ReviewState переехал в review-slice; ре-экспорт держит публичную поверхность.
export type { ReviewState } from './review-slice'
