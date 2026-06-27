import type { Database } from 'better-sqlite3'

/**
 * Multi-agent Manager V1 (Фаза 1) — тонкий слой «задача» поверх существующего
 * run_id (один ai:send = одна строка agent_runs). Субы / todos / файлы /
 * артефакты / верификация уже связаны с прогоном (parentChatId / run_id в
 * audit/plan_steps) — Manager их агрегирует и даёт lifecycle.
 *
 * Owner — из SendOwner: main (обычный чат), review (Explicit Review),
 * delegate (в V1 не создаёт top-level run), background (autonomous loop).
 * Status — queued → running → (waiting_review) → done/failed/stopped.
 *
 * agent_run_events — append-only Timeline задачи (user_msg / assistant_msg /
 * tool_call / delegate / todo / file_write / artifact / verify / status / error).
 *
 * ВАЖНО: эту таблицу позже дополнит Crash-resume (P1) колонками живого прогресса
 * (turn_index / last_tool_name / …) через ALTER — не дублировать таблицу.
 */

export type AgentRunOwner = 'main' | 'review' | 'delegate' | 'background'
export type AgentRunStatus = 'queued' | 'running' | 'waiting_review' | 'done' | 'failed' | 'stopped'

export interface AgentRun {
  runId: string
  projectPath: string
  chatId: number | null
  owner: AgentRunOwner
  title: string
  status: AgentRunStatus
  providerId: string | null
  model: string | null
  sendId: number | null
  agentsCount: number
  toolCount: number
  filesCount: number
  costCents: number
  error: string | null
  startedAt: number
  endedAt: number | null
  // Crash-resume (P1, миграция 19): живой прогресс. NULL/0 у прогонов,
  // запущенных до миграции.
  turnIndex: number
  lastToolName: string | null
  lastCheckpointId: number | null
  agentMode: string | null
  updatedAt: number | null
}

/**
 * Per-session агрегат: суммы по всем прогонам одного чата. Для «открыл чат →
 * вижу, сколько ВСЕГО потрачено $/инструментов/файлов/времени за сессию».
 * Переживает рестарт (agent_runs персистентны), в отличие от live cost-pill.
 */
export interface SessionStats {
  runs: number
  costCents: number
  toolCount: number
  filesCount: number
  agentsCount: number
  durationMs: number
}

/**
 * Снапшот зависшего после краха прогона для баннера «сессия прервана».
 * Собирается на старте app ДО reconcileStale (см. findResumable).
 */
export interface ResumableRun {
  runId: string
  projectPath: string
  chatId: number | null
  title: string
  /** Текст последнего user-запроса (из run_inputs) — для re-send и подписи баннера. */
  lastUserRequest: string
  turnIndex: number
  lastToolName: string | null
  agentMode: string | null
  startedAt: number
  /** Можно ли предлагать авто-возобновление (read-only последний tool + безопасный режим). */
  autoResumable: boolean
}

/**
 * Инструменты с побочными эффектами — после них авто-доигрывание запрещено
 * (деструктив не доигрывается сам). write_file/apply_patch правят файлы,
 * run_command/ssh выполняют команды, connector-* мутируют внешние системы.
 * Имена сверяются с tools.ts (TOOL_DEFS) и connector-обёртками.
 */
const MUTATING_TOOLS = new Set<string>([
  'write_file',
  'apply_patch',
  'run_command',
  'ssh',
  'delegate_task',
  'delegate_parallel'
])

/** Режимы, в которых мог пройти незаметный деструктив без подтверждения. */
const UNSAFE_MODES = new Set<string>(['auto', 'bypass'])

/**
 * Мутирующий ли инструмент: побочный эффект на файлы/систему/внешний сервис.
 * Любой connector-* трактуем как потенциально мутирующий (1С запись, Telegram
 * send и т.п.) — точную read/write-классификацию не вводим, безопаснее не
 * доигрывать.
 */
export function isMutatingTool(name: string | null | undefined): boolean {
  if (!name) return false
  return MUTATING_TOOLS.has(name) || name.startsWith('connector')
}

