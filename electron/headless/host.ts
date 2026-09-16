import { createHash, randomUUID } from 'crypto'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'

import { openDb } from '../storage/db'
import { createSettings, type SafeStorageLike } from '../storage/settings'
import { createAgentRuns } from '../storage/agent-runs'
import { createUndoStack } from '../storage/undo'
import { createPlans } from '../storage/plans'
import { createJournal } from '../storage/journal'
import { saveMemory, invalidateMemory, searchMemories } from '../storage/memories'
import { searchConversations, createChats } from '../storage/chats'
import { createChatSessions } from '../storage/chat-sessions'

import { createConnectorRegistry } from '../connectors/registry'
import { PROVIDERS, createProvider, type ProviderId } from '../ai/registry'
import { createToolsForProject } from '../ai/tools'
import { createCostGuard } from '../ai/cost-guard'
import { isComputerUseComposerAttempt } from '../ai/computer/intent'
import { prepareSystemContext } from '../ai/compose-system'
import { isWithinKnownRoots } from '../ai/path-policy'
import { runApiConversation } from '../ai/runner-api'
import { resolveTurnsBudget } from '../ai/runner-shared'
import { configureRuntimeLogDir, logRuntime } from '../runtime-log'
import { createScheduledJobs, type ScheduledJobs } from '../storage/scheduled-jobs'
import {
  createHeadlessIdempotencyStore,
  HeadlessIdempotencyError,
  HEADLESS_IDEMPOTENCY_CONFLICT,
  HEADLESS_IDEMPOTENCY_CORRUPT,
  HEADLESS_IDEMPOTENCY_INVALID,
  HEADLESS_IDEMPOTENCY_PENDING,
  type HeadlessIdempotencyClaim,
  type HeadlessTaskOperation,
} from '../storage/headless-idempotency'
import { startScheduler, type Scheduler } from './scheduler'
import { createSkillRegistry } from '../ai/skills/registry'
import type { SkillRegistry } from '../ai/skills/types'
import type { ChatProvider, ChatMessage } from '../ai/types'
import type { TaggedSender } from '../ipc/tool-handlers/shared'
import { buildProviderRuntimeOptions } from '../ipc/ai-send/provider-options'
import { STAGE1_CANARY_TOOLS_ALLOW, STAGE1_TOOLS_ALLOW, STAGE1_CONNECTOR_DENY } from './stage1'
import { CLOUD_SYSTEM_LAYER_PROMPT } from './cloud-layer'
import type { AgentMode } from '../ai/mode-policy'
import type { NewStep, CreatePlanMeta } from '../storage/plans'
import type { JournalKind } from '../storage/journal'

// Headless-хост агентного ядра (Этап 1а облачного Verstak, блок №2 постановки;
// карта — разведка headless-ядра 04.08). Второй потребитель ТЕХ ЖЕ модулей
// ядра, что и десктоп: ни один файл electron/ipc/* и electron/ai/* этим хостом не
// перекраивается. Один хост = один пользователь (одна sqlite в dataDir — рабочая
// гипотеза мульти-тенантности из отчёта §3а).

export interface HeadlessHostOptions {
  /** Каталог данных пользователя: {dataDir}/verstak.db + {dataDir}/logs. */
  dataDir: string
  /** Корни, внутри которых живут workspace'ы задач (гейт isWithinKnownRoots). */
  workspaceRoots: string[]
  /** Серверное шифрование секретов (secure-storage.ts). Обязателен: без ключа хост не стартует. */
  safeStorage: SafeStorageLike
  /**
   * Источник env-фолбэка ключей. Правило то же, что ENV_MAP десктопа, но общее:
   * secretKey провайдера/коннектора в UPPER_CASE (deepseek_api_key → DEEPSEEK_API_KEY).
   */
  env?: Record<string, string | undefined>
  /** Явные корни скиллов. По умолчанию — НИКАКИХ (домашние ~/.claude и т.п. не читаем: сервер). */
  skillRoots?: string[]
  /**
   * Шов создания провайдера. По умолчанию — createProvider из реестра. Подменяется
   * там, где маршрут решает не сам хост: тесты (детерминизм) и будущая маршрутизация
   * через Gateway. Возврат null → падаем обратно на реестр.
   * Ставится при СОЗДАНИИ хоста, а не в запросе: через HTTP функцию не передать,
   * и подмена провайдера снаружи процесса была бы дырой.
   */
  providerFactory?: (providerId: ProviderId, model: string, signal: AbortSignal, workspace: string) => ChatProvider | null
  /**
   * C1 (P5): период опроса расписания в мс; null — выключить scheduler (тесты,
   * потребители с собственным циклом). По умолчанию 30 секунд.
   */
  schedulerPollMs?: number | null
  /** Per-tenant abuse guards. Defaults are production-safe; tests may lower them. */
  maxActiveRuns?: number
  maxRunsPer24h?: number
  /** Общий process-local потолок прогонов всех tenant-host'ов. Реестр инжектит один экземпляр во все хосты. */
  globalRunCapacity?: HeadlessRunCapacity
  /**
   * Разрешить модели создавать scheduled jobs. По умолчанию true для совместимости
   * desktop/single-host; рекламный multi-tenant entrypoint явно ставит false.
   */
  enableScheduledTasks?: boolean
  /**
   * Внутренний lifecycle-барьер многотенантного registry. Вызывается ПОСЛЕ
   * остановки прогонов, но ДО закрытия SQLite: уже выданные HTTP request leases
   * должны закончиться, иначе closeAll может закрыть БД между await и обращением
   * handler'а к host.
   */
  beforeCloseDb?: () => Promise<void>
}

export interface HeadlessRunCapacityLease {
  /** Идемпотентное освобождение: completion/ошибка/stop-race не могут увести счётчик ниже нуля. */
  release: () => void
}

export interface HeadlessRunCapacity {
  readonly limit: number
  tryAcquire: () => HeadlessRunCapacityLease | null
  activeCount: () => number
}

/**
 * Общий атомарный лимитер живых/готовящихся provider run'ов одного Node-процесса.
 * tryAcquire синхронный: между проверкой и reservation нет await и два tenant-host'а
 * не могут одновременно забрать последний слот.
 */
export function createHeadlessRunCapacity(limit: number): HeadlessRunCapacity {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1
  let active = 0
  return {
    limit: normalizedLimit,
    tryAcquire() {
      if (active >= normalizedLimit) return null
      active += 1
      let released = false
      return {
        release() {
          if (released) return
          released = true
          active = Math.max(0, active - 1)
        }
      }
    },
    activeCount: () => active
  }
}

