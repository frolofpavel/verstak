import type { AgentRunEvent } from '../types/api'

export type AgentRunPipelineStageId = 'plan' | 'patch' | 'verify' | 'review' | 'proof'
export type AgentRunPipelineStageState = 'done' | 'missing'

export interface AgentRunPipelineStage {
  id: AgentRunPipelineStageId
  label: string
  state: AgentRunPipelineStageState
  detail: string | null
}

function lastMatching(
  events: ReadonlyArray<AgentRunEvent>,
  predicate: (event: AgentRunEvent) => boolean,
): AgentRunEvent | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (predicate(events[i])) return events[i]
  }
  return null
}

function done(detail: string | null = null): Pick<AgentRunPipelineStage, 'state' | 'detail'> {
  return { state: 'done', detail }
}

function missing(): Pick<AgentRunPipelineStage, 'state' | 'detail'> {
  return { state: 'missing', detail: null }
}

export function summarizeAgentRunPipeline(events: ReadonlyArray<AgentRunEvent>): AgentRunPipelineStage[] {
  const plan = lastMatching(events, e => e.kind === 'tool_call' && e.label === 'create_plan')
  const patch = lastMatching(events, e => e.kind === 'file_write'
    || (e.kind === 'tool_call' && (e.label === 'apply_patch' || e.label === 'write_file')))
  const verify = lastMatching(events, e => e.kind === 'verify'
    || (e.kind === 'tool_call' && e.label === 'attest_verification'))
  const review = lastMatching(events, e => e.kind === 'tool_call' && e.label === 'review_before_commit')
  const proof = lastMatching(events, e => e.kind === 'artifact'
    || (e.kind === 'tool_call' && (e.label ?? '').toLowerCase().includes('proof')))

  const stages: Array<AgentRunPipelineStage & { data: Pick<AgentRunPipelineStage, 'state' | 'detail'> }> = [
    { id: 'plan', label: 'Plan', data: plan ? done(plan.detail ?? null) : missing(), state: 'missing', detail: null },
    { id: 'patch', label: 'Patch', data: patch ? done(patch.ref ?? patch.detail ?? null) : missing(), state: 'missing', detail: null },
    { id: 'verify', label: 'Verify', data: verify ? done(verify.detail ?? verify.status ?? null) : missing(), state: 'missing', detail: null },
    { id: 'review', label: 'Review', data: review ? done(review.detail ?? review.status ?? null) : missing(), state: 'missing', detail: null },
    { id: 'proof', label: 'Proof', data: proof ? done(proof.detail ?? proof.ref ?? null) : missing(), state: 'missing', detail: null },
  ]

  return stages.map(({ id, label, data }) => ({ id, label, state: data.state, detail: data.detail }))
}
