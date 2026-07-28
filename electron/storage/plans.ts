import type { Database } from 'better-sqlite3'
import {
  parsePlanQualityJson,
  parsePlanStepSpec,
  type PlanQualityV1,
  type PlanStepSpecV1,
} from '../../shared/contracts/outcome'

export type PlanStatus = 'draft' | 'running' | 'done' | 'cancelled'
export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

export interface PlanStep {
  id: number
  planId: number
  idx: number
  title: string
  detail: string | null
  status: StepStatus
  result: string | null
  // Execution-trace: какой run выполнил шаг, прошла ли верификация, сколько файлов изменилось.
  runId: string | null
  verificationStatus: string | null
  changedFilesCount: number | null
  spec: PlanStepSpecV1 | null
}

export interface Plan {
  id: number
  title: string
  status: PlanStatus
  createdAt: number
  completedAt: number | null
  contractRevision: number | null
  planRevision: number
  quality: PlanQualityV1 | null
  /** Происхождение плана. Заполнено, если план вырос из диалога; у планов,
   *  созданных внешним скриптом мимо create_plan, остаётся null. */
  chatId: number | null
  sourceMessageId: number | null
  /** Прогон, породивший план (нужен блоку B для продолжения после approve). */
  agentRunId: string | null
  steps: PlanStep[]
}

export interface NewStep {
  title: string
  detail?: string | null
  spec?: PlanStepSpecV1 | null
}

export interface CreatePlanMeta {
  contractRevision?: number | null
  planRevision?: number
  quality?: PlanQualityV1 | null
  /** Происхождение: из какого чата, сообщения и прогона вырос план. */
  chatId?: number | null
  sourceMessageId?: number | null
  agentRunId?: string | null
}

/** Что меняет доработка плана. quality/agentRunId необязательны: на чат-пути
 *  Task Contract'а нет (некому считать quality), а прогон-якорь переезжает на
 *  тот, чей чекпойнт понесёт продолжение. Пропущенное поле НЕ трогается. */
export interface ReplacePendingMeta {
  planRevision: number
  quality?: PlanQualityV1
  agentRunId?: string | null
}

export interface Plans {
  list: (projectPath: string) => Plan[]
  get: (id: number) => Plan | null
  create: (projectPath: string, title: string, steps: NewStep[], meta?: CreatePlanMeta) => Plan
  updatePlanStatus: (id: number, status: PlanStatus) => void
  updateStep: (id: number, patch: { status?: StepStatus; result?: string | null; runId?: string | null; verificationStatus?: string | null; changedFilesCount?: number | null }) => void
  replacePending: (id: number, steps: NewStep[], meta: ReplacePendingMeta) => Plan
  /** План, ждущий решения человека по этому прогону (§10). Продолжение после
   *  «Доработать» приходит с якорем на чекпойнт того же прогона — по этой связи
   *  рантайм узнаёт, какой план править, не спрашивая модель. */
  findDraftByRunId: (runId: string) => Plan | null
  remove: (id: number) => void
}

interface PlanRow {
  id: number
  title: string
  status: PlanStatus
  createdAt: number
  completedAt: number | null
  contractRevision: number | null
  planRevision: number
  qualityJson: string | null
  chatId: number | null
  sourceMessageId: number | null
  agentRunId: string | null
}

interface StepRow {
  id: number
  planId: number
  idx: number
  title: string
  detail: string | null
  status: StepStatus
  result: string | null
  runId: string | null
  verificationStatus: string | null
  changedFilesCount: number | null
  specJson: string | null
}

