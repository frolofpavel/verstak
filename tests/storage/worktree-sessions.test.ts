import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createWorktreeSessions } from '../../electron/storage/worktree-sessions'

describe('worktree-sessions lifecycle storage', () => {
  let dir: string
  let db: Database | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-wts-'))
  })

  afterEach(() => {
    db?.close()
    db = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  it('migration creates worktree_sessions with lifecycle metadata', () => {
    db = openDb(join(dir, 't.db'))
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name)
    expect(tables).toContain('worktree_sessions')

    const cols = (db.prepare('PRAGMA table_info(worktree_sessions)').all() as Array<{ name: string }>).map(c => c.name)
    expect(cols).toEqual(expect.arrayContaining([
      'snapshot_ref',
      'base_ref',
      'last_active_at',
      'removed_at',
    ]))
  })

  it('migration is safe on reopen', () => {
    const path = join(dir, 't.db')
    db = openDb(path)
    db.close()
    db = openDb(path)
    const version = (db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number }).version
    expect(version).toBeGreaterThanOrEqual(38)
  })

  it('create -> getActive/activePath returns active session with lifecycle defaults', () => {
    db = openDb(join(dir, 't.db'))
    const wts = createWorktreeSessions(db)
    const s = wts.create(5, '/p', '/tmp/wt-5')
    expect(s.state).toBe('active')
    expect(s.snapshotRef).toBeNull()
    expect(s.baseRef).toBeNull()
    expect(s.lastActiveAt).toBe(s.createdAt)
    expect(s.removedAt).toBeNull()
    expect(wts.getActive(5)?.worktreePath).toBe('/tmp/wt-5')
    expect(wts.activePath(5)).toBe('/tmp/wt-5')
    expect(wts.activePath(99)).toBeNull()
  })

  it('repeat create dismisses previous active session', () => {
    db = openDb(join(dir, 't.db'))
    const wts = createWorktreeSessions(db)
    wts.create(5, '/p', '/tmp/wt-old')
    wts.create(5, '/p', '/tmp/wt-new')
    expect(wts.activePath(5)).toBe('/tmp/wt-new')
    expect(wts.listActive('/p').length).toBe(1)
  })

  it('touch and setRefs update active lifecycle metadata', () => {
    db = openDb(join(dir, 't.db'))
    const wts = createWorktreeSessions(db)
    wts.create(5, '/p', '/tmp/wt')
    wts.touch(5, 12345)
    wts.setRefs(5, { snapshotRef: 'refs/verstak/snap', baseRef: 'HEAD' })
    const active = wts.getActive(5)
    expect(active?.lastActiveAt).toBe(12345)
    expect(active?.snapshotRef).toBe('refs/verstak/snap')
    expect(active?.baseRef).toBe('HEAD')
  })

  it('finish and markRemoved close lifecycle without deleting the row', () => {
    db = openDb(join(dir, 't.db'))
    const wts = createWorktreeSessions(db)
    wts.create(5, '/p', '/tmp/wt')
    wts.finish(5, 'merged')
    wts.markRemoved(5, '/tmp/wt', 67890)
    expect(wts.getActive(5)).toBeNull()
    expect(wts.activePath(5)).toBeNull()
    const row = db.prepare('SELECT state, removed_at as removedAt FROM worktree_sessions WHERE chat_id = ?').get(5) as { state: string; removedAt: number | null }
    expect(row.state).toBe('merged')
    expect(row.removedAt).toBe(67890)
  })

  it('listActive returns only active sessions for the project', () => {
    db = openDb(join(dir, 't.db'))
    const wts = createWorktreeSessions(db)
    wts.create(1, '/p', '/tmp/a')
    wts.create(2, '/p', '/tmp/b')
    wts.create(3, '/other', '/tmp/c')
    wts.finish(2, 'dismissed')
    const active = wts.listActive('/p')
    expect(active.map(s => s.chatId).sort()).toEqual([1])
  })
})
