import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatEvent, ChatProvider } from '../../electron/ai/types'

vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron' (headless Node)")
})

const { createHeadlessHost } = await import('../../electron/headless/host')
const { createAesGcmSafeStorage } = await import('../../electron/headless/secure-storage')

function immediateProvider(): ChatProvider {
  return {
    id: 'immediate', name: 'immediate', models: ['immediate'],
    async *send(): AsyncGenerator<ChatEvent> {
      yield { type: 'text', text: 'ok' }
      yield { type: 'done' }
    }
  }
}

function heldProvider(signal: AbortSignal): ChatProvider {
  return {
    id: 'held', name: 'held', models: ['held'],
    async *send(): AsyncGenerator<ChatEvent> {
      if (signal.aborted) return
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
      return
    }
  }
}

describe('headless per-tenant capacity guards', () => {
  let root: string
  let hosts: Array<{ close: (opts?: { timeoutMs?: number }) => Promise<void> }>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vsk-capacity-'))
    hosts = []
  })

  afterEach(async () => {
    for (const host of hosts) await host.close({ timeoutMs: 500 })
    rmSync(root, { recursive: true, force: true })
  })

  async function boot(maxActiveRuns: number, maxRunsPer24h: number, held = false) {
    const dataDir = join(root, `data-${hosts.length}`)
    const workspaceRoot = join(root, `ws-${hosts.length}`)
    mkdirSync(workspaceRoot, { recursive: true })
    const host = await createHostAt(dataDir, workspaceRoot, maxActiveRuns, maxRunsPer24h, held)
    hosts.push(host)
    return host
  }

  async function createHostAt(
    dataDir: string,
    workspaceRoot: string,
    maxActiveRuns: number,
    maxRunsPer24h: number,
    held = false
  ) {
    return createHeadlessHost({
      dataDir,
      workspaceRoots: [workspaceRoot],
      safeStorage: createAesGcmSafeStorage(randomBytes(32)),
      env: {},
      schedulerPollMs: null,
      maxActiveRuns,
      maxRunsPer24h,
      providerFactory: (_id, _model, signal) => held ? heldProvider(signal) : immediateProvider()
    })
  }

  it('two truly concurrent starts reserve one active slot atomically, then stop releases it', async () => {
    const host = await boot(1, 10, true)
    const starts = await Promise.allSettled([
      host.startTask({ prompt: 'one', providerId: 'deepseek', agentMode: 'bypass' }),
      host.startTask({ prompt: 'two', providerId: 'deepseek', agentMode: 'bypass' })
    ])

    const winners = starts.filter(r => r.status === 'fulfilled')
    const rejected = starts.filter(r => r.status === 'rejected')
    expect(winners).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/HEADLESS_CAPACITY_ACTIVE/)

    const winner = (winners[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof host.startTask>>>).value
    winner.stop()
    await winner.completion.catch(() => undefined)

    const replacement = await host.startTask({ prompt: 'replacement', providerId: 'deepseek', agentMode: 'bypass' })
    replacement.stop()
    await replacement.completion.catch(() => undefined)
  })

  it('real create-stop loops are idempotent and cannot grow durable runs beyond the 24-hour limit', async () => {
    const host = await boot(1, 3, true)
    for (const prompt of ['one', 'two', 'three']) {
      const task = await host.startTask({ prompt, providerId: 'deepseek', agentMode: 'bypass' })
      for (let n = 0; n < 10; n += 1) task.stop()
      await task.completion.catch(() => undefined)
    }

    const durable = host.listTasks({ limit: 10 })
    expect(durable).toHaveLength(3)
    expect(new Set(durable.map(task => task.runId)).size).toBe(3)
    expect(durable.every(task => task.endedAt !== null && task.status !== 'running')).toBe(true)

    await expect(host.startTask({
      prompt: 'fourth', providerId: 'deepseek', agentMode: 'bypass'
    })).rejects.toThrow(/HEADLESS_CAPACITY_DAILY/)
    expect(host.listTasks({ limit: 10 })).toHaveLength(3)
  })

  it('the durable 24-hour limit survives host restart on the same database', async () => {
    const dataDir = join(root, 'restart-data')
    const workspaceRoot = join(root, 'restart-ws')
    mkdirSync(workspaceRoot, { recursive: true })

    const first = await createHostAt(dataDir, workspaceRoot, 1, 2)
    hosts.push(first)
    for (const prompt of ['one', 'two']) {
      const task = await first.startTask({ prompt, providerId: 'deepseek', agentMode: 'bypass' })
      await task.completion
    }
    expect(first.listTasks({ limit: 10 })).toHaveLength(2)
    await first.close({ timeoutMs: 500 })
    hosts.splice(hosts.indexOf(first), 1)

    const restarted = await createHostAt(dataDir, workspaceRoot, 1, 2)
    hosts.push(restarted)
    await expect(restarted.startTask({
      prompt: 'after restart', providerId: 'deepseek', agentMode: 'bypass'
    })).rejects.toThrow(/HEADLESS_CAPACITY_DAILY/)
    expect(restarted.listTasks({ limit: 10 })).toHaveLength(2)
  })
})
