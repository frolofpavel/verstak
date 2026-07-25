import type { Database } from 'better-sqlite3'
import {
  parseTaskContract,
  parseTaskContractJson,
  type OutcomeDiagnostic,
  type TaskContractV1,
} from '../../shared/contracts/outcome'

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
export type OutcomeEffortLevel = 'quick' | 'controlled' | 'deep'

export type PipelineStep =
  | 'brief'
  | 'refine'
  | 'plan'
  | 'execute'
  | 'verify'
  | 'review'
  | 'proof'
  | 'completed'
  | 'cancelled'
  | 'blocked'   // v3: verify провалился после лимита попыток — честный стоп, не «готово»

/** Терминальные шаги — getActive их игнорирует. 'blocked' НЕ терминальный:
 *  прогон остаётся активным/видимым в баннере, чтобы пользователь вмешался. */
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
  effortLevel: OutcomeEffortLevel
  workflowId: string | null
  step: PipelineStep
  brief: PipelineBrief
  planId: number | null
  taskContract: TaskContractV1 | null
  contractRevision: number
  contractDiagnostics: OutcomeDiagnostic[]
  /** v3 verify-gate: сколько раз прогоняли verify (для лимита авто-починок). */
  verifyAttempts: number
  createdAt: number
  updatedAt: number
}

export interface CreatePipelineOpts {
  projectPath: string
  mode: PipelineMode
  effortLevel?: OutcomeEffortLevel
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
  verifyAttempts?: number
}

export interface PipelineRuns {
  create(opts: CreatePipelineOpts): PipelineRun
  get(id: number): PipelineRun | null
  /** Последний НЕтерминальный прогон проекта (для resume-баннера). */
  getActive(projectPath: string): PipelineRun | null
  /** История прогонов проекта, новые первыми. */
  list(projectPath: string, limit?: number): PipelineRun[]
  advance(id: number, patch: AdvancePipelinePatch): PipelineRun | null
  saveContract(id: number, contract: TaskContractV1): PipelineRun
  cancel(id: number): void
  metrics(projectPath: string): OutcomeMetrics
}

export interface OutcomeMetrics {
  starts: number
  completed: number
  blocked: number
  cancelled: number
  replans: number
  retries: number
  interventions: number
  jobs: number
  filesChanged: number
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  costCents: number | null
  medianTimeToProofMs: number | null
  noCorrectivePromptRuns: number
}

