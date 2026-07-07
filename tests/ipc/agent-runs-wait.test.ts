import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Database } from 'better-sqlite3'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) },
  },
}))

const { registerAgentRunsIpc } = await import('../../electron/ipc/agent-runs')
const { openDb } = await import('../../electron/storage/db')
const { createAgentRuns } = await import('../../electron/storage/agent-runs')

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler not registered: ${channel}`)
  return Promise.resolve(fn(null, ...args) as T)
}

describe('agent-runs ai:wait ipc', () => {
  let dir: string
  let db: Database

  beforeEach(() => {
    handlers.clear()
    dir = mkdtempSync(join(tmpdir(), 'gg-run-wait-'))
    db = openDb(join(dir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('registers ai:wait and resolves final run status', async () => {
    const runs = createAgentRuns(db)
    registerAgentRunsIpc(runs, {} as never, { list: () => [] } as never, db, () => false, Date.now())
    runs.create({ runId: 'r1', projectPath: '/p', title: 'Done' })
    runs.finish('r1', 'done', { costCents: 12 })

    await expect(invoke('ai:wait', 'r1', { timeoutMs: 1 })).resolves.toMatchObject({
      runId: 'r1',
      status: 'completed',
      agentRunStatus: 'done',
      error: null,
    })
  })

  it('rejects through ipc on timeout', async () => {
    const runs = createAgentRuns(db)
    registerAgentRunsIpc(runs, {} as never, { list: () => [] } as never, db, () => false, Date.now())
    runs.create({ runId: 'r1', projectPath: '/p', title: 'Running' })

    await expect(invoke('ai:wait', 'r1', { timeoutMs: 0, pollMs: 10 })).rejects.toThrow('timeout')
  })
})
