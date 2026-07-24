import type { AgentJobV1 } from '../../shared/contracts/agent-job'
import type { StepOutcomeV1 } from '../../shared/contracts/outcome'
import type { AgentJobs } from '../storage/agent-jobs'
import { jobsConflict } from './conflict-graph'

export const PROVIDER_INFLIGHT_CAP = 3

export interface AgentJobQueue {
  enter: (
    opts: { group: string | null; role: string | null; abort: () => void },
    signal?: AbortSignal,
  ) => Promise<{ release: () => void; ticketId: number }>
  cancel: (filter: { all?: boolean; group?: string | null; role?: string | null }) => number
}

export type AgentJobExecutionResult =
  | { status: 'succeeded' | 'failed' | 'blocked'; outcome: StepOutcomeV1; runId?: string | null; worktreePath?: string | null }
  | { status: 'waiting-approval'; reason: string; runId?: string | null; worktreePath?: string | null }

export interface AgentJobSchedulerDeps {
  jobs: AgentJobs
  queue: AgentJobQueue
  execute?: (job: AgentJobV1, signal: AbortSignal) => Promise<AgentJobExecutionResult>
  accountAvailable?: (job: AgentJobV1) => boolean
  providerCap?: number
}

class AsyncSlots {
  private active = 0
  private waiters: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new Error('aborted')
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          signal.removeEventListener('abort', abort)
          this.active++
          resolve()
        }
        const abort = () => {
          const index = this.waiters.indexOf(ready)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new Error('aborted'))
        }
        this.waiters.push(ready)
        signal.addEventListener('abort', abort, { once: true })
      })
    } else {
      this.active++
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      const next = this.waiters.shift()
      if (next) next()
    }
  }
}

class WriteScopeLocks {
  private readonly active = new Map<string, AgentJobV1>()
  private waiters: Array<() => void> = []

  async acquire(job: AgentJobV1, signal: AbortSignal): Promise<() => void> {
    while ([...this.active.values()].some(active => jobsConflict(active, job))) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          signal.removeEventListener('abort', abort)
          resolve()
        }
        const abort = () => {
          const index = this.waiters.indexOf(ready)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new Error('aborted'))
        }
        this.waiters.push(ready)
        signal.addEventListener('abort', abort, { once: true })
      })
    }
    this.active.set(job.id, job)
    let released = false
    return () => {
      if (released) return
      released = true
      this.active.delete(job.id)
      const waiters = this.waiters
      this.waiters = []
      for (const waiter of waiters) waiter()
    }
  }
}

export interface AgentJobLease {
  job: AgentJobV1
  signal: AbortSignal
  release: () => void
}

export class AgentJobScheduler {
  private readonly controllers = new Map<string, AbortController>()
  private readonly providerSlots = new Map<string, AsyncSlots>()
  private readonly writeScopeLocks = new WriteScopeLocks()
  private readonly providerCap: number

  constructor(private readonly deps: AgentJobSchedulerDeps) {
    this.providerCap = Math.max(1, Math.trunc(deps.providerCap ?? PROVIDER_INFLIGHT_CAP))
  }

  async runProject(projectPath: string): Promise<AgentJobV1[]> {
    this.deps.jobs.promoteReady(projectPath)
    const ready = this.deps.jobs.listProject(projectPath).filter(job => job.status === 'ready')
    return Promise.all(ready.map(job => this.runOne(job)))
  }

  async runJob(
    jobId: string,
    execute?: AgentJobSchedulerDeps['execute'],
  ): Promise<AgentJobV1> {
    const job = this.deps.jobs.get(jobId)
    if (!job) throw new Error(`agent job ${jobId} not found`)
    if (job.status === 'queued') this.deps.jobs.promoteReady(job.projectPath)
    const ready = this.deps.jobs.get(jobId)
    if (!ready || ready.status !== 'ready') return ready ?? job
    return this.runOne(ready, execute)
  }

  cancelGroup(groupId: string): number {
    const aborted = this.deps.queue.cancel({ group: groupId })
    for (const job of this.deps.jobs.listGroup(groupId)) {
      this.controllers.get(job.id)?.abort()
      if (!['succeeded', 'failed', 'blocked', 'cancelled'].includes(job.status)) {
        try { this.deps.jobs.transition(job.id, { status: 'cancelled' }) } catch { /* late terminal transition */ }
      }
    }
    return aborted
  }

  cancelJob(jobId: string): number {
    this.controllers.get(jobId)?.abort()
    return this.deps.jobs.cancelTree(jobId)
  }

