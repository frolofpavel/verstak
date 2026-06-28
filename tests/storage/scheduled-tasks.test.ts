import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Database as DB } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import {
  createScheduledTask, getScheduledTask, listScheduledTasks, listEnabledScheduledTasks,
  setScheduledTaskEnabled, deleteScheduledTask, recordScheduledRun,
} from '../../electron/storage/scheduled-tasks'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('scheduled-tasks storage', () => {
  let dir: string
  let db: DB
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'verstak-sched-')); db = openDb(join(dir, 'test.db')) })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  const PROJ = '/home/user/proj'

  it('create → get с дефолтами (enabled, null-поля прогона)', () => {
    const t = createScheduledTask(db, { projectPath: PROJ, prompt: 'аудит Ozon', cron: '0 9 * * *', human: 'каждое утро' })
    expect(t.id).toBeGreaterThan(0)
    expect(t.enabled).toBe(true)
    expect(t.cron).toBe('0 9 * * *')
    expect(t.last_run_at).toBeNull()
    expect(getScheduledTask(db, t.id)?.prompt).toBe('аудит Ozon')
  })

  it('list по проекту + listEnabled фильтрует выключенные', () => {
    const a = createScheduledTask(db, { projectPath: PROJ, prompt: 'a', cron: '0 9 * * *', human: '' })
    createScheduledTask(db, { projectPath: PROJ, prompt: 'b', cron: '0 21 * * *', human: '' })
    createScheduledTask(db, { projectPath: '/other', prompt: 'c', cron: '0 9 * * *', human: '' })
    expect(listScheduledTasks(db, PROJ)).toHaveLength(2)
    expect(listScheduledTasks(db)).toHaveLength(3)
    setScheduledTaskEnabled(db, a.id, false)
    expect(listEnabledScheduledTasks(db)).toHaveLength(2) // b (PROJ) + c (/other)
  })

  it('recordScheduledRun сохраняет статус/итог/минуту', () => {
    const t = createScheduledTask(db, { projectPath: PROJ, prompt: 'x', cron: '0 9 * * *', human: '' })
    recordScheduledRun(db, t.id, { status: 'ok', summary: 'готово', minute: 12345, at: 1000 })
    const got = getScheduledTask(db, t.id)!
    expect(got.last_status).toBe('ok')
    expect(got.last_result).toBe('готово')
    expect(got.last_run_minute).toBe(12345)
    expect(got.last_run_at).toBe(1000)
  })

  it('delete удаляет', () => {
    const t = createScheduledTask(db, { projectPath: PROJ, prompt: 'x', cron: '0 9 * * *', human: '' })
    expect(deleteScheduledTask(db, t.id)).toBe(true)
    expect(getScheduledTask(db, t.id)).toBeNull()
    expect(deleteScheduledTask(db, 99999)).toBe(false)
  })
})