/**
 * Маршрут инференса, заданный НА ЗАДАЧУ (облачный Verstak: шлюз выдаёт короткоживущий
 * токен прогона и хочет, чтобы расход считал он сам).
 *
 * Живёт ровно столько, сколько задача: в хранилище секретов тенанта не попадает, в
 * agent_runs и таймлайн не пишется. Именно поэтому он здесь, а не в setSecret —
 * записанный в sqlite токен пережил бы прогон, ради которого выдан.
 */
export interface TaskInferenceRoute {
  /** OpenAI-совместимый базовый URL (например внутренний вход шлюза). */
  baseUrl: string
  /** Токен прогона. Никогда не логируется и не сохраняется. */
  apiKey: string
  /** Список моделей для провайдера; по умолчанию — одна модель задачи. */
  models?: string[]
}

export interface StartTaskOptions {
  /**
   * Workspace задачи — абсолютный путь внутри одного из workspaceRoots. Не задан →
   * ядро само заводит каталог задачи в первом корне. Клиент (кабинет, шлюз) не обязан
   * знать серверные пути и не должен их придумывать.
   *
   * При продолжении треда (threadId) ИГНОРИРУЕТСЯ: workspace берётся у треда, иначе
   * «продолжить» означало бы начать в пустом каталоге — без файлов прошлых ходов.
   */
  workspace?: string
  /**
   * Продолжить существующий тред: новый прогон в ТОМ ЖЕ workspace и с историей
   * предыдущих ходов в контексте. Не задан → заводится новый тред.
   */
  threadId?: number
  prompt: string
  /** Не обязателен, если задан inference (тогда выводится custom-openai). */
  providerId?: ProviderId
  model?: string
  agentMode?: AgentMode
  /** Allowlist инструментов прогона. По умолчанию — STAGE1_TOOLS_ALLOW (fail-closed);
   *  null = все инструменты (только для доверенных сценариев вне общего сервера). */
  toolsAllow?: string[] | null
  turnsBudget?: number
  costCapUsd?: number
  /** Стрим событий прогона наружу (SSE/WS — блок №3 постановки). По умолчанию — дроп. */
  sender?: TaggedSender
  /** DI-шов внутрипроцессного вызова: готовый провайдер вместо createProvider.
   *  Через HTTP недостижим (функция не сериализуется) — для сервера есть providerFactory. */
  providerOverride?: ChatProvider
  /** Маршрут инференса на эту задачу. Задан → прогон идёт через него, секреты
   *  тенанта не читаются и не пишутся. Не задан → прежнее поведение. */
  inference?: TaskInferenceRoute
  /**
   * Durable exactly-once acceptance for the cloud HTTP adapter. The key is opaque;
   * the host binds it to a SHA-256 fingerprint of this semantic request (excluding
   * inference.apiKey) and returns the original run on a replay.
   */
  idempotency?: {
    key: string
    operation: HeadlessTaskOperation
  }
}

export interface StartedTask {
  runId: string
  /** Тред, которому принадлежит прогон. Им продолжают задачу. */
  threadId: number
  sendId: number
  /** True means no new run was accepted; the original durable mapping was returned. */
  replayed: boolean
  /** Резолвится по завершении прогона (любой исход; ошибки уже ушли событиями/в agent_runs). */
  completion: Promise<void>
  stop: () => void
}

/**
 * Строка списка задач тенанта. Задача = ТРЕД, а не отдельный прогон: после первого
 * же уточнения список иначе удваивался бы, и человек переставал понимать, что перед
 * ним — новая задача или продолжение старой.
 *
 * Источник — agent_runs (+ заголовок треда из chat_sessions), а не внешний индекс.
 */
export interface HeadlessTaskSummary {
  /** Идентификатор треда (chat_sessions.id). null — легаси-прогон до тредовой модели. */
  threadId: number | null
  /** ПОСЛЕДНИЙ прогон треда: его статус и есть статус задачи, им же продолжают тред. */
  runId: string
  /** Постановка задачи — первое сообщение треда, а не последнее уточнение. */
  prompt: string
  workspace: string
  providerId: string | null
  model: string | null
  status: string
  /** Время постановки задачи (первый ход треда). */
  createdAt: number
  /** Конец последнего прогона; null — идёт прямо сейчас. */
  endedAt: number | null
  /** Начало последнего хода — по нему список и отсортирован. */
  lastActivityAt: number
  /** Сколько ходов в треде (первый + уточнения). */
  runCount: number
}

/** Сообщение треда. Роли те же, что у чата десктопа. */
export interface HeadlessThreadMessage {
  id: number
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
}

/** Один ход треда: прогон + его durable-таймлайн. */
export interface HeadlessThreadRun {
  runId: string
  status: string
  providerId: string | null
  model: string | null
  startedAt: number
  endedAt: number | null
  events: Array<{ kind: string; label: string | null; detail: string | null; createdAt: number }>
}

/** Задача целиком: сообщения по порядку + ходы по порядку. Всё из БД (переживает рестарт). */
export interface HeadlessThread {
  threadId: number | null
  title: string
  workspace: string
  createdAt: number
  lastActivityAt: number
  messages: HeadlessThreadMessage[]
  runs: HeadlessThreadRun[]
}

export interface HeadlessHost {
  startTask: (opts: StartTaskOptions) => Promise<StartedTask>
  getSecret: (key: string) => string | null
  setSecret: (key: string, value: string) => void
  /**
   * Снять ключ тенанта. Именно удаление строки, а не запись пустого значения: иначе в
   * settings оставался бы шифротекст снятого ключа, и «снял» отличалось бы от «нет».
   */
  deleteSecret: (key: string) => void
  /** Читает durable-таймлайн прогона из БД (переживает рестарт процесса). */
  listRunEvents: (runId: string) => Array<{ kind: string; label: string | null; detail: string | null; createdAt: number }>
  getRunStatus: (runId: string) => string | null
  /**
   * Задачи этого тенанта, новые сверху — ПО ОДНОЙ СТРОКЕ НА ТРЕД. БД у тенанта своя,
   * поэтому фильтровать по пользователю не нужно — здесь только его задачи. Потребителю
   * (кабинет, шлюз) не нужен собственный индекс: список durable и переживает рестарт.
   */
  listTasks: (opts?: { limit?: number }) => HeadlessTaskSummary[]
  /** Тред прогона целиком (сообщения + ходы + таймлайны). null, если прогона нет. */
  getThread: (runId: string) => HeadlessThread | null
  /** Тред, которому принадлежит прогон. null — прогона нет либо он вне тредовой модели. */
  getRunThreadId: (runId: string) => number | null
  /** Workspace прогона — по нему выдаются файлы задачи. null, если прогона нет. */
  getRunWorkspace: (runId: string) => string | null
  /** C1 (P5): хранилище задач по расписанию (список/выключение — для ручек сервиса). */
  scheduledJobs: ScheduledJobs
  /** Один проход расписания вручную (тесты, отладка). Возвращает число запущенных. */
  schedulerTick: () => Promise<number>
  /**
   * Синхронный lifecycle-снимок для bounded tenant registry. `true` означает, что
   * прямо сейчас у хоста нет активного/готовящегося/idempotency-in-flight прогона,
   * нет включённого расписания и shutdown ещё не начался. Registry проверяет свои
   * request leases отдельно и вызывает close() в том же JS turn, без await между
   * проверкой и изъятием из cache.
   *
   * Опциональность сохраняет совместимость с внешними fake/adaptor host'ами:
   * отсутствие метода трактуется registry как «эвиктить нельзя» (fail-closed).
   */
  canEvictIdle?: () => boolean
  /**
   * Закрыть хост, НЕ оборвав живые прогоны. Ждёт их завершения до `timeoutMs`, затем
   * прерывает и даёт финализации дописать статус. Асинхронный не для красоты: синхронное
   * закрытие рвало sqlite под работающим агентом — финализация не доходила до диска, и
   * задача оставалась 'running' до следующего reconcileStale. На деплое это ровно
   * SIGTERM по живым задачам пользователей.
   */
  close: (opts?: { timeoutMs?: number }) => Promise<void>
}

