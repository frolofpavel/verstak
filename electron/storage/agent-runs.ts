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
  /** События прогона в порядке добавления (id ASC). */
  getEvents: (runId: string) => AgentRunEvent[]
  /**
   * Пометить зависшие прогоны как failed. На старте app строки со
   * status IN ('running','queued') И ended_at IS NULL — это прогоны,
   * прерванные крахом/выходом без живого процесса. Возвращает число помеченных.
   * projectPath опционален: без него реконсайлятся все проекты.
   */
  reconcileStale: (projectPath?: string) => number
}

const SELECT_RUN = `
  SELECT run_id as runId, project_path as projectPath, chat_id as chatId,
         owner, title, status, provider_id as providerId, model, send_id as sendId,
         agents_count as agentsCount, tool_count as toolCount,
         files_count as filesCount, cost_cents as costCents,
         error, started_at as startedAt, ended_at as endedAt
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
      db.prepare(
        `INSERT INTO agent_runs
          (run_id, project_path, chat_id, owner, title, status,
           provider_id, model, send_id, started_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`
      ).run(
        opts.runId,
        opts.projectPath,
        opts.chatId ?? null,
        opts.owner ?? 'main',
        opts.title,
        opts.providerId ?? null,
        opts.model ?? null,
        opts.sendId ?? null,
        Date.now()
      )
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
      db.prepare(`UPDATE agent_runs SET ${sets.join(', ')} WHERE run_id = ?`).run(...vals)
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
    }
  }
}
