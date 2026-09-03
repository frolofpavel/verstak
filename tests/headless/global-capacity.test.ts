import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatEvent, ChatProvider } from '../../electron/ai/types'

const prepareSystemContextMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

vi.mock('../../electron/ai/compose-system', () => ({
  prepareSystemContext: prepareSystemContextMock,
}))

const {
  createHeadlessHost,
  createHeadlessRunCapacity,
} = await import('../../electron/headless/host')
const { createAesGcmSafeStorage } = await import('../../electron/headless/secure-storage')
type HeadlessHost = import('../../electron/headless/host').HeadlessHost
type HeadlessRunCapacity = import('../../electron/headless/host').HeadlessRunCapacity

function heldProvider(signal: AbortSignal): ChatProvider {
  return {
    id: 'held-global',
    name: 'held-global',
    models: ['held-global'],
    async *send(): AsyncGenerator<ChatEvent> {
      if (signal.aborted) return
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
    },
  }
}

function gatedProvider(gate: Promise<void>): ChatProvider {
  return {
    id: 'gated-global',
    name: 'gated-global',
    models: ['gated-global'],
    async *send(): AsyncGenerator<ChatEvent> {
      await gate
      yield { type: 'done' }
    },
  }
}

describe('headless global provider-run capacity', () => {
  let root: string
  let hosts: HeadlessHost[]

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vsk-global-capacity-'))
    hosts = []
    prepareSystemContextMock.mockReset()
    prepareSystemContextMock.mockResolvedValue({ system: 'test system' })
  })

  afterEach(async () => {
    await Promise.all(hosts.map(host => host.close({ timeoutMs: 500 })))
    rmSync(root, { recursive: true, force: true })
  })

  async function bootHost(
    name: string,
    capacity: HeadlessRunCapacity,
    providerFactory: NonNullable<Parameters<typeof createHeadlessHost>[0]['providerFactory']>,
  ): Promise<HeadlessHost> {
    const dataDir = join(root, `${name}-data`)
    const workspaceRoot = join(root, `${name}-workspace`)
    mkdirSync(workspaceRoot, { recursive: true })
    const host = await createHeadlessHost({
      dataDir,
      workspaceRoots: [workspaceRoot],
      safeStorage: createAesGcmSafeStorage(randomBytes(32)),
      env: {},
      schedulerPollMs: null,
      maxActiveRuns: 3,
      maxRunsPer24h: 100,
      globalRunCapacity: capacity,
      providerFactory,
    })
    hosts.push(host)
    return host
  }

  it('atomically admits only two starts across five tenant hosts and stop releases both slots', async () => {
    const capacity = createHeadlessRunCapacity(2)
    const tenantHosts = await Promise.all(Array.from(
      { length: 5 },
      (_, index) => bootHost(`tenant-${index}`, capacity, (_id, _model, signal) => heldProvider(signal)),
    ))

    const starts = await Promise.allSettled(tenantHosts.map((host, index) => host.startTask({
      prompt: `tenant task ${index}`,
      providerId: 'deepseek',
      agentMode: 'bypass',
    })))
    const accepted = starts.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<HeadlessHost['startTask']>>> =>
        result.status === 'fulfilled'
    )
    const rejected = starts.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    expect(accepted).toHaveLength(2)
    expect(rejected).toHaveLength(3)
    expect(rejected.every(result => String(result.reason).includes('HEADLESS_CAPACITY_GLOBAL'))).toBe(true)
    expect(capacity.activeCount()).toBe(2)

    for (const result of accepted) result.value.stop()
    await Promise.all(accepted.map(result => result.value.completion.catch(() => undefined)))
    expect(capacity.activeCount()).toBe(0)

    const replacement = await tenantHosts[4].startTask({
      prompt: 'replacement after stop',
      providerId: 'deepseek',
      agentMode: 'bypass',
    })
    expect(capacity.activeCount()).toBe(1)
    replacement.stop()
    await replacement.completion.catch(() => undefined)
    expect(capacity.activeCount()).toBe(0)
  })

  it('releases a reservation after preparation failure and after natural completion', async () => {
    const capacity = createHeadlessRunCapacity(1)
    let finishHealthy: () => void = () => {}
    const healthyGate = new Promise<void>(resolve => { finishHealthy = resolve })
    const broken = await bootHost('broken', capacity, () => {
      throw new Error('provider setup failed')
    })
    const healthy = await bootHost('healthy', capacity, () => gatedProvider(healthyGate))

    await expect(broken.startTask({ prompt: 'broken', providerId: 'deepseek' }))
      .rejects.toThrow('provider setup failed')
    expect(capacity.activeCount()).toBe(0)

    const completed = await healthy.startTask({ prompt: 'healthy', providerId: 'deepseek' })
    expect(capacity.activeCount()).toBe(1)
    finishHealthy()
    await completed.completion
    expect(capacity.activeCount()).toBe(0)
  })

  it('durable replay succeeds at full global capacity without provider call or extra slot', async () => {
    const capacity = createHeadlessRunCapacity(1)
    let providerFactories = 0
    const firstHost = await bootHost('first', capacity, (_id, _model, signal) => {
      providerFactories += 1
      return heldProvider(signal)
    })
    const otherHost = await bootHost('other', capacity, (_id, _model, signal) => heldProvider(signal))
    const request = {
      prompt: 'exactly once globally',
      providerId: 'deepseek' as const,
      agentMode: 'bypass' as const,
      idempotency: { key: 'global-idempotency-key', operation: 'create' as const },
    }

    const accepted = await firstHost.startTask(request)
    expect(capacity.activeCount()).toBe(1)
    await expect(otherHost.startTask({ prompt: 'fresh', providerId: 'deepseek' }))
      .rejects.toThrow('HEADLESS_CAPACITY_GLOBAL')

    const replay = await firstHost.startTask(request)
    expect(replay).toMatchObject({
      runId: accepted.runId,
      threadId: accepted.threadId,
      replayed: true,
    })
    expect(providerFactories).toBe(1)
    expect(capacity.activeCount()).toBe(1)

    accepted.stop()
    await accepted.completion.catch(() => undefined)
    expect(capacity.activeCount()).toBe(0)
  })

  it('reports real host eviction eligibility across enabled schedule and live run lifecycle', async () => {
    const capacity = createHeadlessRunCapacity(1)
    let finish: () => void = () => {}
    const gate = new Promise<void>(resolve => { finish = resolve })
    const host = await bootHost('eviction-state', capacity, () => gatedProvider(gate))

    expect(host.canEvictIdle?.()).toBe(true)
    const job = host.scheduledJobs.create({
      name: 'future protected job',
      prompt: 'scheduled prompt',
      schedule: { kind: 'once', runAt: Date.now() + 60_000 },
      maxRuns: 1,
    })
    expect(host.canEvictIdle?.()).toBe(false)
    host.scheduledJobs.setEnabled(job.id, false)
    expect(host.canEvictIdle?.()).toBe(true)

    const running = await host.startTask({
      prompt: 'live run protects host',
      providerId: 'deepseek',
      agentMode: 'bypass',
    })
    expect(host.canEvictIdle?.()).toBe(false)
    finish()
    await running.completion
    expect(host.canEvictIdle?.()).toBe(true)
  })

  it('canary host option removes schedule from the provider tool surface', async () => {
    const capacity = createHeadlessRunCapacity(1)
    let exposedTools: string[] = []
    const dataDir = join(root, 'canary-tools-data')
    const workspaceRoot = join(root, 'canary-tools-workspace')
    mkdirSync(workspaceRoot, { recursive: true })
    const host = await createHeadlessHost({
      dataDir,
      workspaceRoots: [workspaceRoot],
      safeStorage: createAesGcmSafeStorage(randomBytes(32)),
      env: {},
      schedulerPollMs: null,
      globalRunCapacity: capacity,
      enableScheduledTasks: false,
      providerFactory: () => ({
        id: 'tool-capture',
        name: 'tool-capture',
        models: ['tool-capture'],
        async *send(_messages, tools): AsyncGenerator<ChatEvent> {
          exposedTools = tools.map(tool => tool.name)
          yield { type: 'done' }
        },
      }),
    })
    hosts.push(host)

    const task = await host.startTask({
      prompt: 'canary tools',
      providerId: 'deepseek',
      agentMode: 'bypass',
    })
    await task.completion
    expect(exposedTools).not.toContain('schedule')
    expect(exposedTools).toContain('web_search')
    expect(exposedTools).toContain('read_file')
  })

  it('disabled schedules neither execute nor pin a host with an old enabled job', async () => {
    const dataDir = join(root, 'disabled-schedule-data')
    const workspaceRoot = join(root, 'disabled-schedule-workspace')
    mkdirSync(workspaceRoot, { recursive: true })
    let providerCalls = 0
    const host = await createHeadlessHost({
      dataDir,
      workspaceRoots: [workspaceRoot],
      safeStorage: createAesGcmSafeStorage(randomBytes(32)),
      env: {},
      schedulerPollMs: null,
      enableScheduledTasks: false,
      providerFactory: () => {
        providerCalls += 1
        return gatedProvider(Promise.resolve())
      },
    })
    hosts.push(host)

    const job = host.scheduledJobs.create({
      name: 'old enabled job',
      prompt: 'must stay dormant in canary',
      schedule: { kind: 'once', runAt: Date.now() - 1_000 },
      maxRuns: 1,
    })
    expect(job.enabled).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(providerCalls).toBe(0)
    expect(host.canEvictIdle?.()).toBe(true)
  })
})
