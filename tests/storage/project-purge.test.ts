import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../electron/storage/db'
import { purgeProjectAppData } from '../../electron/storage/project-purge'

describe('project-purge', () => {
  let dir: string
  let db: Database | undefined

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-purge-')) })
  afterEach(() => {
    db?.close()
    db = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  it('removes chats, sessions and settings for project', () => {
    db = openDb(join(dir, 't.db'))
    const path = 'C:\\clients\\demo'
    db.prepare('INSERT INTO chat_sessions (project_path, title, created_at, last_message_at) VALUES (?, ?, 1, 1)')
      .run(path, 'Main')
    const sid = db.prepare('SELECT id FROM chat_sessions WHERE project_path = ?').get(path) as { id: number }
    db.prepare('INSERT INTO chats (session_id, project_path, role, content, created_at) VALUES (?, ?, ?, ?, 1)')
      .run(sid.id, path, 'user', 'hi')
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(`system_prompt_${path}`, 'x')

    purgeProjectAppData(db, path)

    expect((db.prepare('SELECT COUNT(*) as c FROM chat_sessions WHERE project_path = ?').get(path) as { c: number }).c).toBe(0)
    expect((db.prepare('SELECT COUNT(*) as c FROM chats WHERE project_path = ?').get(path) as { c: number }).c).toBe(0)
    expect(db.prepare('SELECT value FROM settings WHERE key = ?').get(`system_prompt_${path}`)).toBeUndefined()
  })

  // 2.0.1 bug: осиротевшие scheduled_tasks/reminders вечно исполнялись против
  // удалённого проекта. Purge обязан их вычистить.
  it('removes scheduled_tasks and reminders for project', () => {
    db = openDb(join(dir, 't.db'))
    const path = 'C:\\clients\\demo'
    db.prepare('INSERT INTO scheduled_tasks (project_path, created_at, cron, prompt, enabled) VALUES (?, 1, ?, ?, 1)')
      .run(path, '0 9 * * *', 'проверь заказы')
    db.prepare('INSERT INTO reminders (project_path, title, body, due_at, target, status, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, 1, 1)')
      .run(path, 'напоминание', 'текст', 'notification', 'pending')

    purgeProjectAppData(db, path)

    expect((db.prepare('SELECT COUNT(*) as c FROM scheduled_tasks WHERE project_path = ?').get(path) as { c: number }).c).toBe(0)
    expect((db.prepare('SELECT COUNT(*) as c FROM reminders WHERE project_path = ?').get(path) as { c: number }).c).toBe(0)
  })

  it('deleteProjectDirectory removes folder', async () => {
    const { deleteProjectDirectory } = await import('../../electron/storage/project-purge')
    const folder = join(dir, 'client-a')
    mkdirSync(folder)
    deleteProjectDirectory(folder)
    expect(existsSync(folder)).toBe(false)
  })
})