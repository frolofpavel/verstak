// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  OutcomeRunsPanel,
  availableInterventionActions,
  filterOutcomeRuns,
  selectOutcomeInterventions,
} from '../../src/components/OutcomeRunsPanel'
import type { AgentJob, PipelineRun } from '../../src/types/api'

describe('2.1.6 Outcome history', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

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

  it('показывает честное пустое состояние', async () => {
    mount({ runs: [] })
    expect(await screen.findByText('В этом разделе прогонов пока нет.')).toBeTruthy()
  })

  it('показывает ошибку durable history, если список прогонов недоступен', async () => {
    mount({ runsError: new Error('storage unavailable') })
    expect((await screen.findByRole('alert')).textContent).toContain('storage unavailable')
  })

  it('не теряет историю при сбое дополнительного списка interventions', async () => {
    mount({ runs: [run(7, 'completed')], jobsError: new Error('jobs unavailable') })
    expect(await screen.findByText('goal-7')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('открывает старый прогон без нового запуска модели', async () => {
    const api = mount({ runs: [run(7, 'completed')] })
    fireEvent.click(await screen.findByText('goal-7'))

    expect(await screen.findByRole('dialog', { name: 'До результата · прогон #7' })).toBeTruthy()
    expect(api.pipeline.start).not.toHaveBeenCalled()
    await waitFor(() => expect(api.pipeline.metrics).toHaveBeenCalledWith('C:/project'))
  })
})

function mount(opts: {
  runs?: PipelineRun[]
  runsError?: Error
  jobsError?: Error
}) {
  const runsError = opts.runsError
  const jobsError = opts.jobsError
  const pipeline = {
    list: runsError
      ? vi.fn(async () => { throw runsError })
      : vi.fn(async () => opts.runs ?? []),
    metrics: vi.fn(async () => null),
    start: vi.fn(),
    exportPassport: vi.fn(),
  }
  const agentJobs = {
    list: jobsError
      ? vi.fn(async () => { throw jobsError })
      : vi.fn(async () => []),
  }
  const api = {
    pipeline,
    agentJobs,
    plans: { get: vi.fn(async () => null) },
    verifications: {
      latest: vi.fn(async () => null),
      latestByRunId: vi.fn(async () => null),
    },
  }
  vi.stubGlobal('window', Object.assign(globalThis.window, { api }))
  render(createElement(OutcomeRunsPanel, { projectPath: 'C:/project', onClose: vi.fn() }))
  return api
}

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