const NOOP_SENDER: TaggedSender = { send: () => {}, exec: async () => undefined }

/** Сколько ждать ЕСТЕСТВЕННОГО завершения прогонов при close(). */
const CLOSE_WAIT_MS = 15_000
/** Сколько ещё ждать финализации после принудительной остановки по таймауту. */
const CLOSE_ABORT_GRACE_MS = 3_000
/**
 * Claim exists only while request preparation has not yet become a durable accepted run.
 * Five minutes avoids a second process stealing a legitimately slow context build, while
 * still allowing a crashed pre-accept request to be retried without manual DB repair.
 */
const IDEMPOTENCY_CLAIM_LEASE_MS = 5 * 60_000
/** A bounded deduplication window; replay never slides this deadline. */
const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60_000

/**
 * Fingerprint of business intent, not credentials or process-local callbacks. In particular,
 * Gateway mints a fresh inference.apiKey for a retry; including it would turn a legitimate
 * replay into a conflict and could leak a secret-derived value into durable state analysis.
 */
export function computeHeadlessTaskRequestHash(
  task: StartTaskOptions,
  operation: HeadlessTaskOperation,
): string {
  const semantic = {
    operation,
    threadId: task.threadId ?? null,
    // A continue always inherits the thread workspace; a supplied workspace is ignored.
    workspace: operation === 'continue' ? null : (task.workspace ?? null),
    prompt: task.prompt,
    providerId: task.providerId ?? (task.inference ? 'custom-openai' : null),
    model: task.model ?? null,
    agentMode: task.agentMode ?? null,
    toolsAllow: task.toolsAllow === undefined ? '__stage1_default__' : task.toolsAllow,
    turnsBudget: task.turnsBudget ?? null,
    costCapUsd: task.costCapUsd ?? null,
    inference: task.inference
      ? { baseUrl: task.inference.baseUrl, models: task.inference.models ?? null }
      : null,
    // Internal/test-only route identity. The callback itself is never serialized.
    providerOverride: Boolean(task.providerOverride),
  }
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex')
}

function normalizeTaskIdempotency(task: StartTaskOptions): {
  key: string
  operation: HeadlessTaskOperation
  requestHash: string
} | null {
  const input = task.idempotency
  if (!input) return null
  if (
    typeof input.key !== 'string'
    || input.key.length < 8
    || input.key.length > 128
    || !/^[A-Za-z0-9._:-]+$/.test(input.key)
  ) {
    throw new HeadlessIdempotencyError(
      HEADLESS_IDEMPOTENCY_INVALID,
      'ключ должен содержать 8–128 символов A-Z, a-z, 0-9, ., _, :, -',
    )
  }
  if ((input.operation === 'create') === (task.threadId != null)) {
    throw new HeadlessIdempotencyError(
      HEADLESS_IDEMPOTENCY_INVALID,
      input.operation === 'create'
        ? 'create-операция не может содержать threadId'
        : 'continue-операция требует threadId',
    )
  }
  return {
    key: input.key,
    operation: input.operation,
    requestHash: computeHeadlessTaskRequestHash(task, input.operation),
  }
}

