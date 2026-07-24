import type { Database } from 'better-sqlite3'
import {
  assertAgentJobTransition,
  TERMINAL_AGENT_JOB_STATUSES,
  type AgentJobStatus,
  type AgentJobTransitionGuard,
  type AgentJobV1,
} from '../../shared/contracts/agent-job'
import { parseStepOutcomeJson, type StepOutcomeV1 } from '../../shared/contracts/outcome'

export type AgentJobCreateInput = Omit<
  AgentJobV1,
  'schemaVersion' | 'status' | 'costUsedCents' | 'interruptionReason' | 'waitingReason'
  | 'result' | 'outcomeRowId' | 'createdAt' | 'updatedAt' | 'startedAt' | 'finishedAt'
> & {
  status?: 'queued' | 'ready'
}

export interface AgentJobTransitionInput {
  status: AgentJobStatus
  guard?: AgentJobTransitionGuard
  interruptionReason?: string | null
  waitingReason?: string | null
  result?: StepOutcomeV1 | null
  outcomeRowId?: number | null
  runId?: string | null
  worktreePath?: string | null
}

export interface AgentJobs {
  create: (input: AgentJobCreateInput) => AgentJobV1
  get: (id: string) => AgentJobV1 | null
  listProject: (projectPath: string) => AgentJobV1[]
  listGroup: (groupId: string) => AgentJobV1[]
  children: (parentJobId: string) => AgentJobV1[]
  transition: (id: string, input: AgentJobTransitionInput) => AgentJobV1
  link: (id: string, patch: {
    callId?: string | null
    subSessionId?: number | null
    runId?: string | null
    accountId?: number | null
    worktreePath?: string | null
  }) => AgentJobV1
  promoteReady: (projectPath: string) => AgentJobV1[]
  reconcileRunning: (reason: string) => number
  retry: (id: string, newId: string) => AgentJobV1
  cancelTree: (id: string) => number
}

interface AgentJobRow {
  id: string
  projectPath: string
  chatId: number | null
  pipelineId: number | null
  planId: number | null
  planStepId: number | null
  parentJobId: string | null
  groupId: string | null
  kind: AgentJobV1['kind']
  role: string
  goal: string
  status: AgentJobStatus
  dependsOnJson: string
  readScopeJson: string
  writeScopeJson: string
  providerId: string
  model: string
  accountId: number | null
  attempt: number
  maxAttempts: number
  callId: string | null
  subSessionId: number | null
  runId: string | null
  worktreePath: string | null
  costCapCents: number | null
  interruptionReason: string | null
  waitingReason: string | null
  resultJson: string | null
  outcomeRowId: number | null
  createdAt: number
  updatedAt: number
  startedAt: number | null
  finishedAt: number | null
  costUsedCents: number
}

const SELECT = `
  SELECT j.id, j.project_path projectPath, j.chat_id chatId,
         j.pipeline_id pipelineId, j.plan_id planId, j.plan_step_id planStepId,
         j.parent_job_id parentJobId, j.group_id groupId, j.kind, j.role, j.goal,
         j.status, j.depends_on_json dependsOnJson, j.read_scope_json readScopeJson,
         j.write_scope_json writeScopeJson, j.provider_id providerId, j.model,
         j.account_id accountId, j.attempt, j.max_attempts maxAttempts,
         j.call_id callId, j.sub_session_id subSessionId, j.run_id runId,
         j.worktree_path worktreePath, j.cost_cap_cents costCapCents,
         j.interruption_reason interruptionReason, j.waiting_reason waitingReason,
         j.result_json resultJson, j.outcome_row_id outcomeRowId,
         j.created_at createdAt, j.updated_at updatedAt,
         j.started_at startedAt, j.finished_at finishedAt,
         COALESCE(ROUND((
           SELECT SUM(u.cost_amount) * 100
           FROM agent_run_usage u
           WHERE u.run_id = j.run_id AND u.currency = 'USD'
         )), 0) costUsedCents
  FROM agent_jobs j
`