/**
 * Выбрать tool для гарда резюма из ВСЕХ инструментов незавершённого turn'а:
 * если в turn был хоть один мутирующий — возвращаем его (а не просто последний),
 * иначе последний. Закрывает дыру: `write_file → run_command → read_file` в
 * одном turn давал last=read_file → ложный autoResumable=true (аудит P1 #11).
 */
export function pickResumeGuardTool(toolNames: string[]): string | null {
  if (toolNames.length === 0) return null
  const mutating = toolNames.find(isMutatingTool)
  return mutating ?? toolNames[toolNames.length - 1]
}

/**
 * CLI-провайдер (claude-cli/codex-cli/gemini-cli/grok-cli): tools выполняет
 * внешний агент ВНУТРИ субпроцесса — наружу деструктив не виден, и tick на
 * CLI-пути (runPlainConversation) не пишется, поэтому last_tool_name=NULL.
 * Все CLI-id оканчиваются на '-cli' и помечены supportsTools:false (registry).
 */
export function isCliProvider(providerId: string | null | undefined): boolean {
  return typeof providerId === 'string' && providerId.endsWith('-cli')
}

/**
 * Чистый гард безопасности крэш-резюма (юнит-тестируемый, без БД).
 * Авто-возобновление РАЗРЕШЕНО только когда последний инструмент НЕ
 * деструктивный И режим безопасный (ask/accept-edits/plan). Любой мутирующий
 * tool, любой connector-* (мутирующий коннектор), режим auto/bypass → false:
 * деструктив никогда не доигрывается сам, пользователю предлагается лишь
 * «показать что было сделано» + ручной ре-промпт.
 *
 * CLI-прогоны → ВСЕГДА false: их деструктив невидим main-процессу (см.
 * isCliProvider), а last_tool_name=NULL ложно проходил бы как read-only.
 * Крашнутый Claude Code, записавший десятки файлов, не должен получать
 * авто-resume = повтор разрушительной работы (аудит P0, дыра CLI-слепоты).
 */
export function isAutoResumable(run: { lastToolName: string | null; agentMode: string | null; providerId?: string | null }): boolean {
  if (isCliProvider(run.providerId)) return false
  const mode = run.agentMode
  if (mode != null && UNSAFE_MODES.has(mode)) return false
  // last_tool_name = «самый опасный» tool turn'а (pickResumeGuardTool на записи),
  // поэтому достаточно проверить его одного.
  if (isMutatingTool(run.lastToolName)) return false
  return true
}

export interface AgentRunEvent {
  id: number
  runId: string
  kind: string
  label: string | null
  detail: string | null
  ref: string | null
  status: string | null
  createdAt: number
}

/** Поле-счётчик для атомарного инкремента. */
export type AgentRunCounterField = 'agents_count' | 'tool_count' | 'files_count'

