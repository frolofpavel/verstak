import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openDb } from '../../electron/storage/db'

describe('openDb', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates settings table on first open', () => {
    const db = openDb(join(dir, 'test.db'))
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get()
    expect(row).toEqual({ name: 'settings' })
    db.close()
  })

  it('creates chats table on first open', () => {
    const db = openDb(join(dir, 'test.db'))
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chats'").get()
    expect(row).toEqual({ name: 'chats' })
    db.close()
  })

  it('applies project_groups migration when schema is already past v13', () => {
    const dbPath = join(dir, 'stale-schema.db')
    const db = openDb(dbPath)
    db.exec('DROP TABLE IF EXISTS project_group_members')
    db.exec('DROP TABLE IF EXISTS project_groups')
    db.prepare('UPDATE schema_version SET version = 19 WHERE id = 1').run()
    db.close()

    const reopened = openDb(dbPath)
    const groups = reopened.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_groups'").get()
    const members = reopened.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_group_members'").get()
    const version = reopened.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number }
    expect(groups).toEqual({ name: 'project_groups' })
    expect(members).toEqual({ name: 'project_group_members' })
    expect(version.version).toBeGreaterThanOrEqual(23)
    const hiddenCol = (reopened.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>)
      .some(c => c.name === 'hidden')
    expect(hiddenCol).toBe(true)
    reopened.close()
  })
})
