import { scanText } from '../../ai/secret-scanner'
import { parseTaskContract, type TaskContractV1 } from '../../../shared/contracts/outcome'
import type { ToolHandler } from './shared'

const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []

export const submitTaskContractHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    if (!ctx.outcome || ctx.outcome.phase !== 'refine') {
      return { id: call.id, name: call.name, result: '', error: 'OUTCOME_PHASE_REQUIRED: submit_task_contract доступен только в refine' }
    }
    if (!ctx.pipelineRuns) {
      return { id: call.id, name: call.name, result: '', error: 'OUTCOME_STORAGE_UNAVAILABLE' }
    }
    const current = ctx.pipelineRuns.get(ctx.outcome.pipelineId)
    if (!current || current.projectPath !== ctx.projectPath) {
      return { id: call.id, name: call.name, result: '', error: 'OUTCOME_PIPELINE_MISMATCH' }
    }
    const contract: TaskContractV1 = {
      schemaVersion: 1,
      revision: current.contractRevision + 1,
      rawRequest: current.brief.goal,
      goal: String(call.args.goal ?? '').trim(),
      successCriteria: list(call.args.successCriteria).map(raw => {
        const item = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
        return {
          id: String(item.id ?? '').trim(),
          text: String(item.text ?? '').trim(),
          evidence: String(item.evidence ?? 'manual') as TaskContractV1['successCriteria'][number]['evidence'],
          ...(typeof item.verify === 'string' && item.verify.trim() ? { verify: item.verify.trim() } : {}),
        }
      }),
      constraints: list(call.args.constraints).map(String),
      nonGoals: list(call.args.nonGoals).map(String),
      assumptions: list(call.args.assumptions).map(raw => {
        const item = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
        return {
          text: String(item.text ?? '').trim(),
          status: String(item.status ?? 'unconfirmed') as TaskContractV1['assumptions'][number]['status'],
        }
      }),
      blockingQuestions: list(call.args.blockingQuestions).map(String),
      repoEvidence: list(call.args.repoEvidence).map(raw => {
        const item = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
        return {
          path: String(item.path ?? '').trim(),
          ...(typeof item.symbol === 'string' && item.symbol.trim() ? { symbol: item.symbol.trim() } : {}),
          why: String(item.why ?? '').trim(),
        }
      }),
      risk: String(call.args.risk ?? 'medium') as TaskContractV1['risk'],
      planningMode: String(call.args.planningMode ?? 'controlled') as TaskContractV1['planningMode'],
    }
    const parsed = parseTaskContract(contract)
    if (!parsed.value) {
      return { id: call.id, name: call.name, result: '', error: `TASK_CONTRACT_INVALID: ${parsed.diagnostics.map(d => `${d.path}: ${d.message}`).join('; ')}` }
    }
    const scan = scanText(JSON.stringify(parsed.value))
    if (scan.hits.length > 0) {
      return { id: call.id, name: call.name, result: '', error: `TASK_CONTRACT_SECRET_BLOCKED: ${scan.hits.join(', ')}` }
    }
    const updated = ctx.pipelineRuns.saveContract(current.id, parsed.value)
    ctx.sender.send('ai:event', {
      id: ctx.sendId,
      event: { type: 'task-contract-created', pipelineId: updated.id, revision: updated.contractRevision, contract: parsed.value },
    })
    return {
      id: call.id,
      name: call.name,
      result: parsed.value.blockingQuestions.length > 0
        ? `Task Contract revision ${parsed.value.revision} сохранён. План заблокирован до ответа на вопросы.`
        : `Task Contract revision ${parsed.value.revision} сохранён и готов к одобрению.`,
    }
  },
}