interface PipelineRow {
  id: number
  project_path: string
  chat_id: number | null
  agent_run_id: string | null
  mode: string
  effort_level: string
  workflow_id: string | null
  step: string
  brief_json: string
  plan_id: number | null
  task_contract_json: string | null
  contract_revision: number
  verify_attempts: number
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
  const parsed = parseTaskContractJson(row.task_contract_json)
  return {
    id: row.id,
    projectPath: row.project_path,
    chatId: row.chat_id,
    agentRunId: row.agent_run_id,
    mode: row.mode as PipelineMode,
    effortLevel: normalizeEffortLevel(row.effort_level),
    workflowId: row.workflow_id,
    step: row.step as PipelineStep,
    brief: safeBrief(row.brief_json),
    planId: row.plan_id,
    taskContract: parsed.value,
    contractRevision: row.contract_revision ?? 0,
    contractDiagnostics: parsed.diagnostics,
    verifyAttempts: row.verify_attempts ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const SELECT = `SELECT id, project_path, chat_id, agent_run_id, mode, workflow_id,
  effort_level, step, brief_json, plan_id, task_contract_json, contract_revision,
  verify_attempts, created_at, updated_at FROM pipeline_runs`

export function createPipelineRuns(db: Database): PipelineRuns {
  return {
    create(opts) {
      const now = Date.now()
      const info = db.prepare(
        `INSERT INTO pipeline_runs
          (project_path, chat_id, mode, effort_level, workflow_id, step, brief_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        opts.projectPath,
        opts.chatId ?? null,
        opts.mode,
        opts.effortLevel ?? 'controlled',
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
    list(projectPath, limit = 100) {
      const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit) || 100))
      return (db.prepare(
        `${SELECT} WHERE project_path = ? ORDER BY id DESC LIMIT ?`
      ).all(projectPath, safeLimit) as PipelineRow[]).map(mapRow)
    },
    advance(id, patch) {
      const sets: string[] = []
      const vals: unknown[] = []
      if (patch.step !== undefined) { sets.push('step = ?'); vals.push(patch.step) }
      if (patch.planId !== undefined) { sets.push('plan_id = ?'); vals.push(patch.planId) }
      if (patch.agentRunId !== undefined) { sets.push('agent_run_id = ?'); vals.push(patch.agentRunId) }
      if (patch.chatId !== undefined) { sets.push('chat_id = ?'); vals.push(patch.chatId) }
      if (patch.verifyAttempts !== undefined) { sets.push('verify_attempts = ?'); vals.push(patch.verifyAttempts) }
      if (sets.length === 0) return this.get(id)
      sets.push('updated_at = ?'); vals.push(Date.now())
      vals.push(id)
      db.prepare(`UPDATE pipeline_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
      return this.get(id)
    },
    saveContract(id, contract) {
      const current = this.get(id)
      if (!current) throw new Error(`pipeline ${id} not found`)
      const parsed = parseTaskContract(contract)
      if (!parsed.value) throw new Error(parsed.diagnostics.map(d => d.message).join('; '))
      if (contract.revision !== current.contractRevision + 1) {
        throw new Error(`contract revision must be ${current.contractRevision + 1}`)
      }
      db.prepare(
        'UPDATE pipeline_runs SET task_contract_json = ?, contract_revision = ?, updated_at = ? WHERE id = ?'
      ).run(JSON.stringify(parsed.value), parsed.value.revision, Date.now(), id)
      const updated = this.get(id)
      if (!updated) throw new Error(`pipeline ${id} disappeared`)
      return updated
    },
    cancel(id) {
      db.prepare('UPDATE pipeline_runs SET step = ?, updated_at = ? WHERE id = ?')
        .run('cancelled', Date.now(), id)
    },
    metrics(projectPath) {
      const counts = db.prepare(`
        SELECT COUNT(*) starts,
          SUM(CASE WHEN step = 'completed' THEN 1 ELSE 0 END) completed,
          SUM(CASE WHEN step = 'blocked' THEN 1 ELSE 0 END) blocked,
          SUM(CASE WHEN step = 'cancelled' THEN 1 ELSE 0 END) cancelled,
          COALESCE(SUM(verify_attempts), 0) retries
        FROM pipeline_runs WHERE project_path = ?
      `).get(projectPath) as Record<string, number | null>
      const aggregate = db.prepare(`
        SELECT COALESCE(SUM(ar.files_count), 0) filesChanged,
          COALESCE(SUM(ar.cost_cents), 0) costCents
        FROM pipeline_runs p
        LEFT JOIN agent_runs ar ON ar.run_id = p.agent_run_id
        WHERE p.project_path = ?
      `).get(projectPath) as { filesChanged: number; costCents: number }
      const usage = db.prepare(`
        SELECT SUM(u.input_tokens) inputTokens, SUM(u.output_tokens) outputTokens,
          SUM(u.cache_read_tokens) cacheReadTokens,
          SUM(CASE
            WHEN p.agent_run_id IS NOT NULL AND u.run_id IS NULL THEN 1
            WHEN u.pricing_known = 0 THEN 1
            ELSE 0
          END) unknownCostRows
        FROM pipeline_runs p
        LEFT JOIN agent_run_usage u ON u.run_id = p.agent_run_id
        WHERE p.project_path = ?
      `).get(projectPath) as {
        inputTokens: number | null
        outputTokens: number | null
        cacheReadTokens: number | null
        unknownCostRows: number | null
      }
      const jobs = db.prepare(`
        SELECT COUNT(*) jobs,
          COALESCE(SUM(CASE WHEN attempt > 1 THEN attempt - 1 ELSE 0 END), 0) retries,
          COALESCE(SUM(CASE WHEN status IN ('waiting-approval','blocked','interrupted') THEN 1 ELSE 0 END), 0) interventions
        FROM agent_jobs j
        JOIN pipeline_runs p ON p.id = j.pipeline_id
        WHERE p.project_path = ?
      `).get(projectPath) as { jobs: number; retries: number; interventions: number }
      const replans = (db.prepare(`
        SELECT COUNT(*) count FROM plan_revisions r
        JOIN pipeline_runs p ON p.plan_id = r.plan_id
        WHERE p.project_path = ?
      `).get(projectPath) as { count: number }).count
      const durations = (db.prepare(`
        SELECT updated_at - created_at duration
        FROM pipeline_runs
        WHERE project_path = ? AND step = 'completed'
        ORDER BY duration
      `).all(projectPath) as Array<{ duration: number }>).map(row => row.duration)
      const noCorrective = (db.prepare(`
        SELECT COUNT(*) count
        FROM pipeline_runs p
        WHERE p.project_path = ? AND p.step = 'completed' AND p.agent_run_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM agent_run_events e
            WHERE e.run_id = p.agent_run_id
              AND (LOWER(COALESCE(e.label, '')) LIKE '%corrective%'
                OR LOWER(COALESCE(e.detail, '')) LIKE '%corrective%')
          )
      `).get(projectPath) as { count: number }).count
      return {
        starts: counts.starts ?? 0,
        completed: counts.completed ?? 0,
        blocked: counts.blocked ?? 0,
        cancelled: counts.cancelled ?? 0,
        replans,
        retries: (counts.retries ?? 0) + jobs.retries,
        interventions: jobs.interventions,
        jobs: jobs.jobs,
        filesChanged: aggregate.filesChanged,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        costCents: usage.unknownCostRows ? null : aggregate.costCents,
        medianTimeToProofMs: median(durations),
        noCorrectivePromptRuns: noCorrective,
      }
    },
  }
}

function normalizeEffortLevel(value: string): OutcomeEffortLevel {
  return value === 'quick' || value === 'deep' ? value : 'controlled'
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const middle = Math.floor(values.length / 2)
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2
}
