import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'
import { createReminders } from '../../electron/storage/reminders'
import type { Database } from 'better-sqlite3'

describe('reminders storage', () => {
  let dir: string
  let db: Database | null = null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-reminders-'))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-21T10:00:00'))
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates, finds due, snoozes and dismisses reminders', () => {
    db = openDb(join(dir, 'test.db'))
    const reminders = createReminders(db)
    const reminder = reminders.create({
      projectPath: 'client-a',
      title: 'Позвонить клиенту',
      body: 'Обсудить правки',
      dueAt: Date.now() + 60_000,
      target: 'notification'
    })

    expect(reminders.due()).toHaveLength(0)
    vi.setSystemTime(new Date('2026-06-21T10:01:01'))
    expect(reminders.due()).toHaveLength(1)

    reminders.snooze(reminder.id, Date.now() + 10 * 60_000)
    expect(reminders.due()).toHaveLength(0)

    const dismissed = reminders.dismiss(reminder.id)
    expect(dismissed?.status).toBe('dismissed')
    expect(reminders.list('client-a')).toHaveLength(1)
  })

  it('repairs missing reminders table on databases already marked migrated', () => {
    db = openDb(join(dir, 'stale.db'))
    db.exec('DROP TABLE IF EXISTS reminders')
    db.prepare('UPDATE schema_version SET version = 24 WHERE id = 1').run()

    const reminders = createReminders(db)
    const created = reminders.create({
      projectPath: 'client-a',
      title: 'Follow up',
      dueAt: Date.now(),
      target: 'notification'
    })

    expect(created.id).toBeGreaterThan(0)
    expect(reminders.list('client-a')).toHaveLength(1)
  })
})
