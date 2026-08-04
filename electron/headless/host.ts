import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { join } from 'path'

import { openDb } from '../storage/db'
import { createSettings, type SafeStorageLike } from '../storage/settings'
import { createAgentRuns } from '../storage/agent-runs'
import { createUndoStack } from '../storage/undo'
import { createPlans } from '../storage/plans'
import { createJournal } from '../storage/journal'
import { saveMemory, invalidateMemory, searchMemories } from '../storage/memories'
import { searchConversations } from '../storage/chats'

import { createConnectorRegistry } from '../connectors/registry'
import { PROVIDERS, createProvider, type ProviderId } from '../ai/registry'
import { createToolsForProject } from '../ai/tools'
import { createCostGuard } from '../ai/cost-guard'
import { prepareSystemContext } from '../ai/compose-system'
import { isWithinKnownRoots } from '../ai/path-policy'
import { runApiConversation } from '../ai/runner-api'
import { configureRuntimeLogDir, logRuntime } from '../runtime-log'
import { createSkillRegistry } from '../ai/skills/registry'
import type { SkillRegistry } from '../ai/skills/types'
import type { ChatProvider, ChatMessage } from '../ai/types'
import type { TaggedSender } from '../ipc/tool-handlers/shared'
import { buildProviderRuntimeOptions } from '../ipc/ai-send/provider-options'
import { STAGE1_TOOLS_ALLOW, STAGE1_CONNECTOR_DENY } from './stage1'
import { CLOUD_SYSTEM_LAYER_PROMPT } from './cloud-layer'
import type { AgentMode } from '../ai/mode-policy'
import type { NewStep, CreatePlanMeta } from '../storage/plans'
import type { JournalKind } from '../storage/journal'

// Headless-хост агентного ядра (Этап 1а облачного Verstak, блок №2 постановки;
// карта — docs/headless-core-recon-2026-08-04.md). Второй потребитель ТЕХ ЖЕ модулей
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
   */
  workspace?: string
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
}

export interface StartedTask {
  runId: string
  sendId: number
  /** Резолвится по завершении прогона (любой исход; ошибки уже ушли событиями/в agent_runs). */
  completion: Promise<void>
  stop: () => void
}

/** Строка списка задач тенанта. Источник — agent_runs, а не внешний индекс. */
export interface HeadlessRunSummary {
  runId: string
  /** Постановка задачи (title прогона). */
  prompt: string
  workspace: string
  providerId: string | null
  model: string | null
  status: string
  createdAt: number
  endedAt: number | null
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
   * Задачи этого тенанта, новые сверху. БД у тенанта своя, поэтому фильтровать по
   * пользователю не нужно — здесь только его прогоны. Потребителю (кабинет, шлюз)
   * больше не нужен собственный индекс задач: список durable и переживает рестарт.
   */
  listRuns: (opts?: { limit?: number }) => HeadlessRunSummary[]
  /** Workspace прогона — по нему выдаются файлы задачи. null, если прогона нет. */
  getRunWorkspace: (runId: string) => string | null
  close: () => void
}

const NOOP_SENDER: TaggedSender = { send: () => {}, exec: async () => undefined }

export async function createHeadlessHost(opts: HeadlessHostOptions): Promise<HeadlessHost> {
  mkdirSync(opts.dataDir, { recursive: true })
  configureRuntimeLogDir(join(opts.dataDir, 'logs'))
  const db = openDb(join(opts.dataDir, 'verstak.db'))
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

  let nextSendId = 1

  async function startTask(task: StartTaskOptions): Promise<StartedTask> {
    let workspace = task.workspace
    if (!workspace) {
      // Каталог задачи заводит ядро: имя от времени+случайности, внутри корня тенанта.
      workspace = join(opts.workspaceRoots[0], `task-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`)
      mkdirSync(workspace, { recursive: true })
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

    const ctrl = new AbortController()
    const sendId = nextSendId++
    const runId = randomUUID()
    const model = task.model ?? descriptor.defaultModel
    const sender = task.sender ?? NOOP_SENDER

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
    const userMsg: ChatMessage = { role: 'user', content: task.prompt }
    const composed = await prepareSystemContext({
      // Облачная персона вместо десктопной: в облаке нет проекта и кода, а десктопный
      // слой заставлял агента отказываться от обычных деловых задач.
      systemLayer: CLOUD_SYSTEM_LAYER_PROMPT,
      projectPath: workspace,
      messages: [userMsg],
      recentWrites: undoStack.list(workspace).slice(0, 8).map(e => ({ filePath: e.filePath, createdAt: e.createdAt }))
    })
    const agentMode = task.agentMode ?? 'auto'

    // Продовая форма старта прогона (openAgentRun, ipc/ai-send/run-bookkeeping.ts):
    // строка agent_runs + user_msg первым событием таймлайна.
    agentRuns.create({
      runId, projectPath: workspace, chatId: null, owner: 'main',
      title: task.prompt.slice(0, 200), providerId, model,
      requestedProviderId: providerId, requestedModel: model,
      sendId, agentMode, accountId: null
    })
    agentRuns.appendEvent(runId, 'user_msg', { detail: task.prompt.slice(0, 500) })
    logRuntime('headless.task.start', { runId, sendId, providerId, model, workspace })

    const completion = runApiConversation({
      sender, sendId, provider, tools, projectPath: workspace,
      initialMessages: [{ role: 'system', content: composed.system }, userMsg],
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
      turnsBudget: task.turnsBudget ?? 8,
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
      // undefined → дефолт Этапа 1; явный null = «все инструменты» задаётся сознательно.
      toolsAllow: task.toolsAllow === undefined ? STAGE1_TOOLS_ALLOW : task.toolsAllow
      // Каст через unknown: опциональные фасады (subSessions, verifications, pipelineRuns…)
      // на Этапе 1 сознательно не поднимаются — им соответствуют выключенные инструменты.
    } as unknown as Parameters<typeof runApiConversation>[0]).then(() => undefined)

    return {
      runId,
      sendId,
      completion,
      stop: () => ctrl.abort()
    }
  }

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
    listRuns: (listOpts) => {
      // rowid DESC — тай-брейк для прогонов одной миллисекунды (как в storage/agent-runs).
      const limit = Math.max(1, Math.min(listOpts?.limit ?? 50, 200))
      return db.prepare(
        `SELECT run_id as runId, title as prompt, project_path as workspace,
                provider_id as providerId, model, status,
                started_at as createdAt, ended_at as endedAt
         FROM agent_runs ORDER BY started_at DESC, rowid DESC LIMIT ?`
      ).all(limit) as HeadlessRunSummary[]
    },
    getRunWorkspace: (runId) => {
      const row = db.prepare('SELECT project_path as workspace FROM agent_runs WHERE run_id = ?')
        .get(runId) as { workspace: string } | undefined
      return row?.workspace ?? null
    },
    close: () => { try { db.close() } catch { /* уже закрыта */ } }
  }
}
