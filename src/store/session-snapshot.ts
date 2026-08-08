import type { ChatMessage } from '../types/api'
import type { AgentProgressEntry } from '../lib/agent-progress'
import type { InputAccounting } from '../../shared/contracts/usage'

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

/** §7.2 ТЗ: карточка «план создан» в потоке чата — вместо технической строки
 *  activity. Показывает название, число шагов и честный статус. */
export interface PlanCreatedCard {
  planId: number
  title: string
  stepCount: number
  /** Ждёт ли план решения человека — карточка честно показывает статус. */
  awaitingApproval: boolean
}

/** VSK-PRODUCT-A1 3b: код-сводка чтения материалов — эфемерная строка в потоке.
 *  Показывается ТОЛЬКО когда есть что сказать (что-то не прочиталось/не открывалось);
 *  `line` — готовая строка из main (сводку строит НАШ код, не модель). Эфемерная:
 *  чистится на новом send как planCards/preflights, в БД не пишется. */
export interface MaterialsNote {
  source: 'attachments' | 'folder'
  line: string
}

/** Карточка плана, ждущего решения человека (§10). Живёт в bundle СВОЕГО чата:
 *  до хвоста §10 это было одно глобальное поле, и вторая карточка молча
 *  затирала первую, а продолжение уезжало в активный чат вместо своего. */
export interface PendingPlanCard {
  callId: string
  planId: number
  title: string
  stepCount: number
  sendId?: number
  quality?: { score: number; status: 'pass' | 'revise' | 'block'; warnings: string[] }
  /** §2.3: есть ли чем продолжать. `false` — план жив, а чекпойнт освобождён:
   *  кнопки согласования показывать нельзя, они ничего не сделают. Не указано —
   *  карточка из живого события, продолжение на месте. */
  resumable?: boolean
}

