import { describe, expect, it } from 'vitest'
import { summarizeAgentRunPipeline } from '../../src/lib/agent-run-pipeline'
import type { AgentRunEvent } from '../../src/types/api'

function event(over: Partial<AgentRunEvent>): AgentRunEvent {
  return {
    id: over.id ?? 1,
    runId: 'run-1',
    kind: over.kind ?? 'tool_call',
    label: over.label ?? null,
    detail: over.detail ?? null,
    ref: over.ref ?? null,
    status: over.status ?? null,
    createdAt: over.createdAt ?? 1,
  }
}

describe('summarizeAgentRunPipeline', () => {
  it('marks the full agency path from plan to proof', () => {
    const stages = summarizeAgentRunPipeline([
      event({ id: 1, label: 'create_plan' }),
      event({ id: 2, label: 'apply_patch', detail: 'calc.mjs' }),
      event({ id: 3, label: 'attest_verification', detail: 'DoD passed' }),
      event({ id: 4, label: 'review_before_commit', detail: 'REVIEW GATE: ПРОЙДЕНО' }),
      event({ id: 5, kind: 'artifact', label: 'proof_pack', ref: 'proof.html' }),
    ])

    expect(stages.map(s => [s.id, s.state])).toEqual([
      ['plan', 'done'],
      ['patch', 'done'],
      ['verify', 'done'],
      ['review', 'done'],
      ['proof', 'done'],
    ])
  })

  it('keeps missing gates visible instead of pretending the run is complete', () => {
    const stages = summarizeAgentRunPipeline([
      event({ id: 1, label: 'create_plan' }),
      event({ id: 2, kind: 'file_write', label: 'write_file', ref: 'src/value.ts' }),
      event({ id: 3, kind: 'verify', label: 'npm run type', status: 'passed' }),
    ])

    expect(stages.find(s => s.id === 'plan')?.state).toBe('done')
    expect(stages.find(s => s.id === 'patch')?.state).toBe('done')
    expect(stages.find(s => s.id === 'verify')?.state).toBe('done')
    expect(stages.find(s => s.id === 'review')?.state).toBe('missing')
    expect(stages.find(s => s.id === 'proof')?.state).toBe('missing')
  })
})
