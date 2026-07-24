import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createAgentJobs, type AgentJobCreateInput } from '../../electron/storage/agent-jobs'

describe('durable agent jobs storage 2.1.2', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'verstak-agent-jobs-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const input = (id: string, patch: Partial<AgentJobCreateInput> = {}): AgentJobCreateInput => ({
    id,
    projectPath: '/project',
    chatId: 1,
    pipelineId: null,
    planId: null,
    planStepId: null,
    parentJobId: null,
    groupId: 'group-1',
    kind: 'delegate',
    role: 'executor',
    goal: `job ${id}`,
    dependsOn: [],
    readScope: ['src'],
    writeScope: [],
    providerId: 'openai',
    model: 'gpt-test',
    accountId: null,
    attempt: 1,
    maxAttempts: 2,
    callId: `call-${id}`,
    subSessionId: null,
    runId: null,
    worktreePath: null,
    costCapCents: 100,
    ...patch,
  })

  it('promotes only after dependencies succeeded and keeps lineage', () => {
    const db = openDb(join(dir, 'test.db'))
    const jobs = createAgentJobs(db)
    jobs.create(input('a'))
    jobs.create(input('b', { dependsOn: ['a'], parentJobId: 'a' }))
    expect(jobs.promoteReady('/project').map(job => job.id)).toEqual(['a'])
    jobs.transition('a', { status: 'running', guard: { scheduler: true } })
    jobs.transition('a', { status: 'succeeded' })
    expect(jobs.promoteReady('/project').map(job => job.id)).toEqual(['b'])
    expect(jobs.children('a')[0]).toMatchObject({ id: 'b', parentJobId: 'a' })
    db.close()
  })

  it('reconcile interrupts running jobs and writer does not auto-ready', () => {
    const db = openDb(join(dir, 'test.db'))
    const jobs = createAgentJobs(db)
    jobs.create(input('writer', { status: 'ready', writeScope: ['src/a.ts'] }))
    jobs.transition('writer', { status: 'running', guard: { scheduler: true } })
    expect(jobs.reconcileRunning('app-restart')).toBe(1)
    expect(jobs.get('writer')).toMatchObject({ status: 'interrupted', interruptionReason: 'app-restart' })
    expect(() => jobs.transition('writer', { status: 'ready' })).toThrow(/подтверждения/)
    expect(jobs.transition('writer', { status: 'ready', guard: { userApprovedResume: true } }).status).toBe('ready')
    db.close()
  })

  it('retry creates attempt+1 and preserves previous result', () => {
    const db = openDb(join(dir, 'test.db'))
    const jobs = createAgentJobs(db)
    jobs.create(input('first', { status: 'ready' }))
    jobs.transition('first', { status: 'running', guard: { scheduler: true } })
    jobs.transition('first', {
      status: 'failed',
      result: {
        status: 'failed',
        summary: 'failed',
        observations: [],
        changedFiles: [],
        checks: [],
        evidence: [],
        assumptionFailures: [],
        recommendedAction: 'retry',
      },
    })
    const retry = jobs.retry('first', 'second')
    expect(retry).toMatchObject({ id: 'second', attempt: 2, status: 'queued', result: null })
    expect(jobs.get('first')).toMatchObject({ attempt: 1, status: 'failed', result: { summary: 'failed' } })
    db.close()
  })

  it('failed dependency переводит ожидающую job в blocked', () => {
    const db = openDb(join(dir, 'test.db'))
    const jobs = createAgentJobs(db)
    jobs.create(input('failed', { status: 'ready' }))
    jobs.create(input('dependent', { dependsOn: ['failed'] }))
    jobs.transition('failed', { status: 'running', guard: { scheduler: true } })
    jobs.transition('failed', { status: 'failed' })
    jobs.promoteReady('/project')
    expect(jobs.get('dependent')).toMatchObject({ status: 'blocked', waitingReason: 'dependency-not-succeeded' })
    db.close()
  })
})