export interface AgentRuns {
  /** Создать строку прогона (status='running', started_at=now). */
  create: (opts: {
    runId: string
    projectPath: string
    chatId?: number | null
    owner?: AgentRunOwner
    title: string
    providerId?: string | null
    model?: string | null
    sendId?: number | null
    /** Crash-resume: режим прогона (ask/accept-edits/plan/auto/bypass). */
    agentMode?: string | null
  }) => void
  /**
   * Crash-resume: записать ЖИВОЙ прогресс прогона (на каждом turn агентного
   * цикла). Обновляет turn_index/last_tool_name/last_checkpoint_id + updated_at.
   * Пишет только для ЕЩЁ живых прогонов (ended_at IS NULL) — завершённый не
   * воскрешаем. Best-effort: переданы только не-undefined поля.
   */
  tick: (runId: string, patch: {
    turnIndex?: number
    lastToolName?: string | null
    lastCheckpointId?: number | null
    // Live-счётчики прогресса: SET абсолютных накопленных значений на каждом
    // turn (не incr) — чтобы карточка running-задачи показывала прогресс, а не
    // нули до finish (аудит P0).
    toolCount?: number
    filesCount?: number
    agentsCount?: number
  }) => void
  /** Добавить событие в Timeline прогона. detail кап до 500 симв. */
  appendEvent: (runId: string, kind: string, opts?: {
    label?: string | null
    detail?: string | null
    ref?: string | null
    status?: string | null
  }) => void
  /** Завершить прогон: status + ended_at=now + опциональные итоговые счётчики. */
  finish: (runId: string, status: AgentRunStatus, opts?: {
    costCents?: number
    toolCount?: number
    filesCount?: number
    agentsCount?: number
    error?: string | null
  }) => void
  /** Атомарно увеличить счётчик (field = field + by). */
  incr: (runId: string, field: AgentRunCounterField, by?: number) => void
  /** Прогоны проекта, новейшие первыми. Фильтры status/owner опциональны. */
  list: (projectPath: string, opts?: { status?: AgentRunStatus; owner?: AgentRunOwner; limit?: number }) => AgentRun[]
  get: (runId: string) => AgentRun | null
  /** Per-session агрегат по всем прогонам чата (cost/инструменты/файлы/время). */
  sessionStats: (chatId: number) => SessionStats
  /** События прогона в порядке добавления (id ASC). */
  getEvents: (runId: string) => AgentRunEvent[]
  /**
   * Пометить зависшие прогоны как failed. На старте app строки со
   * status IN ('running','queued') И ended_at IS NULL — это прогоны,
   * прерванные крахом/выходом без живого процесса. Возвращает число помеченных.
   * projectPath опционален: без него реконсайлятся все проекты.
   */
  reconcileStale: (projectPath?: string) => number
  /**
   * Crash-resume: зависшие прогоны проекта для баннера «сессия прервана».
   *
   * ВАЖНО (согласование с reconcileStale): reconcileStale на старте app бьёт
   * running/queued → failed (Manager-поведение оставлено как есть). Поэтому
   * findResumable ищет НЕ по текущему status='running' (его уже нет), а по
   * признакам «был прерван крахом»: status='failed' + ended_at почти == то
   * время, когда мы реконсайлили (reconcile ставит ended_at=now на старте),
   * иначе говоря — НЕ имеет нормального завершения. Чтобы не зависеть от
   * хрупкой эвристики времени, main.ts передаёт reconciledAt (метку реконсайла
   * этого старта): findResumable отбирает failed-прогоны, чей ended_at >=
   * reconciledAt (т.е. помечены именно ЭТИМ реконсайлом, а не упали раньше по
   * реальной ошибке). lastUserRequest берётся из run_inputs (нужен для re-send);
   * без снапшота прогон не предлагается. autoResumable — гард деструктива.
   */
  findResumable: (projectPath: string, reconciledAt: number, getUserRequest: (runId: string) => string | null) => ResumableRun[]
  /**
   * Crash-resume Фаза 2: сохранить снапшот истории сообщений loop'а на текущем
   * turn. UPSERT по run_id — один чекпойнт на прогон (последний turn перетирает
   * предыдущий). Best-effort: вызывается на каждом turn рядом с tick().
   */
  saveCheckpoint: (runId: string, turnIndex: number, messagesJson: string, undoHead?: number | null) => void
  /** Последний чекпойнт прогона (для возобновления с полным контекстом) или null. */
  latestCheckpoint: (runId: string) => RunCheckpoint | null
  /** Удалить чекпойнт прогона (на чистом завершении возобновлять нечего). */
  clearCheckpoint: (runId: string) => void
}

/** Снапшот состояния агентного цикла для возобновления (Crash-resume Фаза 2). */
export interface RunCheckpoint {
  turnIndex: number
  messagesJson: string
  undoHead: number | null
}

const SELECT_RUN = `
  SELECT run_id as runId, project_path as projectPath, chat_id as chatId,
         owner, title, status, provider_id as providerId, model, send_id as sendId,
         agents_count as agentsCount, tool_count as toolCount,
         files_count as filesCount, cost_cents as costCents,
         error, started_at as startedAt, ended_at as endedAt,
         turn_index as turnIndex, last_tool_name as lastToolName,
         last_checkpoint_id as lastCheckpointId, agent_mode as agentMode,
         updated_at as updatedAt
  FROM agent_runs
`

const SELECT_EVENT = `
  SELECT id, run_id as runId, kind, label, detail, ref, status, created_at as createdAt
  FROM agent_run_events
`

const DETAIL_CAP = 500

