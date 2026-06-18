import type { Database } from 'better-sqlite3'

/**
 * Pipeline Brief→Proof (спек verstak-pipeline-brief-to-proof-spec.md) — тонкий
 * storage-фасад поверх таблицы pipeline_runs (миграция 22). Один ряд = один
 * сквозной прогон: Brief → Plan → Execute → Verify → Proof.
 *
 * Назначение: пережить рестарт приложения (getActive) + единый баннер по шагам
 * across tabs. Это НЕ дубль agent_runs — pipeline_runs только связывает шаги
 * (brief/plan/run/верх-уровневый step), фактические данные живут в plans /
 * agent_runs / verifications.
 *
 * Фаза D1: только storage + тесты, поведение приложения не меняется (IPC и UI —
 * D2+).
 */

export type PipelineMode = 'dev' | 'agency'

export type PipelineStep =
  | 'brief'
  | 'plan'
  | 'execute'
  | 'verify'
  | 'proof'
  | 'completed'
  | 'cancelled'

/** Терминальные шаги — getActive их игнорирует. */
const TERMINAL_STEPS: ReadonlySet<PipelineStep> = new Set(['completed', 'cancelled'])

/** Бриф пользователя: цель / границы / Definition of Done. Хранится как JSON. */
export interface PipelineBrief {
  goal: string
  constraints: string
  dod: string
}

export interface PipelineRun {
  id: number
  projectPath: string
  chatId: number | null
  agentRunId: string | null
  mode: PipelineMode
  workflowId: string | null
  step: PipelineStep
  brief: PipelineBrief
  planId: number | null
  createdAt: number
  updatedAt: number
}

export interface CreatePipelineOpts {
  projectPath: string
  mode: PipelineMode
  brief: PipelineBrief
  chatId?: number | null
  workflowId?: string | null
  /** Начальный шаг. По умолчанию 'plan' — бриф уже собран в визарде до start. */
  step?: PipelineStep
}

export interface AdvancePipelinePatch {
  step?: PipelineStep
  planId?: number | null
  agentRunId?: string | null
  chatId?: number | null
}

export interface PipelineRuns {
  create(opts: CreatePipelineOpts): PipelineRun
  get(id: number): PipelineRun | null
  /** Последний НЕтерминальный прогон проекта (для resume-баннера). */
  getActive(projectPath: string): PipelineRun | null
  advance(id: number, patch: AdvancePipelinePatch): PipelineRun | null
  cancel(id: number): void
}

interface PipelineRow {
  id: number
  project_path: string
  chat_id: number | null
  agent_run_id: string | null
  mode: string
  workflow_id: string | null
  step: string
  brief_json: string
  plan_id: number | null
  created_at: number
  updated_at: number
}

function safeBrief(json: string): PipelineBrief {
  try {
    const b = JSON.parse(json) as Partial<PipelineBrief>
    return { goal: b.goal ?? '', constraints: b.constraints ?? '', dod: b.dod ?? '' }
  } catch {
    return { goal: '', constraints: '', dod: '' }
  }
}

function mapRow(row: PipelineRow): PipelineRun {
  return {
    id: row.id,
    projectPath: row.project_path,
    chatId: row.chat_id,
    agentRunId: row.agent_run_id,
    mode: row.mode as PipelineMode,
    workflowId: row.workflow_id,
    step: row.step as PipelineStep,
    brief: safeBrief(row.brief_json),
    planId: row.plan_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const SELECT = `SELECT id, project_path, chat_id, agent_run_id, mode, workflow_id,
  step, brief_json, plan_id, created_at, updated_at FROM pipeline_runs`

export function createPipelineRuns(db: Database): PipelineRuns {
  return {
    create(opts) {
      const now = Date.now()
      const info = db.prepare(
        `INSERT INTO pipeline_runs
          (project_path, chat_id, mode, workflow_id, step, brief_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        opts.projectPath,
        opts.chatId ?? null,
        opts.mode,
        opts.workflowId ?? null,
        opts.step ?? 'plan',
        JSON.stringify(opts.brief),
        now,
        now,
      )
      const id = Number(info.lastInsertRowid)
      return mapRow(db.prepare(`${SELECT} WHERE id = ?`).get(id) as PipelineRow)
    },
    get(id) {
      const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as PipelineRow | undefined
      return row ? mapRow(row) : null
    },
    getActive(projectPath) {
      const rows = db.prepare(
        `${SELECT} WHERE project_path = ? ORDER BY id DESC`
      ).all(projectPath) as PipelineRow[]
      const active = rows.find(r => !TERMINAL_STEPS.has(r.step as PipelineStep))
      return active ? mapRow(active) : null
    },
    advance(id, patch) {
      const sets: string[] = []
      const vals: unknown[] = []
      if (patch.step !== undefined) { sets.push('step = ?'); vals.push(patch.step) }
      if (patch.planId !== undefined) { sets.push('plan_id = ?'); vals.push(patch.planId) }
      if (patch.agentRunId !== undefined) { sets.push('agent_run_id = ?'); vals.push(patch.agentRunId) }
      if (patch.chatId !== undefined) { sets.push('chat_id = ?'); vals.push(patch.chatId) }
      if (sets.length === 0) return this.get(id)
      sets.push('updated_at = ?'); vals.push(Date.now())
      vals.push(id)
      db.prepare(`UPDATE pipeline_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
      return this.get(id)
    },
    cancel(id) {
      db.prepare('UPDATE pipeline_runs SET step = ?, updated_at = ? WHERE id = ?')
        .run('cancelled', Date.now(), id)
    },
  }
}
