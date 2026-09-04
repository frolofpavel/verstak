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
  computeHeadlessTaskRequestHash,
  createHeadlessHost,
} = await import('../../electron/headless/host')
const { createAesGcmSafeStorage } = await import('../../electron/headless/secure-storage')
const { openDb } = await import('../../electron/storage/db')
const {
  createHeadlessIdempotencyStore,
  HEADLESS_IDEMPOTENCY_CONFLICT,
  HEADLESS_IDEMPOTENCY_PENDING,
} = await import('../../electron/storage/headless-idempotency')

function immediateProvider(calls: { n: number }, onFirstSend?: () => void): ChatProvider {
  return {
    id: 'idempotency-test',
    name: 'idempotency-test',
    models: ['idempotency-test'],
    async *send(): AsyncGenerator<ChatEvent> {
      calls.n += 1
      if (calls.n === 1) onFirstSend?.()
      yield { type: 'text', text: 'готово' }
      yield { type: 'done' }
    },
  }
}

describe('headless durable task idempotency', () => {
  let root: string
  let hosts: Array<{ close: (opts?: { timeoutMs?: number }) => Promise<void> }>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vsk-idempotency-'))
    hosts = []
    prepareSystemContextMock.mockReset()
    prepareSystemContextMock.mockResolvedValue({ system: 'test system' })
  })

  afterEach(async () => {
    for (const host of hosts) await host.close({ timeoutMs: 500 })
    rmSync(root, { recursive: true, force: true })
  })

  async function boot(input?: {
    dataDir?: string
    workspaceRoot?: string
    calls?: { n: number }
    onFirstSend?: () => void
    maxActiveRuns?: number
    maxRunsPer24h?: number
  }) {
    const dataDir = input?.dataDir ?? join(root, `data-${hosts.length}`)
    const workspaceRoot = input?.workspaceRoot ?? join(root, `ws-${hosts.length}`)
    const calls = input?.calls ?? { n: 0 }
    mkdirSync(workspaceRoot, { recursive: true })
    const host = await createHeadlessHost({
      dataDir,
      workspaceRoots: [workspaceRoot],
      safeStorage: createAesGcmSafeStorage(randomBytes(32)),
      env: {},
      schedulerPollMs: null,
      maxActiveRuns: input?.maxActiveRuns ?? 2,
      maxRunsPer24h: input?.maxRunsPer24h ?? 20,
      providerFactory: () => immediateProvider(calls, input?.onFirstSend),
    })
    hosts.push(host)
    return { host, dataDir, workspaceRoot, calls }
  }

  it('semantic SHA-256 ignores the minted inference apiKey but detects business changes', () => {
    const first = {
      prompt: 'собери отчёт',
      model: 'gpt-test',
      agentMode: 'bypass' as const,
      inference: { baseUrl: 'https://gateway.internal/v1', apiKey: 'run-secret-one', models: ['gpt-test'] },
    }
    const second = {
      ...first,
      inference: { ...first.inference, apiKey: 'run-secret-two' },
    }
    expect(computeHeadlessTaskRequestHash(first, 'create')).toMatch(/^[a-f0-9]{64}$/)
    expect(computeHeadlessTaskRequestHash(first, 'create'))
      .toBe(computeHeadlessTaskRequestHash(second, 'create'))
    expect(computeHeadlessTaskRequestHash(first, 'create'))
      .not.toBe(computeHeadlessTaskRequestHash({ ...second, prompt: 'другой отчёт' }, 'create'))
  })

  it('v65 lease reclaim fences the stale claimant and keeps one completed mapping', () => {
    const db = openDb(join(root, 'lease.db'))
    try {
      const schema = db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number }
      expect(schema.version).toBeGreaterThanOrEqual(65)
      const store = createHeadlessIdempotencyStore(db)
      const first = store.claim({ key: 'lease-key', operation: 'create', requestHash: 'hash', leaseMs: 100, retentionMs: 10_000, now: 1_000 })
      expect(first.kind).toBe('claimed')
      if (first.kind !== 'claimed') throw new Error('first claim missing')

      const pending = store.claim({ key: 'lease-key', operation: 'create', requestHash: 'hash', leaseMs: 100, retentionMs: 10_000, now: 1_050 })
      expect(pending).toEqual({ kind: 'pending', retryAfterSeconds: 1 })
      const second = store.claim({ key: 'lease-key', operation: 'create', requestHash: 'hash', leaseMs: 100, retentionMs: 10_000, now: 1_101 })
      expect(second.kind).toBe('claimed')
      if (second.kind !== 'claimed') throw new Error('second claim missing')
      expect(second.claim.claimToken).not.toBe(first.claim.claimToken)

      expect(() => store.complete(first.claim, 'stale-run', 1, 1_102))
        .toThrow(HEADLESS_IDEMPOTENCY_PENDING)
      store.complete(second.claim, 'accepted-run', 2, 1_103)
      expect(store.lookup('lease-key', 'create', 'hash', 1_104))
        .toEqual({ kind: 'completed', runId: 'accepted-run', threadId: 2 })
    } finally {
      db.close()
    }
  })

  it('expires mappings on a fixed TTL without sliding it on replay', () => {
    const db = openDb(join(root, 'ttl.db'))
    try {
      const store = createHeadlessIdempotencyStore(db)
      const claimed = store.claim({
        key: 'ttl-key-0001', operation: 'create', requestHash: 'hash-one',
        leaseMs: 100, retentionMs: 1_000, now: 1_000,
      })
      if (claimed.kind !== 'claimed') throw new Error('claim missing')
      store.complete(claimed.claim, 'run-one', 1, 1_010)
      expect(store.lookup('ttl-key-0001', 'create', 'hash-one', 1_900))
        .toEqual({ kind: 'completed', runId: 'run-one', threadId: 1 })
      const beforeExpiry = db.prepare(
        "SELECT expires_at as expiresAt FROM headless_task_idempotency WHERE idempotency_key = 'ttl-key-0001'"
      ).get() as { expiresAt: number }
      expect(beforeExpiry.expiresAt).toBe(2_000)

      // Once the original fixed window expires, the opaque key may be bound anew.
      const reclaimed = store.claim({
        key: 'ttl-key-0001', operation: 'continue', requestHash: 'hash-two',
        leaseMs: 100, retentionMs: 2_000, now: 2_001,
      })
      expect(reclaimed.kind).toBe('claimed')
      expect((db.prepare('SELECT COUNT(*) AS n FROM headless_task_idempotency').get() as { n: number }).n).toBe(1)
    } finally {
      db.close()
    }
  })

  it('accepts all durable artifacts atomically before provider send and replays before daily capacity', async () => {
    const dataDir = join(root, 'atomic-data')
    const workspaceRoot = join(root, 'atomic-ws')
    let observedAtomicAcceptance = false
    const setup = await boot({
      dataDir,
      workspaceRoot,
      maxActiveRuns: 1,
      maxRunsPer24h: 1,
      onFirstSend: () => {
        const db = openDb(join(dataDir, 'verstak.db'))
        try {
          const counts = Object.fromEntries(['chat_sessions', 'chats', 'agent_runs', 'agent_run_events'].map(table => {
            const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
            return [table, row.n]
          }))
          const mapping = db.prepare(
            "SELECT status, run_id as runId, thread_id as threadId FROM headless_task_idempotency WHERE idempotency_key = 'atomic-key'"
          ).get() as { status: string; runId: string; threadId: number }
          expect(counts).toEqual({ chat_sessions: 1, chats: 1, agent_runs: 1, agent_run_events: 1 })
          expect(mapping.status).toBe('completed')
          expect(mapping.runId).toBeTruthy()
          expect(mapping.threadId).toBeGreaterThan(0)
          observedAtomicAcceptance = true
        } finally {
          db.close()
        }
      },
    })
    const request = {
      prompt: 'ровно один прогон',
      providerId: 'deepseek' as const,
      agentMode: 'bypass' as const,
      idempotency: { key: 'atomic-key', operation: 'create' as const },
    }
    const first = await setup.host.startTask(request)
    await first.completion
    const providerCalls = setup.calls.n
    const replay = await setup.host.startTask(request)
    expect(replay.runId).toBe(first.runId)
    expect(replay.threadId).toBe(first.threadId)
    expect(setup.calls.n).toBe(providerCalls)
    expect(observedAtomicAcceptance).toBe(true)

    await expect(setup.host.startTask({
      ...request,
      prompt: 'новая задача',
      idempotency: { key: 'another-key', operation: 'create' },
    })).rejects.toThrow(/HEADLESS_CAPACITY_DAILY/)
  })

  it('same key with different semantics or operation is a conflict and creates nothing new', async () => {
    const { host, dataDir, calls } = await boot()
    const first = await host.startTask({
      prompt: 'исходная задача',
      providerId: 'deepseek',
      agentMode: 'bypass',
      idempotency: { key: 'conflict-key', operation: 'create' },
    })
    await first.completion
    const callsAfterFirst = calls.n

    await expect(host.startTask({
      prompt: 'изменённая задача',
      providerId: 'deepseek',
      agentMode: 'bypass',
      idempotency: { key: 'conflict-key', operation: 'create' },
    })).rejects.toThrow(HEADLESS_IDEMPOTENCY_CONFLICT)
    await expect(host.startTask({
      threadId: first.threadId,
      prompt: 'исходная задача',
      providerId: 'deepseek',
      agentMode: 'bypass',
      idempotency: { key: 'conflict-key', operation: 'continue' },
    })).rejects.toThrow(HEADLESS_IDEMPOTENCY_CONFLICT)
    expect(calls.n).toBe(callsAfterFirst)

    const db = openDb(join(dataDir, 'verstak.db'))
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as { n: number }
      expect(row.n).toBe(1)
    } finally {
      db.close()
    }
  })

  it('coalesces truly concurrent duplicates into the same accepted task', async () => {
    let releaseContext: () => void = () => {}
    let contextEntered: () => void = () => {}
    const gate = new Promise<void>(resolve => { releaseContext = resolve })
    const entered = new Promise<void>(resolve => { contextEntered = resolve })
    prepareSystemContextMock.mockImplementation(async () => {
      contextEntered()
      await gate
      return { system: 'test system' }
    })
    const { host, dataDir, calls } = await boot()
    const request = {
      prompt: 'параллельный дубль',
      providerId: 'deepseek' as const,
      agentMode: 'bypass' as const,
      idempotency: { key: 'parallel-key', operation: 'create' as const },
    }
    const firstPromise = host.startTask(request)
    await entered
    const secondPromise = host.startTask(request)
    releaseContext()
    const [first, second] = await Promise.all([firstPromise, secondPromise])
    expect(second.runId).toBe(first.runId)
    expect(second.threadId).toBe(first.threadId)
    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    await Promise.all([first.completion, second.completion])
    expect(calls.n).toBeGreaterThan(0)

    const db = openDb(join(dataDir, 'verstak.db'))
    try {
      for (const table of ['headless_task_idempotency', 'chat_sessions', 'agent_runs']) {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
        expect(row.n, table).toBe(1)
      }
      const userMessages = db.prepare("SELECT COUNT(*) AS n FROM chats WHERE role = 'user'").get() as { n: number }
      expect(userMessages.n).toBe(1)
    } finally {
      db.close()
    }
  })

  it('rejects keys outside the shared edge alphabet/length contract before touching SQLite', async () => {
    const { host, dataDir } = await boot()
    for (const key of ['short', 'contains space', 'кириллица-key', 'x'.repeat(129)]) {
      await expect(host.startTask({
        prompt: 'invalid key',
        providerId: 'deepseek',
        idempotency: { key, operation: 'create' },
      })).rejects.toThrow('HEADLESS_IDEMPOTENCY_INVALID')
    }
    const db = openDb(join(dataDir, 'verstak.db'))
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM headless_task_idempotency').get() as { n: number }).n).toBe(0)
      expect((db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as { n: number }).n).toBe(0)
    } finally {
      db.close()
    }
  })

  it('releases a failed pre-accept claim so the exact request can retry', async () => {
    prepareSystemContextMock.mockRejectedValueOnce(new Error('context unavailable'))
    const { host, dataDir } = await boot()
    const request = {
      prompt: 'повтор после safe failure',
      providerId: 'deepseek' as const,
      agentMode: 'bypass' as const,
      idempotency: { key: 'retryable-key', operation: 'create' as const },
    }
    await expect(host.startTask(request)).rejects.toThrow('context unavailable')
    const db = openDb(join(dataDir, 'verstak.db'))
    try {
      const row = db.prepare(
        "SELECT status, run_id as runId FROM headless_task_idempotency WHERE idempotency_key = 'retryable-key'"
      ).get() as { status: string; runId: string | null }
      expect(row).toEqual({ status: 'retryable', runId: null })
      expect((db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as { n: number }).n).toBe(0)
    } finally {
      db.close()
    }

    const retried = await host.startTask(request)
    await retried.completion
    expect(host.getRunStatus(retried.runId)).toBe('done')
  })

  it('replays the original durable run after host restart without calling a provider', async () => {
    const dataDir = join(root, 'restart-data')
    const workspaceRoot = join(root, 'restart-ws')
    const firstCalls = { n: 0 }
    const firstBoot = await boot({ dataDir, workspaceRoot, calls: firstCalls, maxRunsPer24h: 1 })
    const request = {
      prompt: 'переживи рестарт',
      providerId: 'deepseek' as const,
      agentMode: 'bypass' as const,
      idempotency: { key: 'restart-key', operation: 'create' as const },
    }
    const first = await firstBoot.host.startTask(request)
    await first.completion
    await firstBoot.host.close({ timeoutMs: 500 })
    hosts.splice(hosts.indexOf(firstBoot.host), 1)

    const restartedCalls = { n: 0 }
    const restarted = await boot({ dataDir, workspaceRoot, calls: restartedCalls, maxRunsPer24h: 1 })
    const replay = await restarted.host.startTask(request)
    expect(replay.runId).toBe(first.runId)
    expect(replay.threadId).toBe(first.threadId)
    expect(restartedCalls.n).toBe(0)
    await replay.completion
  })

  it('idempotent continue appends one user turn and one run only', async () => {
    const { host, dataDir, calls } = await boot()
    const first = await host.startTask({
      prompt: 'первый ход', providerId: 'deepseek', agentMode: 'bypass',
    })
    await first.completion
    const request = {
      threadId: first.threadId,
      prompt: 'уточнение',
      providerId: 'deepseek' as const,
      agentMode: 'bypass' as const,
      idempotency: { key: 'continue-key', operation: 'continue' as const },
    }
    const continued = await host.startTask(request)
    await continued.completion
    const callsAfterContinue = calls.n
    const replay = await host.startTask(request)
    expect(replay.runId).toBe(continued.runId)
    expect(replay.threadId).toBe(first.threadId)
    expect(calls.n).toBe(callsAfterContinue)

    const db = openDb(join(dataDir, 'verstak.db'))
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as { n: number }).n).toBe(2)
      expect((db.prepare("SELECT COUNT(*) AS n FROM chats WHERE role = 'user'").get() as { n: number }).n).toBe(2)
      expect((db.prepare('SELECT COUNT(*) AS n FROM chat_sessions').get() as { n: number }).n).toBe(1)
    } finally {
      db.close()
    }
  })
})