export async function createHeadlessHost(opts: HeadlessHostOptions): Promise<HeadlessHost> {
  mkdirSync(opts.dataDir, { recursive: true })
  configureRuntimeLogDir(join(opts.dataDir, 'logs'))
  const db = openDb(join(opts.dataDir, 'verstak.db'))
  let schedulerForInitCleanup: Scheduler | null = null
  try {
  const settings = createSettings(db, opts.safeStorage)
  const env = opts.env ?? process.env

  // Секреты: серверное хранилище → env-фолбэк по общему правилу UPPER_CASE.
  const getSecret = (key: string): string | null => {
    const stored = settings.getSecret(key)
    if (stored != null && stored !== '') return stored
    return env[key.toUpperCase()] ?? null
  }

  /**
   * Секреты для прогона. Отличие от getSecret одно: гейт web_access.
   *
   * На десктопе веб-доступ — opt-in (по умолчанию выключен), и это верно: там агент
   * работает с проектом. В облаке веб-чтение — ЗАЯВЛЕННАЯ часть Этапа 1, web_search и
   * web_fetch уже в stage1-allowlist. Без согласования флага получалось худшее из двух:
   * инструмент разрешён, а гейт его гасит — и агент отвечал «веб-доступ выключен»
   * (живая приёмка 04.08). Явная настройка тенанта (web_access='false') побеждает.
   */
  const getSecretForRun = (key: string): string | null => {
    if (key === 'web_access') {
      const explicit = getSecret(key)
      return explicit === null || explicit === '' ? 'true' : explicit
    }
    return getSecret(key)
  }

  const agentRuns = createAgentRuns(db)
  const taskIdempotency = createHeadlessIdempotencyStore(db)
  taskIdempotency.cleanupExpired()
  // Тред задачи = чат-сессия ядра. Отдельной сущности «тред» не заводим: agent_runs.chat_id
  // существует с Manager V1 и уже означает ровно это — «прогоны одного разговора».
  const chatSessions = createChatSessions(db)
  const chats = createChats(db)
  const undoStack = createUndoStack(db)
  const plans = createPlans(db)
  const journal = createJournal(db)
  const connectorRegistry = createConnectorRegistry(getSecret)

  // Скиллы: только явные корни (loader.ts LoaderConfig.roots — рычаг изоляции из отчёта §2).
  let skillRegistry: SkillRegistry | null = null
  if (opts.skillRoots && opts.skillRoots.length > 0) {
    skillRegistry = createSkillRegistry(() => ({ roots: opts.skillRoots, extraDirs: [], serverUrl: null }))
    await skillRegistry.refresh()
  }

  agentRuns.reconcileStale()

  // C1 (P5): расписание. Правда в sqlite — рестарт сервиса подхватывает просроченное
  // одним запуском (recordRun пересчитывает от момента старта, не навёрстывает).
  const scheduledJobs = createScheduledJobs(db)

  let nextSendId = 1

  /**
   * Живые прогоны хоста. Нужны ровно одному потребителю — close(): закрытая под
   * работающим агентом sqlite обрывает финализацию (статус, чекпойнт, ответ в тред),
   * и задача навсегда остаётся 'running'.
   */
  const active = new Map<string, {
    completion: Promise<void>
    abort: () => void
    threadId: number
    sendId: number
  }>()
  /** Coalesces duplicates that arrive while the first request is still preparing context. */
  const idempotencyInFlight = new Map<string, {
    operation: HeadlessTaskOperation
    requestHash: string
    promise: Promise<StartedTask>
  }>()
  // Durable agent_runs появляется только после async-сборки контекста.
  // До этого момента два concurrent continue могли оба пройти DB-проверку.
  const startingThreads = new Set<number>()
  let starting = 0
  let closing = false
  /** Одна lifecycle-операция за раз; после ошибки разрешён явный cleanup retry. */
  let closeInFlight: Promise<void> | null = null
  // prepareSystemContext не принимает AbortSignal. Оборачиваем только ожидание:
  // при shutdown исходный promise может остаться зависшим, но startTask немедленно
  // выходит через catch/finally, освобождает idempotency/global slots и больше не
  // касается SQLite. Это позволяет close() дождаться ПОЛНОГО unwind, а не закрыть
  // БД под продолжением async-функции.
  const preparationAbort = new AbortController()
  const startingZeroWaiters = new Set<() => void>()

  // One host is one tenant, so these are per-user limits.  They bound both
  // resource exhaustion (many simultaneous agents) and durable sqlite/workspace
  // growth from create -> immediately stop loops.
  const configuredActive = Number(opts.maxActiveRuns ?? process.env.VERSTAK_MAX_ACTIVE_RUNS ?? 3)
  const maxActiveRuns = Number.isFinite(configuredActive) ? Math.max(1, Math.floor(configuredActive)) : 3
  const configuredDaily = Number(opts.maxRunsPer24h ?? process.env.VERSTAK_MAX_RUNS_PER_24H ?? 100)
  const maxRunsPer24h = Number.isFinite(configuredDaily)
    ? Math.max(maxActiveRuns, Math.floor(configuredDaily))
    : Math.max(maxActiveRuns, 100)

  /** Ждёт завершения активных прогонов, но не дольше ms. */
  function settleActive(ms: number): Promise<void> {
    if (active.size === 0) return Promise.resolve()
    const all = Promise.allSettled([...active.values()].map(e => e.completion)).then(() => undefined)
    return Promise.race([all, new Promise<void>(resolve => {
      // unref: недождавшийся таймер не должен держать процесс живым после close().
      const timer = setTimeout(resolve, ms)
      if (typeof timer.unref === 'function') timer.unref()
    })])
  }

  function waitForStartingZero(): Promise<void> {
    if (starting === 0) return Promise.resolve()
    return new Promise<void>(resolve => { startingZeroWaiters.add(resolve) })
  }

  function settleStarting(ms: number): Promise<void> {
    if (starting === 0) return Promise.resolve()
    const settled = waitForStartingZero()
    return Promise.race([settled, new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ms)
      if (typeof timer.unref === 'function') timer.unref()
    })])
  }

  function notifyStartingReleased(): void {
    if (starting !== 0) return
    for (const resolve of startingZeroWaiters) resolve()
    startingZeroWaiters.clear()
  }

  function awaitPreparation<T>(operation: Promise<T>): Promise<T> {
    const signal = preparationAbort.signal
    if (signal.aborted) return Promise.reject(new Error('headless-хост закрывается'))
    return new Promise<T>((resolve, reject) => {
      const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
      const onAbort = (): void => {
        cleanup()
        reject(new Error('headless-хост закрывается'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      // Обе ветки подписаны даже после abort, поэтому поздний reject исходной
      // подготовки не превращается в unhandled rejection.
      operation.then(
        value => { cleanup(); resolve(value) },
        error => { cleanup(); reject(error) },
      )
    })
  }

  function replayAcceptedTask(replay: { runId: string; threadId: number }): StartedTask {
    const durable = db.prepare(
      'SELECT chat_id as threadId, send_id as sendId FROM agent_runs WHERE run_id = ?'
    ).get(replay.runId) as { threadId: number | null; sendId: number | null } | undefined
    if (!durable || durable.threadId !== replay.threadId || durable.sendId == null) {
      throw new HeadlessIdempotencyError(
        HEADLESS_IDEMPOTENCY_CORRUPT,
        'сохранённая ссылка на прогон не совпадает с durable agent_runs',
      )
    }
    const live = active.get(replay.runId)
    return {
      runId: replay.runId,
      threadId: replay.threadId,
      sendId: durable.sendId,
      replayed: true,
      completion: live?.completion ?? Promise.resolve(),
      stop: live?.abort ?? (() => {}),
    }
  }

  async function startTaskOnce(
    task: StartTaskOptions,
    idempotencyMeta: ReturnType<typeof normalizeTaskIdempotency>,
  ): Promise<StartedTask> {
    if (closing) throw new Error('headless-хост закрывается')
    // Headless tasks cannot prove a fresh visible desktop-composer gesture.
    // Reject before idempotency claims, workspace creation, provider setup or
    // any durable user row so the raw instruction never enters runtime sinks.
    if (isComputerUseComposerAttempt(task.prompt)) {
      throw new Error('COMPUTER_USE_FRESH_COMPOSER_REQUIRED: Computer Use доступен только из нового сообщения в desktop composer.')
    }
    // Exactly-once replay is not a new start and therefore must not consume or be
    // rejected by active/daily capacity. Conflict is detected at this same point.
    if (idempotencyMeta) {
      const existing = taskIdempotency.lookup(
        idempotencyMeta.key,
        idempotencyMeta.operation,
        idempotencyMeta.requestHash,
      )
      if (existing.kind === 'completed') return replayAcceptedTask(existing)
      if (existing.kind === 'pending') {
        throw new HeadlessIdempotencyError(
          HEADLESS_IDEMPOTENCY_PENDING,
          'первый запрос ещё готовится и не принят durable',
          existing.retryAfterSeconds,
        )
      }
    }
    if (active.size + starting >= maxActiveRuns) {
      throw new Error(`HEADLESS_CAPACITY_ACTIVE: одновременно можно запустить не более ${maxActiveRuns} задач`)
    }
    const recentRuns = Number((db.prepare(
      "SELECT COUNT(*) AS n FROM agent_runs WHERE owner = 'main' AND started_at >= ?"
    ).get(Date.now() - 24 * 60 * 60 * 1000) as { n: number }).n)
    if (recentRuns + starting >= maxRunsPer24h) {
      throw new Error(`HEADLESS_CAPACITY_DAILY: можно запустить не более ${maxRunsPer24h} задач за 24 часа`)
    }

    // Один общий синхронный reservation на ВСЕ tenant-host'ы процесса. Он берётся
    // до первого await и держится через context preparation и весь provider run.
    const globalLease = opts.globalRunCapacity?.tryAcquire() ?? null
    if (opts.globalRunCapacity && !globalLease) {
      throw new Error(
        `HEADLESS_CAPACITY_GLOBAL: одновременно во всём сервисе можно запустить не более ${opts.globalRunCapacity.limit} задач`
      )
    }
    let globalLeaseTransferred = false
    let idempotencyClaim: HeadlessIdempotencyClaim | null = null
    let startingReserved = false
    let reservedThreadId: number | null = null
    let durableAccepted = false
    let createdWorkspace: string | null = null
    try {
    if (idempotencyMeta) {
      const claimed = taskIdempotency.claim({
        ...idempotencyMeta,
        leaseMs: IDEMPOTENCY_CLAIM_LEASE_MS,
        retentionMs: IDEMPOTENCY_RETENTION_MS,
      })
      if (claimed.kind === 'completed') return replayAcceptedTask(claimed)
      if (claimed.kind === 'pending') {
        throw new HeadlessIdempotencyError(
          HEADLESS_IDEMPOTENCY_PENDING,
          'первый запрос ещё готовится и не принят durable',
          claimed.retryAfterSeconds,
        )
      }
      idempotencyClaim = claimed.claim
    }
    starting += 1
    startingReserved = true
    // Продолжение треда: workspace НАСЛЕДУЕТСЯ, а не берётся из запроса. Иначе клиент
    // мог бы «продолжить» задачу в чужом каталоге — и тем увести файлы треда наружу.
    const existingThread = task.threadId != null ? chatSessions.get(task.threadId) : null
    if (task.threadId != null && !existingThread) throw new Error('тред задачи не найден')
    if (existingThread) {
      // Async function исполняется синхронно до первого await, поэтому
      // reservation закрывает TOCTOU без глобальной блокировки других тредов.
      if (startingThreads.has(existingThread.id)) {
        throw new Error('в треде уже идёт прогон — дождитесь завершения или остановите его')
      }
      startingThreads.add(existingThread.id)
      reservedThreadId = existingThread.id
    }

    let workspace = existingThread?.projectPath ?? task.workspace
    if (!workspace) {
      // Каталог задачи заводит ядро: имя от времени+случайности, внутри корня тенанта.
      workspace = join(opts.workspaceRoots[0], `task-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`)
      mkdirSync(workspace, { recursive: true })
      createdWorkspace = workspace
    }
    if (!isWithinKnownRoots(workspace, opts.workspaceRoots)) {
      throw new Error('workspace задачи вне разрешённых корней хоста')
    }
    // Маршрут инференса однозначно задаёт провайдера, поэтому providerId при нём
    // необязателен: клиент не обязан дублировать то, что уже сказано блоком. Явно
    // переданный providerId побеждает.
    const providerId = (task.providerId ?? (task.inference ? 'custom-openai' : undefined)) as ProviderId
    const descriptor = PROVIDERS[providerId]
    if (!descriptor) throw new Error(`неизвестный провайдер: ${task.providerId}`)
    const hasInjectedProvider = Boolean(task.providerOverride) || Boolean(opts.providerFactory) || Boolean(task.inference)
    if (!hasInjectedProvider && descriptor.transport !== 'API') {
      // Этап 1: только API-транспорт (CLI-провайдеры требуют интерактивного OAuth на машине).
      throw new Error(`headless-хост Этапа 1 поддерживает только API-провайдеры (${providerId}: ${descriptor.transport})`)
    }

    // Один живой прогон на тред. Два агента в одном каталоге писали бы друг поверх
    // друга, а история второго не содержала бы хода первого — «продолжение» вышло бы
    // не продолжением, а гонкой.
    if (existingThread && db.prepare(
      'SELECT 1 FROM agent_runs WHERE chat_id = ? AND ended_at IS NULL LIMIT 1'
    ).get(existingThread.id)) {
      throw new Error('в треде уже идёт прогон — дождитесь завершения или остановите его')
    }

    const ctrl = new AbortController()
    const sendId = nextSendId++
    const runId = randomUUID()
    const model = task.model ?? descriptor.defaultModel
    const baseSender = task.sender ?? NOOP_SENDER

    let provider = task.providerOverride
      ?? opts.providerFactory?.(providerId, model, ctrl.signal, workspace)
      ?? undefined
    if (!provider && task.inference) {
      // Per-task маршрут: OpenAI-совместимый эндпоинт с токеном прогона. Секреты
      // тенанта здесь не читаются и не пишутся — токен нигде не оседает.
      provider = createProvider('custom-openai', {
        apiKey: task.inference.apiKey,
        model,
        cwd: workspace,
        signal: ctrl.signal,
        customBaseUrl: task.inference.baseUrl,
        customModels: task.inference.models ?? [model]
      })
    }
    if (!provider) {
      const apiKey = descriptor.secretKey ? getSecret(descriptor.secretKey) : null
      const runtimeOptions = buildProviderRuntimeOptions({
        providerId,
        account: null,
        getSecret
      })
      provider = createProvider(providerId, {
        apiKey: apiKey ?? undefined,
        model,
        cwd: workspace,
        signal: ctrl.signal,
        codexHome: runtimeOptions.codexHome,
        customBaseUrl: runtimeOptions.customBaseUrl,
        customModels: runtimeOptions.customModels,
        yandexFolderId: runtimeOptions.yandexFolderId,
        gigachatClientSecret: runtimeOptions.gigachatClientSecret,
        gigachatTlsVerify: runtimeOptions.gigachatTlsVerify,
        checkModel: runtimeOptions.checkModel
      })
    }

    const tools = createToolsForProject(workspace, ctrl.signal, {})

    // История треда идёт в контекст ходом ранее записанными сообщениями — той же
    // формой user/assistant, какую десктопный renderer шлёт в ai:send. Роль 'system'
    // отсеиваем: системный слой собирается заново на каждый прогон.
    const priorMessages: ChatMessage[] = (existingThread ? chats.listBySession(existingThread.id) : [])
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }))
    const userMsg: ChatMessage = { role: 'user', content: task.prompt }

    const composed = await awaitPreparation(prepareSystemContext({
      // Облачная персона вместо десктопной: в облаке нет проекта и кода, а десктопный
      // слой заставлял агента отказываться от обычных деловых задач.
      systemLayer: CLOUD_SYSTEM_LAYER_PROMPT,
      projectPath: workspace,
      messages: [...priorMessages, userMsg],
      recentWrites: undoStack.list(workspace).slice(0, 8).map(e => ({ filePath: e.filePath, createdAt: e.createdAt }))
    }))
    // SIGTERM мог прийти, пока асинхронно собирался контекст. После этой точки до
    // active.set() нет await: либо старт становится видимым close(), либо не пишет
    // в уже закрытую БД и не оставляет orphan chat/message без agent_run.
    if (closing) throw new Error('headless-хост закрывается')

    const agentMode = task.agentMode ?? 'auto'

    // One acceptance transaction. A process can crash before it (only a fenced pending
    // claim remains) or after it (the exact run/thread mapping is replayable); it can no
    // longer leave a thread/message without a run or call the provider before the mapping.
    const persistAccepted = db.transaction(() => {
      // Тред: существующий продолжаем, иначе заводим. Заголовок = первая постановка.
      const acceptedThread = existingThread ?? chatSessions.create(workspace, {
        title: task.prompt.slice(0, 200), providerId, model
      })
      chats.appendToSession(acceptedThread.id, workspace, 'user', task.prompt)

      // Продовая форма старта: agent_runs + user_msg первым событием Timeline.
      agentRuns.create({
        runId, projectPath: workspace, chatId: acceptedThread.id, owner: 'main',
        title: task.prompt.slice(0, 200), providerId, model,
        requestedProviderId: providerId, requestedModel: model,
        sendId, agentMode, accountId: null
      })
      agentRuns.appendEvent(runId, 'user_msg', { detail: task.prompt.slice(0, 500) })
      if (idempotencyClaim) {
        taskIdempotency.complete(idempotencyClaim, runId, acceptedThread.id)
      }
      return acceptedThread
    })
    const thread = persistAccepted()
    durableAccepted = true
    logRuntime('headless.task.start', { runId, sendId, threadId: thread.id, providerId, model, workspace })

    // Ответ агента копим из text-событий — того же источника, из которого десктопный
    // renderer собирает сообщение ассистента. В agent_run_events он лежит обрезанным
    // до 500 символов, а в чекпойнте — только пока прогон не завершился чисто; ни то,
    // ни другое следующим ходом читать нельзя.
    let assistantText = ''
    const sender: TaggedSender = {
      send: (channel, payload) => {
        const event = payload.event as { type?: string; text?: string } | undefined
        if (event?.type === 'text' && typeof event.text === 'string') assistantText += event.text
        baseSender.send(channel, payload)
      },
      exec: (code: string) => baseSender.exec(code)
    }
    const persistAssistant = (): void => {
      if (!assistantText.trim()) return
      try {
        chats.appendToSession(thread.id, workspace, 'assistant', assistantText)
      } catch (err) {
        // Тред без ответа агента хуже упавшего прогона — оставляем след, а не тишину.
        logRuntime('headless.thread.assistant-persist-failed', {
          runId, threadId: thread.id, error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    const runCompletion = runApiConversation({
      sender, sendId, provider, tools, projectPath: workspace,
      initialMessages: [{ role: 'system', content: composed.system }, ...priorMessages, userMsg],
      signal: ctrl.signal,
      recordWrite: (projectPath: string, filePath: string, before: string | null, after: string, provenance?: { runId?: string | null; chatId?: number | null; messageId?: number | null }) =>
        undoStack.push(projectPath, filePath, before, after, provenance),
      recordPlan: (projectPath: string, title: string, steps: NewStep[], meta?: CreatePlanMeta) =>
        ({ id: plans.create(projectPath, title, steps, meta).id }),
      getPlan: (id: number) => plans.get(id),
      plans,
      recordJournal: (projectPath: string, kind: JournalKind, title: string, detail?: string | null) =>
        journal.append(projectPath, kind, title, detail ?? null),
      readJournal: (projectPath: string, limit?: number) => journal.list(projectPath, limit).map(e => ({
        kind: e.kind, title: e.title, detail: e.detail, createdAt: e.createdAt
      })),
      saveMemory: (projectPath: string, type: string, content: string, tags?: string[]) =>
        saveMemory(db, projectPath, type as import('../storage/memories').MemoryType, content, tags ?? []),
      invalidateMemory: (id: string, supersededBy?: string) => invalidateMemory(db, id, supersededBy),
      // Project Brain на headless-хосте Этапа 1 не поднимается — save_decision пишет в журнал,
      // чтобы решение не терялось молча (след вместо тихого дропа).
      saveDecision: (projectPath: string, rec: unknown) => {
        journal.append(projectPath, 'note', (rec as { title?: string }).title ?? 'decision', JSON.stringify(rec))
        return { id: 0 } as never
      },
      searchMemories: (projectPath: string, query: string, limit?: number) => searchMemories(db, projectPath, query, limit),
      searchConversations: (projectPath: string, query: string, limit?: number) => searchConversations(db, projectPath, query, limit),
      connectors: {
        // ssh и прочие STAGE1_CONNECTOR_DENY на общем сервере не существуют вовсе:
        // ни в списке, ни в query (fail-closed, а не только read-only политика).
        list: () => connectorRegistry.list().filter(c => !STAGE1_CONNECTOR_DENY.has(c.id)).map(c => ({ ...c })),
        query: (id: string, args: Record<string, unknown>, signal: AbortSignal) => {
          if (STAGE1_CONNECTOR_DENY.has(id)) {
            return Promise.reject(new Error(`коннектор '${id}' отключён на сервере Этапа 1`))
          }
          // Блок №6: локальные чтения коннекторов заперты workspace задачи.
          return connectorRegistry.query(id, args, { getSecret, signal, allowedReadRoots: [workspace] })
        }
      },
      agentMode,
      // V2-2: было захардкожено 8 — то самое опровергнутое собственным замером
      // число, мимо resolveTurnsBudget. Облачная задача идёт БЕЗ человека рядом,
      // и упереться в стену ей дороже всего. Теперь общий resolver: явный бюджет
      // запроса побеждает, иначе дефолт продукта.
      turnsBudget: resolveTurnsBudget(task.turnsBudget, false),
      autoContinueTurns: task.turnsBudget === undefined,
      // Этап 1: unattended — коннекторы read-only, артефакты «downloads» падают в workspace.
      readOnlyConnectors: true,
      artifactsDownloadsDir: workspace,
      skillRegistry: skillRegistry
        ? {
            list: () => skillRegistry!.list().map(s => ({
              id: s.id, name: s.name, default_provider: s.default_provider,
              default_model: s.default_model ?? undefined, systemPrompt: s.systemPrompt
            }))
          }
        : undefined,
      getSecretForDelegate: getSecretForRun,
      costGuard: createCostGuard(task.costCapUsd ?? 5),
      providerId,
      model,
      agentRuns,
      runId,
      // C1 (P5): создание задач по расписанию из прогона. Дефолты — из ЭТОГО прогона:
      // модель не обязана знать провайдера и workspace, чтобы поставить «ту же ревизию
      // на 9 утра». Прямой ScheduledJobs наружу не отдаём — только create с дефолтами.
      scheduledJobs: {
        create: (job: { name: string; prompt: string; schedule: import('../storage/scheduled-jobs').ScheduleSpec; maxRuns: number; providerId?: string | null; model?: string | null; workspace?: string | null }) => {
          const created = scheduledJobs.create({
            ...job,
            providerId: job.providerId ?? providerId,
            model: job.model ?? model,
            workspace: job.workspace ?? workspace
          })
          return { id: created.id, nextRunAt: created.nextRunAt, maxRuns: created.maxRuns }
        }
      },
      // undefined → дефолт Этапа 1; явный null = «все инструменты» задаётся сознательно.
      toolsAllow: task.toolsAllow === undefined
        ? (opts.enableScheduledTasks === false ? STAGE1_CANARY_TOOLS_ALLOW : STAGE1_TOOLS_ALLOW)
        : task.toolsAllow
      // Каст через unknown: опциональные фасады (subSessions, verifications, pipelineRuns…)
      // на Этапе 1 сознательно не поднимаются — им соответствуют выключенные инструменты.
    } as unknown as Parameters<typeof runApiConversation>[0])
      // Ответ пишем на ЛЮБОМ исходе: оборванный прогон, успевший что-то сказать, для
      // следующего хода такой же контекст, как удачный. Ошибку пробрасываем дальше —
      // семантика completion не меняется.
      .then(() => { persistAssistant() }, (err: unknown) => { persistAssistant(); throw err })

    // Реестр живых прогонов для close(). Снимаем на ЛЮБОМ исходе — иначе упавший
    // прогон держал бы закрытие хоста до самого таймаута.
    // Awaiting completion must also mean that the capacity slot has been released.
    // Keeping cleanup on a detached promise left a one-microtask false 429 window.
    const completion = runCompletion.finally(() => {
      active.delete(runId)
      globalLease?.release()
    })
    active.set(runId, { completion, abort: () => ctrl.abort(), threadId: thread.id, sendId })
    globalLeaseTransferred = globalLease !== null
    void completion.catch(() => undefined)

    return {
      runId,
      threadId: thread.id,
      sendId,
      replayed: false,
      completion,
      stop: () => ctrl.abort()
    }
    } catch (err) {
      // Until the acceptance transaction commits there was no provider call and no
      // durable task. Releasing only our fenced token makes the same request retryable;
      // after acceptance the completed mapping is deliberately permanent.
      if (idempotencyClaim && !durableAccepted) {
        try {
          taskIdempotency.releaseRetryable(idempotencyClaim)
        } catch (releaseError) {
          // close() may already have closed SQLite while async context preparation was
          // unwinding. The finite lease remains the crash-safe recovery path.
          logRuntime('headless.idempotency.release-failed', {
            error: releaseError instanceof Error ? releaseError.message : String(releaseError),
          })
        }
      }
      // Авто-workspace принадлежит именно этому НОВОМУ старту и до acceptance
      // недоступен пользователю. При отказе удаляем только его. Явный workspace и
      // workspace существующего треда никогда не трогаем.
      if (
        !durableAccepted
        && createdWorkspace
        && isWithinKnownRoots(createdWorkspace, opts.workspaceRoots)
      ) {
        try {
          rmSync(createdWorkspace, { recursive: true, force: true })
        } catch (cleanupError) {
          logRuntime('headless.workspace.preaccept-cleanup-failed', {
            workspace: createdWorkspace,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          })
        }
      }
      throw err
    } finally {
      if (startingReserved) starting = Math.max(0, starting - 1)
      if (reservedThreadId != null) startingThreads.delete(reservedThreadId)
      if (!globalLeaseTransferred) globalLease?.release()
      notifyStartingReleased()
    }
  }

  async function startTask(task: StartTaskOptions): Promise<StartedTask> {
    const idempotencyMeta = normalizeTaskIdempotency(task)
    if (!idempotencyMeta) return startTaskOnce(task, null)

    const inFlight = idempotencyInFlight.get(idempotencyMeta.key)
    if (inFlight) {
      if (
        inFlight.operation !== idempotencyMeta.operation
        || inFlight.requestHash !== idempotencyMeta.requestHash
      ) {
        throw new HeadlessIdempotencyError(
          HEADLESS_IDEMPOTENCY_CONFLICT,
          'ключ уже используется другим незавершённым запросом',
        )
      }
      const original = await inFlight.promise
      return { ...original, replayed: true }
    }

    const promise = startTaskOnce(task, idempotencyMeta)
    idempotencyInFlight.set(idempotencyMeta.key, {
      operation: idempotencyMeta.operation,
      requestHash: idempotencyMeta.requestHash,
      promise,
    })
    try {
      return await promise
    } finally {
      if (idempotencyInFlight.get(idempotencyMeta.key)?.promise === promise) {
        idempotencyInFlight.delete(idempotencyMeta.key)
      }
    }
  }

  // C1 (P5): исполнитель расписания. Прогон ЖЁСТКО в 'auto' (unattended; план-гейт
  // в auto не применяется по построению — закреплено пином scheduler.test.ts).
  // pollMs=null — потребитель выключил цикл (тесты дёргают schedulerTick сами).
  const schedulerStart: Parameters<typeof startScheduler>[0]['startTask'] = async (t) => {
    const started = await startTask({
      prompt: t.prompt,
      workspace: t.workspace,
      providerId: t.providerId as ProviderId | undefined,
      model: t.model,
      agentMode: t.agentMode
    })
    return { runId: started.runId, completion: started.completion }
  }
  const scheduler: Scheduler = startScheduler({
    jobs: scheduledJobs,
    startTask: schedulerStart,
    pollMs: opts.schedulerPollMs === undefined ? 30_000 : opts.schedulerPollMs
  })
  schedulerForInitCleanup = scheduler

  return {
    startTask,
    getSecret,
    setSecret: (key, value) => settings.setSecret(key, value),
    deleteSecret: (key) => { db.prepare('DELETE FROM settings WHERE key = ?').run(key) },
    listRunEvents: (runId) => (db.prepare(
      'SELECT kind, label, detail, created_at as createdAt FROM agent_run_events WHERE run_id = ? ORDER BY id'
    ).all(runId) as Array<{ kind: string; label: string | null; detail: string | null; createdAt: number }>),
    getRunStatus: (runId) => {
      const row = db.prepare('SELECT status FROM agent_runs WHERE run_id = ?').get(runId) as { status: string } | undefined
      return row?.status ?? null
    },
    listTasks: (listOpts) => {
      const limit = Math.max(1, Math.min(listOpts?.limit ?? 50, 200))
      // Одна строка на ТРЕД. Группируем по chat_id; прогоны без треда (легаси до этой
      // модели) остаются каждый сам себе задачей — COALESCE(chat_id, -rowid) даёт им
      // персональный ключ, а не сваливает в одну кучу (chat_id никогда не отрицателен).
      // MAX(rowid) = последний вставленный прогон треда: тот же тай-брейк «вставлен
      // позже = новее», что в storage/agent-runs.
      return db.prepare(
        `SELECT r.run_id as runId,
                r.chat_id as threadId,
                COALESCE(cs.title, r.title) as prompt,
                r.project_path as workspace,
                r.provider_id as providerId, r.model as model, r.status as status,
                r.ended_at as endedAt, r.started_at as lastActivityAt,
                t.createdAt as createdAt, t.runCount as runCount
         FROM agent_runs r
         JOIN (
           SELECT COALESCE(chat_id, -rowid) as k,
                  MIN(started_at) as createdAt,
                  COUNT(*) as runCount,
                  MAX(rowid) as lastRowid
           FROM agent_runs WHERE owner = 'main' GROUP BY k
         ) t ON r.rowid = t.lastRowid
         LEFT JOIN chat_sessions cs ON cs.id = r.chat_id
         ORDER BY r.started_at DESC, r.rowid DESC LIMIT ?`
      ).all(limit) as HeadlessTaskSummary[]
    },
    getThread: (runId) => {
      const anchor = db.prepare(
        'SELECT chat_id as threadId, project_path as workspace, title FROM agent_runs WHERE run_id = ?'
      ).get(runId) as { threadId: number | null; workspace: string; title: string } | undefined
      if (!anchor) return null
      const session = anchor.threadId != null ? chatSessions.get(anchor.threadId) : null
      // Ходы треда по порядку. Легаси-прогон без chat_id — тред из самого себя: честнее
      // отдать одну задачу, чем притвориться, что её нет.
      const runs = (anchor.threadId != null
        ? db.prepare(
          `SELECT run_id as runId, status, provider_id as providerId, model,
                  started_at as startedAt, ended_at as endedAt
           FROM agent_runs WHERE chat_id = ? ORDER BY started_at ASC, rowid ASC`
        ).all(anchor.threadId)
        : db.prepare(
          `SELECT run_id as runId, status, provider_id as providerId, model,
                  started_at as startedAt, ended_at as endedAt
           FROM agent_runs WHERE run_id = ?`
        ).all(runId)) as Array<Omit<HeadlessThreadRun, 'events'>>
      const eventsOf = db.prepare(
        'SELECT kind, label, detail, created_at as createdAt FROM agent_run_events WHERE run_id = ? ORDER BY id'
      )
      const messages = anchor.threadId != null
        ? chats.listBySession(anchor.threadId).map(m => ({
          id: m.id, role: m.role, content: m.content, createdAt: m.createdAt
        }))
        : []
      return {
        threadId: anchor.threadId,
        title: session?.title ?? anchor.title,
        workspace: session?.projectPath ?? anchor.workspace,
        createdAt: session?.createdAt ?? runs[0]?.startedAt ?? 0,
        lastActivityAt: session?.lastMessageAt ?? runs[runs.length - 1]?.startedAt ?? 0,
        messages,
        runs: runs.map(r => ({
          ...r,
          events: eventsOf.all(r.runId) as HeadlessThreadRun['events']
        }))
      }
    },
    getRunThreadId: (runId) => {
      const row = db.prepare('SELECT chat_id as threadId FROM agent_runs WHERE run_id = ?')
        .get(runId) as { threadId: number | null } | undefined
      return row?.threadId ?? null
    },
    getRunWorkspace: (runId) => {
      const row = db.prepare('SELECT project_path as workspace FROM agent_runs WHERE run_id = ?')
        .get(runId) as { workspace: string } | undefined
      return row?.workspace ?? null
    },
    scheduledJobs,
    schedulerTick: () => scheduler.tick(),
    canEvictIdle: () => (
      !closing
      && active.size === 0
      && starting === 0
      && idempotencyInFlight.size === 0
      && !scheduledJobs.list().some(job => job.enabled)
    ),
    close: (closeOpts) => {
      if (closeInFlight) return closeInFlight
      const operation = (async (): Promise<void> => {
        closing = true
        scheduler.stop()  // новые запуски по расписанию во время закрытия не стартуют
        const waitMs = closeOpts?.timeoutMs ?? CLOSE_WAIT_MS
        if (active.size > 0 || starting > 0) {
          logRuntime('headless.host.close.waiting', { active: active.size, starting, waitMs })
          // Один общий grace period: starting/context preparation и уже принятые
          // прогоны ждём параллельно, чтобы shutdown budget не складывался.
          await Promise.all([settleActive(waitMs), settleStarting(waitMs)])
        }
        if (active.size > 0 || starting > 0) {
          // Время вышло. Provider run'ы получают свой AbortSignal; зависшая сборка
          // контекста — отдельный lifecycle signal, потому что compose API signal не
          // принимает. После него ОБЯЗАТЕЛЬНО ждём starting=0 до закрытия SQLite.
          logRuntime('headless.host.close.aborting', { active: active.size, starting })
          for (const entry of [...active.values()]) entry.abort()
          preparationAbort.abort()
          await Promise.all([settleActive(CLOSE_ABORT_GRACE_MS), waitForStartingZero()])
        }
        if (active.size > 0) {
          // Прогон не отпустил даже после abort (провайдер не слушает сигнал). Ставим
          // честный терминальный статус ТЕМ ЖЕ механизмом, что и старт после краха —
          // иначе на диске остаётся 'running', которого уже некому завершить.
          const stuck = agentRuns.reconcileStale()
          logRuntime('headless.host.close.reconciled', { active: active.size, stuck })
        }
        // Registry не разрешает новые request leases после начала closeAll. Уже
        // выданные (включая живой SSE) должны отпуститься до db.close(). Для SSE это
        // происходит после completion/abort выше, когда server завершает response.
        await opts.beforeCloseDb?.()
        // `open` отличает идемпотентный повтор от реальной ошибки close(). Реальную
        // ошибку нельзя глотать: registry обязан сохранить slot fail-closed.
        if (db.open) db.close()
      })()
      closeInFlight = operation
      void operation.catch(() => {
        if (closeInFlight === operation) closeInFlight = null
      })
      return operation
    }
  }
  } catch (err) {
    // Неуспешный init не попадает в registry cache. Без явного cleanup повторные
    // попытки одного tenant обходили бы hard cap, оставляя SQLite handles за бортом.
    schedulerForInitCleanup?.stop()
    try { db.close() } catch { /* init уже успел закрыть БД */ }
    throw err
  }
}
