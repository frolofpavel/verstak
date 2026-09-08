/**
 * Хранилище постоянных задач. Вся правда о задаче живёт в sqlite: состояние,
 * счётчики и время следующего пробуждения переживают перезапуск приложения, в
 * памяти не остаётся ничего, кроме защиты от повторного запуска уже бегущей.
 */
import type { Database } from 'better-sqlite3'
import { MAX_RUNS_CAP, type JobStatus, type PersistentJobV1 } from '../../shared/contracts/persistent-job'

type Row = {
  id: string
  project_path: string
  title: string
  goal: string
  status: string
  trigger_kind: string
  trigger_config: string
  state_json: string
  next_action: string | null
  assigned_capability_id: string | null
  required_capabilities: string
  budget_cents: number | null
  max_runtime_ms: number | null
  max_runs: number
  runs_done: number
  cost_used_cents: number
  last_run_at: number | null
  next_run_at: number | null
  last_result: string | null
  created_at: number
  updated_at: number
}

/** Разбор JSON-поля. Битое содержимое не должно ронять весь список задач. */
function parseJson<T>(raw: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback
  } catch {
    return fallback
  }
}

function toJob(row: Row): PersistentJobV1 {
  return {
    id: row.id,
    projectPath: row.project_path,
    title: row.title,
    goal: row.goal,
    status: row.status as JobStatus,
    triggerKind: row.trigger_kind as PersistentJobV1['triggerKind'],
    triggerConfig: parseJson<Record<string, unknown>>(row.trigger_config, {}),
    state: parseJson<Record<string, unknown>>(row.state_json, {}),
    nextAction: row.next_action,
    assignedCapabilityId: row.assigned_capability_id,
    requiredCapabilities: parseJson<string[]>(row.required_capabilities, []),
    budgetCents: row.budget_cents,
    maxRuntimeMs: row.max_runtime_ms,
    maxRuns: row.max_runs,
    runsDone: row.runs_done,
    costUsedCents: row.cost_used_cents,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    lastResult: row.last_result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export type PersistentJobInput = Pick<
  PersistentJobV1,
  'id' | 'projectPath' | 'title' | 'goal' | 'triggerKind' | 'triggerConfig' | 'maxRuns'
> &
  Partial<Pick<PersistentJobV1, 'state' | 'nextAction' | 'assignedCapabilityId' | 'requiredCapabilities' | 'budgetCents' | 'maxRuntimeMs' | 'nextRunAt'>>

/** Итог одного пробуждения. Счётчики двигаются ТОЛЬКО здесь. */
export interface JobRunOutcome {
  ok: boolean
  result: string
  /** Состояние, которое задача унесёт в следующее пробуждение. */
  state: Record<string, unknown>
  nextAction: string | null
  costCents: number
  nextRunAt: number | null
  /** Работа закончена целиком — задача больше не просыпается. */
  finished?: boolean
}

export interface PersistentJobs {
  create: (input: PersistentJobInput) => PersistentJobV1
  get: (id: string) => PersistentJobV1 | null
  list: (projectPath?: string) => PersistentJobV1[]
  /**
   * Захватить задачу на исполнение. Возвращает false, если её уже захватил
   * кто-то другой: захват — атомарный UPDATE по статусу, а не проверка-потом-запись.
   */
  claim: (id: string) => boolean
  /** Записать итог пробуждения и уложить задачу спать. */
  complete: (id: string, outcome: JobRunOutcome, at?: number) => void
  setStatus: (id: string, status: JobStatus) => void
  remove: (id: string) => void
}

export function createPersistentJobs(db: Database): PersistentJobs {
  const insert = db.prepare(`
    INSERT INTO persistent_jobs (
      id, project_path, title, goal, status, trigger_kind, trigger_config, state_json,
      next_action, assigned_capability_id, required_capabilities, budget_cents,
      max_runtime_ms, max_runs, runs_done, cost_used_cents, last_run_at, next_run_at,
      last_result, created_at, updated_at
    ) VALUES (
      @id, @projectPath, @title, @goal, 'active', @triggerKind, @triggerConfig, @state,
      @nextAction, @assignedCapabilityId, @requiredCapabilities, @budgetCents,
      @maxRuntimeMs, @maxRuns, 0, 0, NULL, @nextRunAt, NULL, @now, @now
    )
  `)
  const selectOne = db.prepare('SELECT * FROM persistent_jobs WHERE id = ?')
  const selectAll = db.prepare('SELECT * FROM persistent_jobs ORDER BY created_at')
  const selectByProject = db.prepare('SELECT * FROM persistent_jobs WHERE project_path = ? ORDER BY created_at')
  // Захват атомарен: условие в WHERE, а не в коде вокруг него. Иначе два тика,
  // пришедшие одновременно, запустили бы одну задачу дважды.
  const claimOne = db.prepare("UPDATE persistent_jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'active'")
  const finishOne = db.prepare(`
    UPDATE persistent_jobs
       SET status = @status, state_json = @state, next_action = @nextAction,
           runs_done = runs_done + 1, cost_used_cents = cost_used_cents + @costCents,
           last_run_at = @at, next_run_at = @nextRunAt, last_result = @result, updated_at = @at
     WHERE id = @id
  `)
  const setStatusOne = db.prepare('UPDATE persistent_jobs SET status = ?, updated_at = ? WHERE id = ?')
  const deleteOne = db.prepare('DELETE FROM persistent_jobs WHERE id = ?')

  return {
    create(input) {
      if (input.maxRuns <= 0 || input.maxRuns > MAX_RUNS_CAP) {
        // Задача без предела — вечный фоновый расход. Отказ на входе честнее, чем
        // тихая подстановка потолка: человек должен узнать о границе сразу.
        throw new Error(`Предел запусков обязателен и не больше ${MAX_RUNS_CAP}`)
      }
      const now = Date.now()
      insert.run({
        id: input.id,
        projectPath: input.projectPath,
        title: input.title,
        goal: input.goal,
        triggerKind: input.triggerKind,
        triggerConfig: JSON.stringify(input.triggerConfig ?? {}),
        state: JSON.stringify(input.state ?? {}),
        nextAction: input.nextAction ?? null,
        assignedCapabilityId: input.assignedCapabilityId ?? null,
        requiredCapabilities: JSON.stringify(input.requiredCapabilities ?? []),
        budgetCents: input.budgetCents ?? null,
        maxRuntimeMs: input.maxRuntimeMs ?? null,
        maxRuns: input.maxRuns,
        nextRunAt: input.nextRunAt ?? null,
        now,
      })
      const created = selectOne.get(input.id) as Row
      return toJob(created)
    },

    get(id) {
      const row = selectOne.get(id) as Row | undefined
      return row ? toJob(row) : null
    },

    list(projectPath) {
      const rows = (projectPath ? selectByProject.all(projectPath) : selectAll.all()) as Row[]
      return rows.map(toJob)
    },

    claim(id) {
      return claimOne.run(Date.now(), id).changes === 1
    },

    complete(id, outcome, at = Date.now()) {
      const row = selectOne.get(id) as Row | undefined
      if (!row) return
      const runsAfter = row.runs_done + 1
      // Задача сама сказала «закончил», исчерпала предел или упала — во всех трёх
      // случаях она больше не просыпается, и статус это говорит прямо.
      const status: JobStatus = outcome.finished
        ? 'done'
        : !outcome.ok
          ? 'failed'
          : runsAfter >= row.max_runs
            ? 'done'
            : 'active'
      finishOne.run({
        id,
        status,
        state: JSON.stringify(outcome.state ?? {}),
        nextAction: outcome.nextAction,
        costCents: Math.max(0, Math.round(outcome.costCents)),
        at,
        nextRunAt: status === 'active' ? outcome.nextRunAt : null,
        result: outcome.result,
      })
    },

    setStatus(id, status) {
      setStatusOne.run(status, Date.now(), id)
    },

    remove(id) {
      deleteOne.run(id)
    },
  }
}
