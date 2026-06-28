import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { createWorktreeSessions } from '../../electron/storage/worktree-sessions'

// #5 worktree-lifecycle: персистентная изоляция чата в git-worktree.
describe('worktree-sessions (migration 30)', () => {
  let dir: string
  let db: Database | undefined
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-wts-')) })
  afterEach(() => { db?.close(); db = undefined; rmSync(dir, { recursive: true, force: true }) })

  it('миграция 30 создаёт таблицу worktree_sessions', () => {
    db = openDb(join(dir, 't.db'))
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name)
    expect(tables).toContain('worktree_sessions')
  })

  it('create → getActive/activePath возвращают active-сеанс', () => {
    db = openDb(join(dir, 't.db'))
    const wts = createWorktreeSessions(db)
    const s = wts.create(5, '/p', '/tmp/wt-5')
    expect(s.state).toBe('active')
    expect(wts.getActive(5)?.worktreePath).toBe('/tmp/wt-5')
    expect(wts.activePath(5)).toBe('/tmp/wt-5')
    expect(wts.activePath(99)).toBeNull() // чужой чат
  })

  it('повторный create для чата гасит прежний active (один active на чат)', () => {
    db = openDb(join(dir, 't.db'))
    const wts = createWorktreeSessions(db)
    wts.create(5, '/p', '/tmp/wt-old')
    wts.create(5, '/p', '/tmp/wt-new')
    expect(wts.activePath(5)).toBe('/tmp/wt-new')
    expect(wts.listActive('/p').length).toBe(1) // только один active
  })

  it('finish(merged) → active больше нет', () => {
    db = openDb(join(dir, 't.db'))
    const wts = createWorktreeSessions(db)
    wts.create(5, '/p', '/tmp/wt')
    wts.finish(5, 'merged')
    expect(wts.getActive(5)).toBeNull()
    expect(wts.activePath(5)).toBeNull()
  })

  it('listActive — только активные сеансы проекта', () => {
    db = openDb(join(dir, 't.db'))
    const wts = createWorktreeSessions(db)
    wts.create(1, '/p', '/tmp/a')
    wts.create(2, '/p', '/tmp/b')
    wts.create(3, '/other', '/tmp/c')
    wts.finish(2, 'dismissed')
    const act = wts.listActive('/p')
    expect(act.map(s => s.chatId).sort()).toEqual([1]) // 2 dismissed, 3 другой проект
  })
})
