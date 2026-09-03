import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
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

const { createHeadlessHost, createHeadlessRunCapacity } = await import('../../electron/headless/host')
const { createAesGcmSafeStorage } = await import('../../electron/headless/secure-storage')
const { openDb } = await import('../../electron/storage/db')

function unusedProvider(onSend: () => void): ChatProvider {
  return {
    id: 'unused',
    name: 'unused',
    models: ['unused'],
    async *send(): AsyncGenerator<ChatEvent> {
      onSend()
      yield { type: 'done' }
    },
  }
}

describe('headless host — start/close race', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vsk-start-close-'))
    prepareSystemContextMock.mockReset()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('shutdown during context preparation leaves no orphan run, thread or message', async () => {
    let releaseContext: () => void = () => {}
    let contextEntered: () => void = () => {}
    const contextGate = new Promise<void>(resolve => { releaseContext = resolve })
    const entered = new Promise<void>(resolve => {
      contextEntered = resolve
    })
    prepareSystemContextMock.mockImplementation(async () => {
      contextEntered()
      await contextGate
      return { system: 'test system' }
    })

    const dataDir = join(root, 'data')
    const workspaceRoot = join(root, 'workspaces')
    mkdirSync(workspaceRoot, { recursive: true })
    let providerCalls = 0
    const globalRunCapacity = createHeadlessRunCapacity(1)
    const host = await createHeadlessHost({
      dataDir,
      workspaceRoots: [workspaceRoot],
      safeStorage: createAesGcmSafeStorage(randomBytes(32)),
      env: {},
      schedulerPollMs: null,
      globalRunCapacity,
      providerFactory: () =>
        unusedProvider(() => {
          providerCalls += 1
        }),
    })

    const starting = host.startTask({
      prompt: 'не оставляй сироту',
      providerId: 'deepseek',
      agentMode: 'bypass',
      turnsBudget: 1,
    })
    const rejectedStart = expect(starting).rejects.toThrow('headless-хост закрывается')
    await entered
    expect(globalRunCapacity.activeCount()).toBe(1)

    // active ещё не зарегистрирован: раньше close() сразу закрывал SQLite, а
    // продолжившийся start писал в закрытую БД и оставлял частичный тред.
    // close сам прерывает зависшую preaccept-подготовку после grace period. Тест
    // намеренно НИКОГДА не открывает contextGate: shutdown не зависит от ручного
    // освобождения внешнего promise и не закрывает БД до полного start unwind.
    await expect(Promise.race([
      host.close({ timeoutMs: 50 }).then(() => 'closed' as const),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 1_000)),
    ])).resolves.toBe('closed')
    await rejectedStart
    expect(providerCalls).toBe(0)
    expect(globalRunCapacity.activeCount()).toBe(0)

    // Исходный compose promise всё ещё может завершиться позже. Он не владеет DB
    // refs, а abortable wrapper уже отсоединил start continuation: поздний resolve
    // не должен воскресить workspace/строки и не пишет в закрытую SQLite.
    releaseContext()
    await new Promise<void>(resolve => setImmediate(resolve))

    const db = openDb(join(dataDir, 'verstak.db'))
    try {
      for (const table of ['agent_runs', 'chat_sessions', 'chats']) {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
        expect(row.n, table).toBe(0)
      }
    } finally {
      db.close()
    }
    expect(readdirSync(workspaceRoot)).toEqual([])

    await expect(
      host.startTask({
        prompt: 'после close',
        providerId: 'deepseek',
        agentMode: 'bypass',
        turnsBudget: 1,
      }),
    ).rejects.toThrow('headless-хост закрывается')
    expect(prepareSystemContextMock).toHaveBeenCalledTimes(1)
  })

  it('preaccept rejection removes only an auto-created workspace', async () => {
    prepareSystemContextMock.mockResolvedValue({ system: 'unused' })
    const dataDir = join(root, 'cleanup-data')
    const workspaceRoot = join(root, 'cleanup-workspaces')
    const explicitWorkspace = join(workspaceRoot, 'owned-before-request')
    mkdirSync(explicitWorkspace, { recursive: true })
    writeFileSync(join(explicitWorkspace, 'keep.txt'), 'keep')
    const host = await createHeadlessHost({
      dataDir,
      workspaceRoots: [workspaceRoot],
      safeStorage: createAesGcmSafeStorage(randomBytes(32)),
      env: {},
      schedulerPollMs: null,
      providerFactory: () => { throw new Error('provider validation failed') },
    })

    await expect(host.startTask({ prompt: 'auto workspace', providerId: 'deepseek' }))
      .rejects.toThrow('provider validation failed')
    expect(readdirSync(workspaceRoot)).toEqual(['owned-before-request'])

    await expect(host.startTask({
      prompt: 'explicit workspace',
      providerId: 'deepseek',
      workspace: explicitWorkspace,
    })).rejects.toThrow('provider validation failed')
    expect(existsSync(join(explicitWorkspace, 'keep.txt'))).toBe(true)

    await host.close()
  })

  it('rejected continuation never deletes the existing thread workspace', async () => {
    prepareSystemContextMock.mockResolvedValue({ system: 'test system' })
    const dataDir = join(root, 'thread-data')
    const workspaceRoot = join(root, 'thread-workspaces')
    mkdirSync(workspaceRoot, { recursive: true })
    let rejectProvider = false
    const host = await createHeadlessHost({
      dataDir,
      workspaceRoots: [workspaceRoot],
      safeStorage: createAesGcmSafeStorage(randomBytes(32)),
      env: {},
      schedulerPollMs: null,
      providerFactory: () => {
        if (rejectProvider) throw new Error('continuation provider rejected')
        return unusedProvider(() => {})
      },
    })

    const first = await host.startTask({ prompt: 'create thread', providerId: 'deepseek' })
    await first.completion
    const thread = host.getThread(first.runId)
    expect(thread).not.toBeNull()
    writeFileSync(join(thread!.workspace, 'durable.txt'), 'do not remove')

    rejectProvider = true
    await expect(host.startTask({
      prompt: 'rejected continuation',
      providerId: 'deepseek',
      threadId: first.threadId,
    })).rejects.toThrow('continuation provider rejected')
    expect(existsSync(join(thread!.workspace, 'durable.txt'))).toBe(true)

    await host.close()
  })

  it('surfaces a real SQLite close error and allows an explicit cleanup retry', async () => {
    prepareSystemContextMock.mockResolvedValue({ system: 'unused' })
    const dataDir = join(root, 'close-error-data')
    const workspaceRoot = join(root, 'close-error-workspaces')
    mkdirSync(workspaceRoot, { recursive: true })
    const host = await createHeadlessHost({
      dataDir,
      workspaceRoots: [workspaceRoot],
      safeStorage: createAesGcmSafeStorage(randomBytes(32)),
      env: {},
      schedulerPollMs: null,
    })

    // better-sqlite3 instances share this native prototype. The first close models
    // an OS/native failure; the next call uses the real implementation for cleanup.
    const probe = openDb(join(root, 'close-prototype-probe.db'))
    const dbPrototype = Object.getPrototypeOf(probe) as { close: () => void }
    probe.close()
    const closeSpy = vi.spyOn(dbPrototype, 'close')
      .mockImplementationOnce(() => { throw new Error('sqlite close exploded') })
    try {
      await expect(host.close()).rejects.toThrow('sqlite close exploded')
      await expect(host.close()).resolves.toBeUndefined()
      expect(closeSpy).toHaveBeenCalledTimes(2)
    } finally {
      closeSpy.mockRestore()
      await host.close().catch(() => undefined)
    }
  })
})