export function createAgentRuns(db: Database): AgentRuns {
  return {
    create(opts) {
      const now = Date.now()
      db.prepare(
        `INSERT INTO agent_runs
          (run_id, project_path, chat_id, owner, title, status,
           provider_id, model, send_id, agent_mode, turn_index, updated_at, started_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, 0, ?, ?)`
      ).run(
        opts.runId,
        opts.projectPath,
        opts.chatId ?? null,
        opts.owner ?? 'main',
        opts.title,
        opts.providerId ?? null,
        opts.model ?? null,
        opts.sendId ?? null,
        opts.agentMode ?? null,
        now,
        now
      )
    },
    tick(runId, patch) {
      const sets: string[] = ['updated_at = ?']
      const vals: unknown[] = [Date.now()]
      if (patch.turnIndex !== undefined) { sets.push('turn_index = ?'); vals.push(patch.turnIndex) }
      if (patch.lastToolName !== undefined) { sets.push('last_tool_name = ?'); vals.push(patch.lastToolName) }
      if (patch.lastCheckpointId !== undefined) { sets.push('last_checkpoint_id = ?'); vals.push(patch.lastCheckpointId) }
      if (patch.toolCount !== undefined) { sets.push('tool_count = ?'); vals.push(patch.toolCount) }
      if (patch.filesCount !== undefined) { sets.push('files_count = ?'); vals.push(patch.filesCount) }
      if (patch.agentsCount !== undefined) { sets.push('agents_count = ?'); vals.push(patch.agentsCount) }
      vals.push(runId)
      // ended_at IS NULL — тикаем только живой прогон. Завершённый (finish уже
      // прошёл / stop) не воскрешаем поздним тиком из догоняющего turn'а.
      db.prepare(`UPDATE agent_runs SET ${sets.join(', ')} WHERE run_id = ? AND ended_at IS NULL`).run(...vals)
    },
    appendEvent(runId, kind, opts) {
      const detail = opts?.detail != null ? opts.detail.slice(0, DETAIL_CAP) : null
      db.prepare(
        `INSERT INTO agent_run_events (run_id, kind, label, detail, ref, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        runId,
        kind,
        opts?.label ?? null,
        detail,
        opts?.ref ?? null,
        opts?.status ?? null,
        Date.now()
      )
    },
    finish(runId, status, opts) {
      const sets: string[] = ['status = ?', 'ended_at = ?']
      const vals: unknown[] = [status, Date.now()]
      if (opts?.costCents !== undefined) { sets.push('cost_cents = ?'); vals.push(opts.costCents) }
      if (opts?.toolCount !== undefined) { sets.push('tool_count = ?'); vals.push(opts.toolCount) }
      if (opts?.filesCount !== undefined) { sets.push('files_count = ?'); vals.push(opts.filesCount) }
      if (opts?.agentsCount !== undefined) { sets.push('agents_count = ?'); vals.push(opts.agentsCount) }
      if (opts?.error !== undefined) { sets.push('error = ?'); vals.push(opts.error) }
      vals.push(runId)
      // Guard ended_at IS NULL — финиш идемпотентен по первому завершению (Фаза 4):
      // 'agent-runs:stop' пишет finish('stopped'), а затем естественный finally
      // runner'а тоже вызовет finish(...) по exitReason='aborted' → 'stopped'/
      // 'done'. Без guard'а второй вызов затёр бы stop-статус и счётчики первого.
      // Первый дошедший finish фиксирует состояние; повторные — no-op.
      db.prepare(`UPDATE agent_runs SET ${sets.join(', ')} WHERE run_id = ? AND ended_at IS NULL`).run(...vals)
    },
    incr(runId, field, by = 1) {
      // field — из фиксированного enum AgentRunCounterField, не пользовательский
      // ввод, поэтому интерполяция имени колонки в SQL безопасна.
      db.prepare(`UPDATE agent_runs SET ${field} = ${field} + ? WHERE run_id = ?`).run(by, runId)
    },
    list(projectPath, opts) {
      const where: string[] = ['project_path = ?']
      const vals: unknown[] = [projectPath]
      if (opts?.status !== undefined) { where.push('status = ?'); vals.push(opts.status) }
      if (opts?.owner !== undefined) { where.push('owner = ?'); vals.push(opts.owner) }
      const limit = opts?.limit ?? 100
      vals.push(limit)
      // rowid DESC — детерминированный тай-брейк, когда несколько прогонов
      // стартовали в одну миллисекунду (вставленный позже = новее).
      return db.prepare(
        `${SELECT_RUN} WHERE ${where.join(' AND ')} ORDER BY started_at DESC, rowid DESC LIMIT ?`
      ).all(...vals) as AgentRun[]
    },
    get(runId) {
      const row = db.prepare(`${SELECT_RUN} WHERE run_id = ?`).get(runId) as AgentRun | undefined
      return row ?? null
    },
    sessionStats(chatId) {
      // Агрегат по существующим колонкам — без миграции. duration только по
      // завершённым прогонам (ended_at IS NOT NULL), иначе текущий бы исказил.
      const row = db.prepare(`
        SELECT COUNT(*) as runs,
               COALESCE(SUM(cost_cents), 0) as costCents,
               COALESCE(SUM(tool_count), 0) as toolCount,
               COALESCE(SUM(files_count), 0) as filesCount,
               COALESCE(SUM(agents_count), 0) as agentsCount,
               COALESCE(SUM(CASE WHEN ended_at IS NOT NULL THEN ended_at - started_at ELSE 0 END), 0) as durationMs
        FROM agent_runs WHERE chat_id = ?
      `).get(chatId) as SessionStats | undefined
      return row ?? { runs: 0, costCents: 0, toolCount: 0, filesCount: 0, agentsCount: 0, durationMs: 0 }
    },
    getEvents(runId) {
      return db.prepare(`${SELECT_EVENT} WHERE run_id = ? ORDER BY id ASC`).all(runId) as AgentRunEvent[]
    },
    reconcileStale(projectPath) {
      const where = ["status IN ('running','queued')", 'ended_at IS NULL']
      const vals: unknown[] = [Date.now()]
      if (projectPath !== undefined) { where.push('project_path = ?'); vals.push(projectPath) }
      const info = db.prepare(
        `UPDATE agent_runs SET status = 'failed', ended_at = ? WHERE ${where.join(' AND ')}`
      ).run(...vals)
      return info.changes
    },
    findResumable(projectPath, reconciledAt, getUserRequest) {
      // Прогоны, помеченные failed ИМЕННО реконсайлом этого старта (ended_at >=
      // reconciledAt). Прогоны, упавшие раньше по реальной ошибке, имеют
      // ended_at < reconciledAt и не предлагаются. owner='main' — review/
      // background не возобновляем как «прерванную задачу пользователя».
      const rows = db.prepare(
        `${SELECT_RUN} WHERE project_path = ? AND status = 'failed'
           AND ended_at IS NOT NULL AND ended_at >= ? AND owner = 'main'
         ORDER BY started_at DESC, rowid DESC`
      ).all(projectPath, reconciledAt) as AgentRun[]
      const out: ResumableRun[] = []
      for (const r of rows) {
        // Без сохранённого ввода re-send невозможен → прогон не предлагаем.
        const userRequest = getUserRequest(r.runId)
        if (!userRequest) continue
        out.push({
          runId: r.runId,
          projectPath: r.projectPath,
          chatId: r.chatId,
          title: r.title,
          lastUserRequest: userRequest,
          turnIndex: r.turnIndex ?? 0,
          lastToolName: r.lastToolName,
          agentMode: r.agentMode,
          startedAt: r.startedAt,
          autoResumable: isAutoResumable(r)
        })
      }
      return out
    },
    saveCheckpoint(runId, turnIndex, messagesJson, undoHead) {
      db.prepare(
        `INSERT INTO agent_run_checkpoints (run_id, turn_index, messages_json, undo_head, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           turn_index = excluded.turn_index,
           messages_json = excluded.messages_json,
           undo_head = excluded.undo_head,
           created_at = excluded.created_at`
      ).run(runId, turnIndex, messagesJson, undoHead ?? null, Date.now())
    },
    latestCheckpoint(runId) {
      const row = db.prepare(
        `SELECT turn_index as turnIndex, messages_json as messagesJson, undo_head as undoHead
         FROM agent_run_checkpoints WHERE run_id = ?`
      ).get(runId) as RunCheckpoint | undefined
      return row ?? null
    },
    clearCheckpoint(runId) {
      db.prepare('DELETE FROM agent_run_checkpoints WHERE run_id = ?').run(runId)
    }
  }
}
