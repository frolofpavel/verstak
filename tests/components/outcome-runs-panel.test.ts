import { describe, expect, it } from 'vitest'
import { filterOutcomeRuns } from '../../src/components/OutcomeRunsPanel'
import type { PipelineRun } from '../../src/types/api'

describe('2.1.6 Outcome history', () => {
  it('фильтрует active/completed/attention без потери порядка', () => {
    const runs = [run(4, 'blocked'), run(3, 'execute'), run(2, 'cancelled'), run(1, 'completed')]
    expect(filterOutcomeRuns(runs, 'all').map(item => item.id)).toEqual([4, 3, 2, 1])
    expect(filterOutcomeRuns(runs, 'active').map(item => item.id)).toEqual([4, 3])
    expect(filterOutcomeRuns(runs, 'completed').map(item => item.id)).toEqual([1])
    expect(filterOutcomeRuns(runs, 'attention').map(item => item.id)).toEqual([4, 2])
  })
})

function run(id: number, step: PipelineRun['step']): PipelineRun {
  return {
    id,
    projectPath: 'C:/project',
    chatId: null,
    agentRunId: null,
    mode: 'dev',
    effortLevel: 'controlled',
    workflowId: null,
    step,
    brief: { goal: `goal-${id}`, constraints: '', dod: '' },
    planId: null,
    taskContract: null,
    contractRevision: 0,
    contractDiagnostics: [],
    verifyAttempts: 0,
    createdAt: id,
    updatedAt: id,
  }
}
