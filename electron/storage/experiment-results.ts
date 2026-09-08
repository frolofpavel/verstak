/**
 * Хранилище итогов экспериментов Workflow Scientist.
 *
 * Хранится ТОЛЬКО итог. Контролируемые прогоны делает существующий харнесс
 * `scripts/eval/` — второго прогонщика в продукте не заводится.
 *
 * Запрет самовольного применения закреплён в СХЕМЕ (`CHECK auto_applied = 0`), а
 * не только в коде: код можно обойти забывчивостью следующей правки, схему — нет.
 */
import type { Database } from 'better-sqlite3'
import type { ExperimentResultV1, Recommendation } from '../../shared/contracts/experiment'

export interface StoredExperimentResult extends ExperimentResultV1 {
  id: number
  projectPath: string
}

export interface ExperimentResults {
  insert: (projectPath: string, result: ExperimentResultV1) => number
  list: (projectPath: string, limit?: number) => StoredExperimentResult[]
}

type Row = {
  id: number
  project_path: string
  hypothesis: string
  changed_factor: string
  baseline: string
  candidate: string
  task_set: string
  repeats: number
  success_rate_before: number
  success_rate_after: number
  cost_before: number
  cost_after: number
  latency_before: number
  latency_after: number
  verification_before: number
  verification_after: number
  recommendation: string
  confidence: number
  created_at: number
}

export function createExperimentResults(db: Database): ExperimentResults {
  const insertOne = db.prepare(`
    INSERT INTO experiment_results (
      project_path, hypothesis, changed_factor, baseline, candidate, task_set, repeats,
      success_rate_before, success_rate_after, cost_before, cost_after,
      latency_before, latency_after, verification_before, verification_after,
      recommendation, confidence, auto_applied, created_at
    ) VALUES (
      @projectPath, @hypothesis, @changedFactor, @baseline, @candidate, @taskSet, @repeats,
      @successRateBefore, @successRateAfter, @costBefore, @costAfter,
      @latencyBefore, @latencyAfter, @verificationBefore, @verificationAfter,
      @recommendation, @confidence, 0, @createdAt
    )
  `)
  const listByProject = db.prepare(
    'SELECT * FROM experiment_results WHERE project_path = ? ORDER BY created_at DESC LIMIT ?'
  )

  return {
    insert(projectPath, result) {
      const info = insertOne.run({ projectPath, ...result })
      return Number(info.lastInsertRowid)
    },

    list(projectPath, limit = 50) {
      return (listByProject.all(projectPath, limit) as Row[]).map(row => ({
        id: row.id,
        projectPath: row.project_path,
        hypothesis: row.hypothesis,
        changedFactor: row.changed_factor as ExperimentResultV1['changedFactor'],
        baseline: row.baseline,
        candidate: row.candidate,
        taskSet: row.task_set,
        repeats: row.repeats,
        successRateBefore: row.success_rate_before,
        successRateAfter: row.success_rate_after,
        costBefore: row.cost_before,
        costAfter: row.cost_after,
        latencyBefore: row.latency_before,
        latencyAfter: row.latency_after,
        verificationBefore: row.verification_before,
        verificationAfter: row.verification_after,
        recommendation: row.recommendation as Recommendation,
        confidence: row.confidence,
        // Читается КОНСТАНТОЙ, а не из строки: схема не даёт записать иное, и
        // читатель артефакта видит границу без похода в базу.
        autoApplied: false,
        appliedAt: null,
        createdAt: row.created_at,
      }))
    },
  }
}
