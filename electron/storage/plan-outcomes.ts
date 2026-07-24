import type { Database } from 'better-sqlite3'
import {
  parseStepOutcomeJson,
  type AdaptiveDecisionV1,
  type StepOutcomeV1,
} from '../../shared/contracts/outcome'

export interface StoredStepOutcome {
  id: number
  planId: number
  stepId: number
  planRevision: number
  runId: string
  attempt: number
  status: StepOutcomeV1['status']
  outcome: StepOutcomeV1
  failureSignature: string | null
  decision: AdaptiveDecisionV1 | null
  createdAt: number
}

export interface PlanRevisionSnapshot {
  id: number
  planId: number
  revision: number
  reason: string
  snapshot: unknown
  createdAt: number
}

export interface PlanOutcomes {
  finalize: (input: Omit<StoredStepOutcome, 'id' | 'createdAt'>) => { outcome: StoredStepOutcome; inserted: boolean }
  list: (planId: number) => StoredStepOutcome[]
  latestForStep: (stepId: number) => StoredStepOutcome | null
  countFailureSignature: (planId: number, signature: string) => number
  saveRevision: (planId: number, revision: number, reason: string, snapshot: unknown) => { inserted: boolean }
  revisions: (planId: number) => PlanRevisionSnapshot[]
}

interface OutcomeRow {
  id: number
  planId: number
  stepId: number
  planRevision: number
  runId: string
  attempt: number
  status: StepOutcomeV1['status']
  outcomeJson: string
  failureSignature: string | null
  decisionJson: string | null
  createdAt: number
}

export function createPlanOutcomes(db: Database): PlanOutcomes {
  const toOutcome = (row: OutcomeRow): StoredStepOutcome => {
    const parsed = parseStepOutcomeJson(row.outcomeJson).value
    if (!parsed) throw new Error(`Corrupt step outcome ${row.id}`)
    let decision: AdaptiveDecisionV1 | null = null
    try { decision = row.decisionJson ? JSON.parse(row.decisionJson) as AdaptiveDecisionV1 : null } catch { decision = null }
    return { ...row, outcome: parsed, decision }
  }
  const selectAttempt = (stepId: number, runId: string, attempt: number): StoredStepOutcome | null => {
    const row = db.prepare(`
      SELECT id, plan_id planId, step_id stepId, plan_revision planRevision,
             run_id runId, attempt, status, outcome_json outcomeJson,
             failure_signature failureSignature, decision_json decisionJson, created_at createdAt
      FROM plan_step_outcomes WHERE step_id=? AND run_id=? AND attempt=?
    `).get(stepId, runId, attempt) as OutcomeRow | undefined
    return row ? toOutcome(row) : null
  }
  return {
    finalize(input) {
      const info = db.prepare(`
        INSERT OR IGNORE INTO plan_step_outcomes
          (plan_id, step_id, plan_revision, run_id, attempt, status, outcome_json,
           failure_signature, decision_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.planId, input.stepId, input.planRevision, input.runId, input.attempt,
        input.status, JSON.stringify(input.outcome), input.failureSignature,
        input.decision ? JSON.stringify(input.decision) : null, Date.now(),
      )
      const outcome = selectAttempt(input.stepId, input.runId, input.attempt)
      if (!outcome) throw new Error('Step outcome disappeared after finalize')
      return { outcome, inserted: info.changes === 1 }
    },
    list(planId) {
      const rows = db.prepare(`
        SELECT id, plan_id planId, step_id stepId, plan_revision planRevision,
               run_id runId, attempt, status, outcome_json outcomeJson,
               failure_signature failureSignature, decision_json decisionJson, created_at createdAt
        FROM plan_step_outcomes WHERE plan_id=? ORDER BY id
      `).all(planId) as OutcomeRow[]
      return rows.map(toOutcome)
    },
    latestForStep(stepId) {
      const row = db.prepare(`
        SELECT id, plan_id planId, step_id stepId, plan_revision planRevision,
               run_id runId, attempt, status, outcome_json outcomeJson,
               failure_signature failureSignature, decision_json decisionJson, created_at createdAt
        FROM plan_step_outcomes WHERE step_id=? ORDER BY id DESC LIMIT 1
      `).get(stepId) as OutcomeRow | undefined
      return row ? toOutcome(row) : null
    },
    countFailureSignature(planId, signature) {
      const row = db.prepare(
        'SELECT COUNT(*) count FROM plan_step_outcomes WHERE plan_id=? AND failure_signature=?',
      ).get(planId, signature) as { count: number }
      return row.count
    },
    saveRevision(planId, revision, reason, snapshot) {
      const info = db.prepare(`
        INSERT OR IGNORE INTO plan_revisions
          (plan_id, revision, reason, snapshot_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(planId, revision, reason, JSON.stringify(snapshot), Date.now())
      return { inserted: info.changes === 1 }
    },
    revisions(planId) {
      const rows = db.prepare(`
        SELECT id, plan_id planId, revision, reason, snapshot_json snapshotJson, created_at createdAt
        FROM plan_revisions WHERE plan_id=? ORDER BY revision
      `).all(planId) as Array<{ id: number; planId: number; revision: number; reason: string; snapshotJson: string; createdAt: number }>
      return rows.map(({ snapshotJson, ...row }) => {
        let snapshot: unknown = null
        try { snapshot = JSON.parse(snapshotJson) } catch { snapshot = null }
        return { ...row, snapshot }
      })
    },
  }
}