export function createPlans(db: Database): Plans {
  function safeSpec(json: string | null): PlanStepSpecV1 | null {
    if (!json) return null
    try {
      return parsePlanStepSpec(JSON.parse(json)).value
    } catch {
      return null
    }
  }

  function getSteps(planId: number): PlanStep[] {
    const rows = db.prepare(`
      SELECT id, plan_id as planId, idx, title, detail, status, result,
             run_id as runId, verification_status as verificationStatus,
             changed_files_count as changedFilesCount, spec_json as specJson
      FROM plan_steps WHERE plan_id = ? ORDER BY idx ASC
    `).all(planId) as StepRow[]
    return rows.map(({ specJson, ...row }) => ({ ...row, spec: safeSpec(specJson) }))
  }

  return {
    list(projectPath) {
      const rows = db.prepare(`
        SELECT id, title, status, created_at as createdAt, completed_at as completedAt,
               contract_revision as contractRevision, plan_revision as planRevision, quality_json as qualityJson,
               chat_id as chatId, source_message_id as sourceMessageId, agent_run_id as agentRunId
        FROM plans WHERE project_path = ?
        ORDER BY id DESC
      `).all(projectPath) as PlanRow[]
      return rows.map(({ qualityJson, ...row }) => ({
        ...row,
        quality: parsePlanQualityJson(qualityJson),
        steps: getSteps(row.id),
      }))
    },
    get(id) {
      const row = db.prepare(`
        SELECT id, title, status, created_at as createdAt, completed_at as completedAt,
               contract_revision as contractRevision, plan_revision as planRevision, quality_json as qualityJson,
               chat_id as chatId, source_message_id as sourceMessageId, agent_run_id as agentRunId
        FROM plans WHERE id = ?
      `).get(id) as PlanRow | undefined
      if (!row) return null
      const { qualityJson, ...planRow } = row
      return { ...planRow, quality: parsePlanQualityJson(qualityJson), steps: getSteps(row.id) }
    },
    create(projectPath, title, steps, meta = {}) {
      const now = Date.now()
      const planInfo = db.prepare(
        `INSERT INTO plans
          (project_path, title, status, created_at, contract_revision, plan_revision, quality_json,
           chat_id, source_message_id, agent_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        projectPath,
        title,
        'draft',
        now,
        meta.contractRevision ?? null,
        meta.planRevision ?? 1,
        meta.quality ? JSON.stringify(meta.quality) : null,
        meta.chatId ?? null,
        meta.sourceMessageId ?? null,
        meta.agentRunId ?? null,
      )
      const planId = Number(planInfo.lastInsertRowid)
      const insertStep = db.prepare(
        'INSERT INTO plan_steps (plan_id, idx, title, detail, status, spec_json) VALUES (?, ?, ?, ?, ?, ?)'
      )
      for (let i = 0; i < steps.length; i++) {
        insertStep.run(
          planId,
          i,
          steps[i].title,
          steps[i].detail ?? null,
          'pending',
          steps[i].spec ? JSON.stringify(steps[i].spec) : null,
        )
      }
      const created = this.get(planId)
      if (!created) throw new Error(`plan ${planId} disappeared`)
      return created
    },
    updatePlanStatus(id, status) {
      const completedAt = status === 'done' ? Date.now() : null
      db.prepare('UPDATE plans SET status = ?, completed_at = ? WHERE id = ?').run(status, completedAt, id)
    },
    updateStep(id, patch) {
      const fields: string[] = []
      const params: unknown[] = []
      if (patch.status !== undefined) { fields.push('status = ?'); params.push(patch.status) }
      if (patch.result !== undefined) { fields.push('result = ?'); params.push(patch.result) }
      if (patch.runId !== undefined) { fields.push('run_id = ?'); params.push(patch.runId) }
      if (patch.verificationStatus !== undefined) { fields.push('verification_status = ?'); params.push(patch.verificationStatus) }
      if (patch.changedFilesCount !== undefined) { fields.push('changed_files_count = ?'); params.push(patch.changedFilesCount) }
      if (fields.length === 0) return
      params.push(id)
      db.prepare(`UPDATE plan_steps SET ${fields.join(', ')} WHERE id = ?`).run(...params)
    },
    replacePending(id, steps, meta) {
      const tx = db.transaction(() => {
        const current = this.get(id)
        if (!current) throw new Error(`plan ${id} not found`)
        if (meta.planRevision !== current.planRevision + 1) {
          throw new Error(`plan revision must advance from ${current.planRevision} to ${current.planRevision + 1}`)
        }
        db.prepare(`DELETE FROM plan_steps WHERE plan_id = ? AND status != 'done'`).run(id)
        const maxDoneIdx = current.steps
          .filter(step => step.status === 'done')
          .reduce((max, step) => Math.max(max, step.idx), -1)
        const insert = db.prepare(
          'INSERT INTO plan_steps (plan_id, idx, title, detail, status, spec_json) VALUES (?, ?, ?, ?, ?, ?)',
        )
        steps.forEach((step, index) => {
          insert.run(id, maxDoneIdx + index + 1, step.title, step.detail ?? null, 'pending', step.spec ? JSON.stringify(step.spec) : null)
        })
        // Необязательные поля пишем только когда они заданы: чат-путь не считает
        // quality (нет Task Contract'а), и затирать ею оценку outcome-плана нельзя.
        const fields = ['plan_revision = ?']
        const params: unknown[] = [meta.planRevision]
        if (meta.quality !== undefined) { fields.push('quality_json = ?'); params.push(JSON.stringify(meta.quality)) }
        if (meta.agentRunId !== undefined) { fields.push('agent_run_id = ?'); params.push(meta.agentRunId) }
        params.push(id)
        db.prepare(
          `UPDATE plans SET ${fields.join(', ')}, status='draft', completed_at=NULL WHERE id=?`,
        ).run(...params)
      })
      tx()
      const updated = this.get(id)
      if (!updated) throw new Error(`plan ${id} disappeared`)
      return updated
    },
    findDraftByRunId(runId) {
      if (!runId) return null
      const row = db.prepare(
        `SELECT id FROM plans WHERE agent_run_id = ? AND status = 'draft' ORDER BY id DESC LIMIT 1`,
      ).get(runId) as { id: number } | undefined
      return row ? this.get(row.id) : null
    },
    remove(id) {
      // Чек-лист живёт своей жизнью: удаление плана НЕ уносит пункты. У связанных
      // обнуляем связь — пункт остаётся видимым, просто перестаёт указывать на
      // несуществующий план. Каскад здесь был бы потерей пользовательских данных.
      db.prepare('UPDATE tasks SET plan_id = NULL, plan_step_id = NULL WHERE plan_id = ?').run(id)
      db.prepare('DELETE FROM plan_steps WHERE plan_id = ?').run(id)
      db.prepare('DELETE FROM plans WHERE id = ?').run(id)
    }
  }
}
