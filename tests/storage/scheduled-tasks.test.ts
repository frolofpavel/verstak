import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Database as DB } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import {
  createScheduledTask,
  getScheduledTask,
  getSchedulerHeartbeat,
  markScheduledTaskClaimed,
  recordScheduledRun,
  recordSchedulerHeartbeat,
} from '../../electron/storage/scheduled-tasks'

describe('scheduled tasks storage', () => {
  let dir: string
  let db: DB

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-scheduler-'))
    db = openDb(join(dir, 'test.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('migration exposes heartbeat and next-run fields', () => {
    const task = createScheduledTask(db, {
      projectPath: '/project',
      prompt: 'daily report',
      cron: '* * * * *',
      human: 'every minute',
    })

    expect(task.last_heartbeat_at).toBeNull()
    expect(task.next_run_at).toBeNull()
  })

  it('records scheduler heartbeat for visible liveness checks', () => {
    createScheduledTask(db, { projectPath: '/project', prompt: 'x', cron: '* * * * *', human: 'every minute' })
    expect(recordSchedulerHeartbeat(db, 1234)).toBe(1)
    expect(getSchedulerHeartbeat(db)).toBe(1234)
  })

  it('claims a run before execution and blocks a second claim in the same minute', () => {
    const task = createScheduledTask(db, { projectPath: '/project', prompt: 'x', cron: '* * * * *', human: 'every minute' })

    expect(markScheduledTaskClaimed(db, task.id, { minute: 10, at: 1000, nextRunAt: 660_000 })).toBe(true)
    expect(markScheduledTaskClaimed(db, task.id, { minute: 10, at: 1001, nextRunAt: 660_000 })).toBe(false)

    const claimed = getScheduledTask(db, task.id)!
    expect(claimed.last_run_minute).toBe(10)
    expect(claimed.last_heartbeat_at).toBe(1000)
    expect(claimed.next_run_at).toBe(660_000)
  })

  it('recordScheduledRun keeps next_run_at for legacy callers', () => {
    const task = createScheduledTask(db, { projectPath: '/project', prompt: 'x', cron: '* * * * *', human: 'every minute' })

    recordScheduledRun(db, task.id, { status: 'ok', summary: 'done', minute: 22, at: 2000 })

    const updated = getScheduledTask(db, task.id)!
    expect(updated.last_run_minute).toBe(22)
    expect(updated.next_run_at).toBe(23 * 60_000)
  })
})