  async acquire(
    jobId: string,
    externalSignal?: AbortSignal,
    abortExecution?: () => void,
  ): Promise<AgentJobLease> {
    const job = await this.waitUntilReady(jobId, externalSignal)
    if (job.costCapCents != null && job.costUsedCents >= job.costCapCents) {
      this.deps.jobs.transition(job.id, { status: 'blocked', waitingReason: 'cost-cap-exhausted' })
      throw new Error('cost-cap-exhausted')
    }
    if (this.deps.accountAvailable && !this.deps.accountAvailable(job)) {
      this.deps.jobs.transition(job.id, { status: 'blocked', waitingReason: 'account-unavailable' })
      throw new Error('account-unavailable')
    }

    const controller = new AbortController()
    const onExternalAbort = () => controller.abort()
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
    controller.signal.addEventListener('abort', () => abortExecution?.(), { once: true })
    this.controllers.set(job.id, controller)
    let releaseScope: (() => void) | null = null
    let releaseProvider: (() => void) | null = null
    let releaseQueue: (() => void) | null = null
    try {
      releaseScope = await this.writeScopeLocks.acquire(job, controller.signal)
      releaseProvider = await this.slotsFor(job).acquire(controller.signal)
      const queueSlot = await this.deps.queue.enter({
        group: job.groupId,
        role: job.role,
        abort: () => controller.abort(),
      }, controller.signal)
      releaseQueue = queueSlot.release
      const running = this.deps.jobs.transition(job.id, {
        status: 'running',
        guard: { scheduler: true },
      })
      let released = false
      return {
        job: running,
        signal: controller.signal,
        release: () => {
          if (released) return
          released = true
          releaseQueue?.()
          releaseProvider?.()
          releaseScope?.()
          externalSignal?.removeEventListener('abort', onExternalAbort)
          this.controllers.delete(job.id)
        },
      }
    } catch (error) {
      releaseQueue?.()
      releaseProvider?.()
      releaseScope?.()
      externalSignal?.removeEventListener('abort', onExternalAbort)
      this.controllers.delete(job.id)
      throw error
    }
  }

  private async waitUntilReady(jobId: string, signal?: AbortSignal): Promise<AgentJobV1> {
    while (true) {
      if (signal?.aborted) throw new Error('aborted')
      const current = this.deps.jobs.get(jobId)
      if (!current) throw new Error(`agent job ${jobId} not found`)
      if (current.status === 'queued') this.deps.jobs.promoteReady(current.projectPath)
      const refreshed = this.deps.jobs.get(jobId) ?? current
      if (refreshed.status === 'ready') return refreshed
      if (['succeeded', 'failed', 'blocked', 'cancelled', 'interrupted', 'waiting-approval'].includes(refreshed.status)) {
        throw new Error(`agent job ${jobId} cannot start from ${refreshed.status}`)
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, 10)
        const abort = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          reject(new Error('aborted'))
        }
        function done() {
          signal?.removeEventListener('abort', abort)
          resolve()
        }
        signal?.addEventListener('abort', abort, { once: true })
      })
    }
  }

  private slotsFor(job: AgentJobV1): AsyncSlots {
    const key = `${job.providerId}:${job.accountId ?? 'default'}`
    let slots = this.providerSlots.get(key)
    if (!slots) {
      slots = new AsyncSlots(this.providerCap)
      this.providerSlots.set(key, slots)
    }
    return slots
  }

  private async runOne(job: AgentJobV1, execute = this.deps.execute): Promise<AgentJobV1> {
    if (!execute) throw new Error('agent job executor is not configured')
    let lease: AgentJobLease | null = null
    try {
      lease = await this.acquire(job.id)
      const result = await execute(lease.job, lease.signal)
      if (result.status === 'waiting-approval') {
        return this.deps.jobs.transition(job.id, {
          status: 'waiting-approval',
          waitingReason: result.reason,
          runId: result.runId,
          worktreePath: result.worktreePath,
        })
      }
      return this.deps.jobs.transition(job.id, {
        status: result.status,
        result: result.outcome,
        runId: result.runId,
        worktreePath: result.worktreePath,
      })
    } catch (error) {
      const current = this.deps.jobs.get(job.id)
      if (!current || ['succeeded', 'failed', 'blocked', 'cancelled'].includes(current.status)) {
        return current ?? job
      }
      if (lease?.signal.aborted) {
        return this.deps.jobs.transition(job.id, { status: 'cancelled' })
      }
      return this.deps.jobs.transition(job.id, {
        status: 'failed',
        result: {
          status: 'failed',
          summary: error instanceof Error ? error.message : String(error),
          observations: [],
          changedFiles: [],
          checks: [],
          evidence: [],
          assumptionFailures: [],
          recommendedAction: 'retry',
        },
      })
    } finally {
      lease?.release()
    }
  }
}
