import type { Database } from 'better-sqlite3'

export type ReminderTarget = 'notification' | 'chat'
export type ReminderStatus = 'pending' | 'delivered' | 'dismissed'

export interface Reminder {
  id: number
  projectPath: string
  title: string
  body: string | null
  dueAt: number
  target: ReminderTarget
  chatId: number | null
  status: ReminderStatus
  createdAt: number
  updatedAt: number
  deliveredAt: number | null
  dismissedAt: number | null
}

export interface ReminderInput {
  projectPath: string
  title: string
  body?: string | null
  dueAt: number
  target: ReminderTarget
  chatId?: number | null
}

interface Row {
  id: number
  projectPath: string
  title: string
  body: string | null
  dueAt: number
  target: ReminderTarget
  chatId: number | null
  status: ReminderStatus
  createdAt: number
  updatedAt: number
  deliveredAt: number | null
  dismissedAt: number | null
}

const SELECT = `
  SELECT id, project_path as projectPath, title, body, due_at as dueAt,
         target, chat_id as chatId, status, created_at as createdAt,
         updated_at as updatedAt, delivered_at as deliveredAt, dismissed_at as dismissedAt
  FROM reminders
`

export function ensureRemindersSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      due_at INTEGER NOT NULL,
      target TEXT NOT NULL CHECK(target IN ('notification','chat')),
      chat_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','dismissed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      delivered_at INTEGER,
      dismissed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_project ON reminders(project_path, due_at);
    CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders(status, due_at);
  `)
}

export function createReminders(db: Database) {
  ensureRemindersSchema(db)

  return {
    list(projectPath: string, limit = 200): Reminder[] {
      return db.prepare(`
        ${SELECT}
        WHERE project_path = ?
        ORDER BY
          CASE status WHEN 'pending' THEN 0 ELSE 1 END,
          due_at ASC
        LIMIT ?
      `).all(projectPath, limit) as Row[]
    },
    create(input: ReminderInput): Reminder {
      const now = Date.now()
      const info = db.prepare(`
        INSERT INTO reminders
          (project_path, title, body, due_at, target, chat_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        input.projectPath,
        input.title.trim(),
        input.body?.trim() || null,
        input.dueAt,
        input.target,
        input.target === 'chat' ? input.chatId ?? null : null,
        now,
        now
      )
      return this.get(Number(info.lastInsertRowid))!
    },
    get(id: number): Reminder | null {
      return (db.prepare(`${SELECT} WHERE id = ?`).get(id) as Row | undefined) ?? null
    },
    due(now = Date.now()): Reminder[] {
      return db.prepare(`
        ${SELECT}
        WHERE status = 'pending' AND due_at <= ?
        ORDER BY due_at ASC, id ASC
      `).all(now) as Row[]
    },
    nextPendingAfter(now = Date.now()): Reminder | null {
      return (db.prepare(`
        ${SELECT}
        WHERE status = 'pending' AND due_at > ?
        ORDER BY due_at ASC, id ASC
        LIMIT 1
      `).get(now) as Row | undefined) ?? null
    },
    snooze(id: number, dueAt: number): Reminder | null {
      db.prepare(`
        UPDATE reminders
        SET due_at = ?, status = 'pending', delivered_at = NULL, dismissed_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(dueAt, Date.now(), id)
      return this.get(id)
    },
    markDelivered(id: number): Reminder | null {
      const now = Date.now()
      db.prepare(`
        UPDATE reminders
        SET status = 'delivered', delivered_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now, now, id)
      return this.get(id)
    },
    dismiss(id: number): Reminder | null {
      const now = Date.now()
      db.prepare(`
        UPDATE reminders
        SET status = 'dismissed', dismissed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now, now, id)
      return this.get(id)
    },
    remove(id: number): void {
      db.prepare('DELETE FROM reminders WHERE id = ?').run(id)
    }
  }
}

export type Reminders = ReturnType<typeof createReminders>
