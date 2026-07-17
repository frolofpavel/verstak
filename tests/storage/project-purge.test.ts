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
    // project_brain — активный вред: оставшись, воскрешал старый «мозг» при повторном
    // добавлении проекта по тому же пути (UNIQUE project_path + ON CONFLICT DO NOTHING).
    db.prepare('INSERT INTO project_brain (project_path, version, created_at, updated_at) VALUES (?, 1, 1, 1)').run(path)
    // agent_run_checkpoints — сирота по run_id (нет project_path), хранит messages_json
    // (полную историю диалога прерванного прогона). Ре-ревью 2.
    db.prepare('INSERT INTO agent_runs (run_id, project_path, title, started_at) VALUES (?, ?, ?, 1)').run('r-1', path, 'run')
    db.prepare('INSERT INTO agent_run_checkpoints (run_id, turn_index, messages_json, created_at) VALUES (?, 1, ?, 1)').run('r-1', '[{"role":"user","content":"секретная переписка"}]')

    purgeProjectAppData(db, path)

    expect((db.prepare('SELECT COUNT(*) as c FROM scheduled_tasks WHERE project_path = ?').get(path) as { c: number }).c).toBe(0)
    expect((db.prepare('SELECT COUNT(*) as c FROM reminders WHERE project_path = ?').get(path) as { c: number }).c).toBe(0)
    expect((db.prepare('SELECT COUNT(*) as c FROM project_brain WHERE project_path = ?').get(path) as { c: number }).c).toBe(0)
    expect((db.prepare('SELECT COUNT(*) as c FROM agent_runs WHERE project_path = ?').get(path) as { c: number }).c).toBe(0)
    expect((db.prepare("SELECT COUNT(*) as c FROM agent_run_checkpoints WHERE run_id = 'r-1'").get() as { c: number }).c).toBe(0)
  })

  it('deleteProjectDirectory removes folder', async () => {
    const { deleteProjectDirectory } = await import('../../electron/storage/project-purge')
    const folder = join(dir, 'client-a')
    mkdirSync(folder)
    deleteProjectDirectory(folder)
    expect(existsSync(folder)).toBe(false)
  })

  /**
   * Ре-ревью 2.0.11-B, находка #10. Сжатый итог — контент-несущая таблица: в нём лежит
   * пересказ переписки. «Удалить данные проекта» обязано унести и его, иначе человек
   * удалил проект, а содержимое его разговоров осталось в базе. Тот же класс, что уже
   * ловили в project_brain/context_pack (см. комментарий в project-purge).
   */
  it('удаляет сжатые итоги чатов проекта (в них пересказ переписки)', () => {
    db = openDb(join(dir, 't.db'))
    const path = 'C:\\clients\\demo'
    db.prepare('INSERT INTO chat_sessions (project_path, title, created_at, last_message_at) VALUES (?, ?, 1, 1)')
      .run(path, 'Main')
    const sid = (db.prepare('SELECT id FROM chat_sessions WHERE project_path = ?').get(path) as { id: number }).id
    db.prepare(
      `INSERT INTO chat_context_snapshots (chat_id, summary, through_message_id, source_max_message_id, created_at)
       VALUES (?, ?, 1, 1, 1)`
    ).run(sid, 'пересказ приватного разговора с клиентом')

    purgeProjectAppData(db, path)

    const left = db.prepare('SELECT COUNT(*) as c FROM chat_context_snapshots').get() as { c: number }
    expect(left.c).toBe(0)
  })

  it('не трогает сжатые итоги ДРУГОГО проекта', () => {
    db = openDb(join(dir, 't.db'))
    const mine = 'C:\\clients\\demo'
    const other = 'C:\\clients\\keep'
    for (const p of [mine, other]) {
      db.prepare('INSERT INTO chat_sessions (project_path, title, created_at, last_message_at) VALUES (?, ?, 1, 1)').run(p, 'Main')
    }
    const otherSid = (db.prepare('SELECT id FROM chat_sessions WHERE project_path = ?').get(other) as { id: number }).id
    db.prepare(
      `INSERT INTO chat_context_snapshots (chat_id, summary, through_message_id, source_max_message_id, created_at)
       VALUES (?, ?, 1, 1, 1)`
    ).run(otherSid, 'итог соседнего проекта')

    purgeProjectAppData(db, mine)

    const left = db.prepare('SELECT COUNT(*) as c FROM chat_context_snapshots').get() as { c: number }
    expect(left.c).toBe(1)
  })
})