export interface ActivityEntry {
  id: string
  // 2.1.3-CD: 'route' — видимая история переключений маршрута (ротация аккаунта /
  // model-fallback), строится из структурного route-changed, не из текста логов.
  kind: 'read' | 'list' | 'write' | 'command' | 'blocked' | 'route'
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
  /** Токены, записанные в prompt cache (Claude cache_creation). */
  cacheWriteTokens?: number
  /**
   * 2.0.8-E хвост: семантика reported input ФАКТИЧЕСКОГО провайдера (последнее usage-событие).
   * Без неё ценник чата считал по дефолту 'inclusive' и вычитал кэш из input у Claude
   * (exclusive) → занижал стоимость на больших cache-hit (дефект B). undefined = провайдер
   * не сообщил → pricing не вычитает кэш (безопасный дефолт).
   */
  inputAccounting?: InputAccounting
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

/** Задача 10 (оркестратор): карточка-СЛЕД в РОДИТЕЛЬСКОМ чате о задаче, вынесенной
 *  в отдельную ВИДИМУЮ дочернюю сессию. Клик по карточке ведёт в дочерний чат
 *  (switchChatSession). Возврат результата = обновление ИМЕННО этой карточки
 *  (видимый след), а НЕ инъекция ответа ребёнка в контекст родителя — то был бы
 *  delegate_task (блокирующий суб-агент), Павел просил обратного: родитель остаётся
 *  местом мышления и НЕ блокируется. Статус ловит и СМЕРТЬ ребёнка: если прогон
 *  оборвётся mid-stream (ни done, ни error), run-finalized переведёт карточку в
 *  'terminated' — она говорит наблюдаемое «прогон оборвался», а не застревает в
 *  «выполняется». Эфемерная (в БД не пишется), но переживает новые отправки
 *  родителя — иначе видимый след пропал бы при первом же follow-up. */
export interface SpawnedSessionCard {
  /** chat_sessions.id дочерней сессии — цель клика и ключ поиска карточки по done/error. */
  childChatId: number
  title: string
  status: 'running' | 'done' | 'error' | 'terminated'
  /** sendId дочернего прогона — по нему run-finalized находит эту карточку (envelope
   *  run-finalized несёт sendId, но не chatId). */
  sendId?: number
}

/**
 * Подпись статуса карточки-следа. Карточка знает НАБЛЮДАЕМОЕ (прогон завершён/оборвался),
 * а НЕ выполнена ли задача — критерия успеха у неё нет, и намекать на успех нельзя
 * (задача 08.08, C(б)): ребёнок мог закончить 'done', но артефакта не сделать. Поэтому
 * done → «прогон завершён» (нейтрально; рядом кнопка «Открыть сессию»), а не «готово».
 */
export function spawnCardStatusLabel(status: SpawnedSessionCard['status']): string {
  switch (status) {
    case 'running': return 'выполняется'
    case 'done': return 'прогон завершён'
    case 'error': return 'ошибка'
    case 'terminated': return 'прогон оборвался'
  }
}

export interface SessionSnapshot {
  /** Chat session this snapshot belongs to. Needed when a project is restored
   *  after a background answer finished while another project was open. */
  chatId?: number | null
  messages: ChatMessage[]
  isStreaming: boolean
  /** Когда начался текущий прогон ассистента (для live-таймера). */
  streamStartedAt: number | null
  pendingWrites: PendingWrite[]
  pendingCommand: PendingCommand | null
  /** §10: план этого чата, ожидающий решения человека. */
  pendingPlan: PendingPlanCard | null
  /** §7.2: созданные в этом чате планы — пользовательские карточки в потоке,
   *  а не техническая строка activity. Эфемерные: чистятся на новом send. */
  planCards: PlanCreatedCard[]
  activity: ActivityEntry[]
  agentProgress: AgentProgressEntry[]
  sessionUsage: SessionUsage
  runningPlanStep: RunningPlanStep | null
  /**
   * §2.4: в текущем прогоне человек отказал ответственному действию.
   *
   * Нужен, чтобы отличить ОТКАЗ от УСПЕХА на финале. Отказ завершает прогон
   * ШТАТНО — инструмент возвращает результат, модель его читает и заканчивает
   * ход, — поэтому приходит обычный `done`, и шаг плана помечался ВЫПОЛНЕННЫМ.
   * Запись «сделано» про работу, которую человек запретил, хуже молчания.
   * Эфемерный: живёт один прогон, чистится на новом.
   */
  refusedInRun?: boolean
  /** Undo entry ID точки «📍 Чекпоинт» этого чата — кнопка отката. Per-chat:
   *  раньше зануляли на restore (anti-leak), из-за чего кнопка отката пропадала
   *  при переключении чатов. Теперь носим в bundle → сохраняется per-chat, при
   *  этом чужой checkpoint не утекает (каждый чат восстанавливает свой). */
  checkpointId: number | null
  /** F (ось 3): граница «Откатить задачу» — макс. id сообщения на момент чекпоинта. */
  checkpointMessageId: number | null
  /** Эфемерные карточки активности чата — путешествуют с ним (per-chat). */
  preflights: PreflightCard[]
  subagentRuns: SubagentRunCard[]
  /** VSK-PRODUCT-A1 3b: код-сводки чтения материалов этого чата (эфемерные). */
  materialsNotes: MaterialsNote[]
  /** Задача 10: карточки-следы дочерних сессий, порождённых spawn_task_session ИЗ
   *  этого чата. В отличие от эфемерных preflights/planCards НЕ чистятся на новом
   *  send — иначе видимый след ребёнка пропал бы, а его done/terminated некуда было
   *  бы приземлить. Не персистятся (теряются на рестарте, как subagentRuns). */
  spawnCards: SpawnedSessionCard[]
  /** True when bg session got new content since user last viewed it. */
  hasUnread: boolean
}

export interface InboxApproval {
  chatId: number
  command: PendingCommand
}

/**
 * T1.3 Inbox: все ожидающие подтверждения команды по ВСЕМ чатам одним списком. Раньше approval фонового чата был не виден,
 * пока не переключишься в него — агент в фоне молча ждал. Resolve работает по
 * callId+sendId (ai:resolve-command), т.е. одобрять можно не заходя в чат.
 */
export function selectInboxApprovals(state: {
  activeChatId: number | null
  pendingCommand: PendingCommand | null
  chats: Record<number, Pick<SessionSnapshot, 'pendingCommand'>>
}): InboxApproval[] {
  const out: InboxApproval[] = []
  if (state.pendingCommand && state.activeChatId != null) {
    out.push({ chatId: state.activeChatId, command: state.pendingCommand })
  }
  for (const [id, snap] of Object.entries(state.chats)) {
    // PerChatState 4.4: сюда подаётся `chats` — SSOT, где активный чат ЕСТЬ.
    // Его подтверждение уже добавлено выше отдельным полем, поэтому пропускаем:
    // иначе активный чат дал бы две одинаковые строки в «Центре вмешательств».
    if (Number(id) === state.activeChatId) continue
    if (snap?.pendingCommand) out.push({ chatId: Number(id), command: snap.pendingCommand })
  }
  return out
}

export function emptySessionUsage(): SessionUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 }
}

export function freshSnapshot(): SessionSnapshot {
  return {
    chatId: null,
    messages: [],
    isStreaming: false,
    streamStartedAt: null,
    pendingWrites: [],
    pendingCommand: null,
    pendingPlan: null,
    planCards: [],
    activity: [],
    agentProgress: [],
    sessionUsage: emptySessionUsage(),
    runningPlanStep: null,
    checkpointId: null,
    checkpointMessageId: null,
    preflights: [],
    subagentRuns: [],
    materialsNotes: [],
    spawnCards: [],
    hasUnread: false
  }
}

/** Набор полей одного чата без hasUnread. Единый источник истины формы
 *  «состояние одного чата» — им типизируются патчи bundle. */
export type ChatStateBundle = Omit<SessionSnapshot, 'hasUnread'>

/** Привести стрим-флаг снапшота к реальности: сохранить isStreaming только пока
 *  send реально in-flight; иначе снять «отвечает…»-фантом (залипал баннер после
 *  завершения фонового прогона). Чистая — inflight считает caller. */
export function keepStreamingOnlyWhenInflight(snap: SessionSnapshot, inflight: boolean): SessionSnapshot {
  if (inflight && snap.isStreaming) return snap
  if (!snap.isStreaming && snap.streamStartedAt == null) return snap
  return {
    ...snap,
    isStreaming: false,
    streamStartedAt: null
  }
}