function parseStringArray(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function toJob(row: AgentJobRow): AgentJobV1 {
  return {
    schemaVersion: 1,
    id: row.id,
    projectPath: row.projectPath,
    chatId: row.chatId,
    pipelineId: row.pipelineId,
    planId: row.planId,
    planStepId: row.planStepId,
    parentJobId: row.parentJobId,
    groupId: row.groupId,
    kind: row.kind,
    role: row.role,
    goal: row.goal,
    status: row.status,
    dependsOn: parseStringArray(row.dependsOnJson),
    readScope: parseStringArray(row.readScopeJson),
    writeScope: parseStringArray(row.writeScopeJson),
    providerId: row.providerId,
    model: row.model,
    accountId: row.accountId,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    callId: row.callId,
    subSessionId: row.subSessionId,
    runId: row.runId,
    worktreePath: row.worktreePath,
    costCapCents: row.costCapCents,
    costUsedCents: row.costUsedCents,
    interruptionReason: row.interruptionReason,
    waitingReason: row.waitingReason,
    result: parseStepOutcomeJson(row.resultJson).value,
    outcomeRowId: row.outcomeRowId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  }
}

export function createAgentJobs(db: Database): AgentJobs {
  const get = (id: string): AgentJobV1 | null => {
    const row = db.prepare(`${SELECT} WHERE j.id=?`).get(id) as AgentJobRow | undefined
    return row ? toJob(row) : null
  }
  const listChildren = (parentJobId: string): AgentJobV1[] =>
    (db.prepare(`${SELECT} WHERE j.parent_job_id=? ORDER BY j.created_at, j.id`).all(parentJobId) as AgentJobRow[]).map(toJob)
  const create = (input: AgentJobCreateInput): AgentJobV1 => {
    const now = Date.now()
    db.prepare(`
      INSERT INTO agent_jobs (
        id, project_path, chat_id, pipeline_id, plan_id, plan_step_id,
        parent_job_id, group_id, kind, role, goal, status,
        depends_on_json, read_scope_json, write_scope_json,
        provider_id, model, account_id, attempt, max_attempts, call_id,
        sub_session_id, run_id, worktree_path, cost_cap_cents,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      input.id, input.projectPath, input.chatId, input.pipelineId, input.planId, input.planStepId,
      input.parentJobId, input.groupId, input.kind, input.role, input.goal, input.status ?? 'queued',
      JSON.stringify(input.dependsOn), JSON.stringify(input.readScope), JSON.stringify(input.writeScope),
      input.providerId, input.model, input.accountId, input.attempt, input.maxAttempts, input.callId,
      input.subSessionId, input.runId, input.worktreePath, input.costCapCents,
      now, now,
    )
    const created = get(input.id)
    if (!created) throw new Error(`Agent Job ${input.id} не создана`)
    return created
  }
  const transition = db.transaction((id: string, input: AgentJobTransitionInput): AgentJobV1 => {
    const current = get(id)
    if (!current) throw new Error(`Agent Job ${id} не найдена`)
    assertAgentJobTransition(current, input.status, input.guard)
    const now = Date.now()
    const startedAt = input.status === 'running' ? (current.startedAt ?? now) : current.startedAt
    const finishedAt = TERMINAL_AGENT_JOB_STATUSES.has(input.status) ? now : null
    db.prepare(`
      UPDATE agent_jobs
      SET status=?, interruption_reason=?, waiting_reason=?, result_json=?,
          outcome_row_id=?, run_id=?, worktree_path=?, started_at=?, finished_at=?, updated_at=?
      WHERE id=?
    `).run(
      input.status,
      input.interruptionReason ?? null,
      input.waitingReason ?? null,
      input.result === undefined ? (current.result ? JSON.stringify(current.result) : null) : input.result ? JSON.stringify(input.result) : null,
      input.outcomeRowId === undefined ? current.outcomeRowId : input.outcomeRowId,
      input.runId === undefined ? current.runId : input.runId,
      input.worktreePath === undefined ? current.worktreePath : input.worktreePath,
      startedAt,
      finishedAt,
      now,
      id,
    )
    const updated = get(id)
    if (!updated) throw new Error(`Agent Job ${id} исчезла после перехода`)
    return updated
  })
  return {
    create,
    get,
    listProject(projectPath) {
      return (db.prepare(`${SELECT} WHERE j.project_path=? ORDER BY j.created_at, j.id`).all(projectPath) as AgentJobRow[]).map(toJob)
    },
    listGroup(groupId) {
      return (db.prepare(`${SELECT} WHERE j.group_id=? ORDER BY j.created_at, j.id`).all(groupId) as AgentJobRow[]).map(toJob)
    },
    children(parentJobId) {
      return listChildren(parentJobId)
    },
    transition(id, input) {
      return transition(id, input)
    },
    link(id, patch) {
      const current = get(id)
      if (!current) throw new Error(`Agent Job ${id} не найдена`)
      const now = Date.now()
      db.prepare(`
        UPDATE agent_jobs
        SET call_id=?, sub_session_id=?, run_id=?, account_id=?, worktree_path=?, updated_at=?
        WHERE id=?
      `).run(
        patch.callId === undefined ? current.callId : patch.callId,
        patch.subSessionId === undefined ? current.subSessionId : patch.subSessionId,
        patch.runId === undefined ? current.runId : patch.runId,
        patch.accountId === undefined ? current.accountId : patch.accountId,
        patch.worktreePath === undefined ? current.worktreePath : patch.worktreePath,
        now,
        id,
      )
      const updated = get(id)
      if (!updated) throw new Error(`Agent Job ${id} исчезла после link`)
      return updated
    },
    promoteReady(projectPath) {
      const queued = (db.prepare(`${SELECT} WHERE j.project_path=? AND j.status='queued' ORDER BY j.created_at, j.id`).all(projectPath) as AgentJobRow[]).map(toJob)
      const promoted: AgentJobV1[] = []
      for (const job of queued) {
        const deps = job.dependsOn.map(dep => get(dep))
        if (deps.some(dep => dep && TERMINAL_AGENT_JOB_STATUSES.has(dep.status) && dep.status !== 'succeeded')) {
          transition(job.id, { status: 'blocked', waitingReason: 'dependency-not-succeeded' })
          continue
        }
        if (deps.length === job.dependsOn.length && deps.every(dep => dep?.status === 'succeeded')) {
          promoted.push(transition(job.id, { status: 'ready', guard: { dependenciesSucceeded: true } }))
        }
      }
      return promoted
    },
    reconcileRunning(reason) {
      const rows = db.prepare("SELECT id FROM agent_jobs WHERE status='running'").all() as Array<{ id: string }>
      for (const row of rows) transition(row.id, { status: 'interrupted', interruptionReason: reason })
      return rows.length
    },
    retry(id, newId) {
      const previous = get(id)
      if (!previous) throw new Error(`Agent Job ${id} не найдена`)
      if (!['failed', 'blocked', 'interrupted'].includes(previous.status)) {
        throw new Error(`Agent Job ${id} в статусе ${previous.status} нельзя повторить`)
      }
      if (previous.attempt >= previous.maxAttempts) throw new Error(`Agent Job ${id}: исчерпаны попытки`)
      return create({
        id: newId,
        projectPath: previous.projectPath,
        chatId: previous.chatId,
        pipelineId: previous.pipelineId,
        planId: previous.planId,
        planStepId: previous.planStepId,
        parentJobId: previous.parentJobId,
        groupId: previous.groupId,
        kind: previous.kind,
        role: previous.role,
        goal: previous.goal,
        dependsOn: previous.dependsOn,
        readScope: previous.readScope,
        writeScope: previous.writeScope,
        providerId: previous.providerId,
        model: previous.model,
        accountId: previous.accountId,
        attempt: previous.attempt + 1,
        maxAttempts: previous.maxAttempts,
        callId: previous.callId,
        subSessionId: previous.subSessionId,
        runId: null,
        worktreePath: null,
        costCapCents: previous.costCapCents,
      })
    },
    cancelTree(id) {
      const stack = [id]
      let cancelled = 0
      while (stack.length > 0) {
        const currentId = stack.pop()!
        stack.push(...listChildren(currentId).map(child => child.id))
        const current = get(currentId)
        if (!current || TERMINAL_AGENT_JOB_STATUSES.has(current.status)) continue
        transition(currentId, { status: 'cancelled' })
        cancelled++
      }
      return cancelled
    },
  }
}
