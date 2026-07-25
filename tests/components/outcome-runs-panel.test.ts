import { describe, expect, it } from 'vitest'
import {
  availableInterventionActions,
  filterOutcomeRuns,
  selectOutcomeInterventions,
} from '../../src/components/OutcomeRunsPanel'
import type { AgentJob, PipelineRun } from '../../src/types/api'

describe('2.1.6 Outcome history', () => {
  it('фильтрует active/completed/attention без потери порядка', () => {
    const runs = [run(4, 'blocked'), run(3, 'execute'), run(2, 'cancelled'), run(1, 'completed')]
    expect(filterOutcomeRuns(runs, 'all').map(item => item.id)).toEqual([4, 3, 2, 1])
    expect(filterOutcomeRuns(runs, 'active').map(item => item.id)).toEqual([4, 3])
    expect(filterOutcomeRuns(runs, 'completed').map(item => item.id)).toEqual([1])
    expect(filterOutcomeRuns(runs, 'attention').map(item => item.id)).toEqual([4, 2])
  })

  it('2.1.7 показывает только реальные вмешательства и безопасные действия', () => {
    const jobs = [
      job('run', 'running'),
      job('approval', 'waiting-approval'),
      job('crash', 'interrupted'),
      job('blocked', 'blocked'),
      { ...job('variant', 'succeeded'), worktreePath: 'C:/wt' },
    ]
    expect(selectOutcomeInterventions(jobs).map(item => item.id)).toEqual(['approval', 'crash', 'blocked', 'variant'])
    expect(availableInterventionActions(jobs[1])).toEqual(['cancel'])
    expect(availableInterventionActions(jobs[2])).toEqual(['resume', 'cancel'])
    expect(availableInterventionActions(jobs[3])).toEqual([])
    expect(availableInterventionActions(jobs[4])).toEqual(['apply', 'reject'])
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

function job(id: string, status: AgentJob['status']): AgentJob {
  return {
    schemaVersion: 1,
    id,
    projectPath: 'C:/project',
    chatId: null,
    pipelineId: 1,
    planId: null,
    planStepId: null,
    parentJobId: null,
    groupId: null,
    kind: 'outcome-step',
    role: 'executor',
    goal: id,
    status,
    dependsOn: [],
    readScope: [],
    writeScope: [],
    providerId: 'openai',
    model: 'test',
    accountId: null,
    attempt: 1,
    maxAttempts: 2,
    callId: null,
    subSessionId: null,
    runId: null,
    worktreePath: null,
    costCapCents: null,
    costUsedCents: 0,
    interruptionReason: null,
    waitingReason: null,
    result: null,
    outcomeRowId: null,
    createdAt: 1,
    updatedAt: 1,
    startedAt: null,
    finishedAt: null,
  }
}
