import { describe, expect, it } from 'vitest'
import { AgentJobScheduler, PROVIDER_INFLIGHT_CAP } from '../../electron/ai/agent-job-scheduler'
import type { AgentJobs } from '../../electron/storage/agent-jobs'
import type { AgentJobV1 } from '../../shared/contracts/agent-job'
import { SubAgentQueue } from '../../electron/ai/sub-queue'

function makeJob(id: string, patch: Partial<AgentJobV1> = {}): AgentJobV1 {
  return {
    schemaVersion: 1, id, projectPath: '/p', chatId: null, pipelineId: null, planId: null,
    planStepId: null, parentJobId: null, groupId: 'g', kind: 'delegate', role: 'executor',
    goal: id, status: 'ready', dependsOn: [], readScope: [], writeScope: [], providerId: 'openai',
    model: 'gpt', accountId: null, attempt: 1, maxAttempts: 1, callId: null,
    subSessionId: null, runId: null, worktreePath: null, costCapCents: null, costUsedCents: 0,
    interruptionReason: null, waitingReason: null, result: null, outcomeRowId: null,
    createdAt: 1, updatedAt: 1, startedAt: null, finishedAt: null, ...patch,
  }
}

function harness(jobs: AgentJobV1[]) {
  const byId = new Map(jobs.map(job => [job.id, job]))
  let active = 0
  let maxActive = 0
  const queue = {
    async enter() {
      active++
      maxActive = Math.max(maxActive, active)
      return { ticketId: active, release: () => { active-- } }
    },
    cancel: () => 0,
  }
  const store = {
    get: (id: string) => byId.get(id) ?? null,
    listProject: () => [...byId.values()],
    listGroup: (group: string) => [...byId.values()].filter(job => job.groupId === group),
    promoteReady: () => [],
    transition(id: string, input: { status: AgentJobV1['status']; waitingReason?: string | null; result?: AgentJobV1['result'] }) {
      const next = { ...byId.get(id)!, ...input }
      byId.set(id, next)
      return next
    },
  } as unknown as AgentJobs
  return { byId, queue, store, stats: () => ({ active, maxActive }) }
}

describe('Agent Job Scheduler 2.1.2', () => {
  it('provider/account cap не превышает 3', async () => {
    const h = harness(Array.from({ length: 9 }, (_, index) => makeJob(`j${index}`)))
    let providerActive = 0
    let providerMax = 0
    const scheduler = new AgentJobScheduler({
      jobs: h.store,
      queue: h.queue,
      execute: async () => {
        providerActive++
        providerMax = Math.max(providerMax, providerActive)
        await new Promise(resolve => setTimeout(resolve, 5))
        providerActive--
        return {
          status: 'succeeded',
          outcome: { status: 'succeeded', summary: 'ok', observations: [], changedFiles: [], checks: [], evidence: [], assumptionFailures: [], recommendedAction: 'continue' },
        }
      },
    })
    await scheduler.runProject('/p')
    expect(PROVIDER_INFLIGHT_CAP).toBe(3)
    expect(providerMax).toBe(3)
    expect([...h.byId.values()].every(job => job.status === 'succeeded')).toBe(true)
    expect(h.stats().active).toBe(0)
  })

  it('waiting approval освобождает slot и остаётся durable state', async () => {
    const h = harness([makeJob('approval')])
    const scheduler = new AgentJobScheduler({
      jobs: h.store,
      queue: h.queue,
      execute: async () => ({ status: 'waiting-approval', reason: 'write-scope-expansion' }),
    })
    await scheduler.runProject('/p')
    expect(h.byId.get('approval')).toMatchObject({ status: 'waiting-approval', waitingReason: 'write-scope-expansion' })
    expect(h.stats().active).toBe(0)
  })

  it('exception становится failed и slot освобождается', async () => {
    const h = harness([makeJob('boom')])
    const scheduler = new AgentJobScheduler({
      jobs: h.store,
      queue: h.queue,
      execute: async () => { throw new Error('provider down') },
    })
    await scheduler.runProject('/p')
    expect(h.byId.get('boom')).toMatchObject({ status: 'failed', result: { summary: 'provider down' } })
    expect(h.stats().active).toBe(0)
  })

  it('20 jobs используют глобальный семафор и не превышают 6', async () => {
    const h = harness(Array.from({ length: 20 }, (_, index) =>
      makeJob(`j${index}`, { providerId: `provider-${index}` })
    ))
    let active = 0
    let maxActive = 0
    const scheduler = new AgentJobScheduler({
      jobs: h.store,
      queue: new SubAgentQueue(),
      execute: async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 5))
        active--
        return {
          status: 'succeeded',
          outcome: { status: 'succeeded', summary: 'ok', observations: [], changedFiles: [], checks: [], evidence: [], assumptionFailures: [], recommendedAction: 'continue' },
        }
      },
    })
    await scheduler.runProject('/p')
    expect(maxActive).toBeLessThanOrEqual(6)
  })

  it('конфликтующие writers не исполняются одновременно, независимые могут', async () => {
    const h = harness([
      makeJob('a', { writeScope: ['src/**'], providerId: 'a' }),
      makeJob('b', { writeScope: ['src/x.ts'], providerId: 'b' }),
      makeJob('c', { writeScope: ['tests/**'], providerId: 'c' }),
    ])
    const active = new Set<string>()
    let conflictSeen = false
    let independentOverlap = false
    const scheduler = new AgentJobScheduler({
      jobs: h.store,
      queue: new SubAgentQueue(),
      execute: async job => {
        if ((job.id === 'a' && active.has('b')) || (job.id === 'b' && active.has('a'))) conflictSeen = true
        if (job.id === 'c' && active.size > 0) independentOverlap = true
        if ((job.id === 'a' || job.id === 'b') && active.has('c')) independentOverlap = true
        active.add(job.id)
        await new Promise(resolve => setTimeout(resolve, 10))
        active.delete(job.id)
        return {
          status: 'succeeded',
          outcome: { status: 'succeeded', summary: 'ok', observations: [], changedFiles: [], checks: [], evidence: [], assumptionFailures: [], recommendedAction: 'continue' },
        }
      },
    })
    await scheduler.runProject('/p')
    expect(conflictSeen).toBe(false)
    expect(independentOverlap).toBe(true)
  })
})
