import type { Database } from 'better-sqlite3'

export interface ChatSession {
  id: number
  projectPath: string
  title: string
  providerId: string | null
  model: string | null
  createdAt: number
  lastMessageAt: number
}

export interface ChatSessions {
  list: (projectPath: string) => ChatSession[]
  get: (id: number) => ChatSession | null
  create: (projectPath: string, opts?: { title?: string; providerId?: string | null; model?: string | null }) => ChatSession
  rename: (id: number, title: string) => void
  touch: (id: number) => void
  setProviderModel: (id: number, providerId: string | null, model: string | null) => void
  remove: (id: number) => void
}

interface Row {
  id: number
  projectPath: string
  title: string
  providerId: string | null
  model: string | null
  createdAt: number
  lastMessageAt: number
}

const SELECT = `
  SELECT id, project_path as projectPath, title, provider_id as providerId, model,
         created_at as createdAt, last_message_at as lastMessageAt
  FROM chat_sessions
`

export function createChatSessions(db: Database): ChatSessions {
  return {
    list(projectPath) {
      return db.prepare(`${SELECT} WHERE project_path = ? ORDER BY last_message_at DESC`).all(projectPath) as Row[]
    },
    get(id) {
      const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as Row | undefined
      return row ?? null
    },
    create(projectPath, opts = {}) {
      const now = Date.now()
      const title = opts.title ?? 'Новый чат'
      const info = db.prepare(
        'INSERT INTO chat_sessions (project_path, title, provider_id, model, created_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectPath, title, opts.providerId ?? null, opts.model ?? null, now, now)
      return {
        id: Number(info.lastInsertRowid),
        projectPath, title,
        providerId: opts.providerId ?? null,
        model: opts.model ?? null,
        createdAt: now, lastMessageAt: now
      }
    },
    rename(id, title) {
      db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(title, id)
    },
    touch(id) {
      db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(Date.now(), id)
    },
    setProviderModel(id, providerId, model) {
      db.prepare('UPDATE chat_sessions SET provider_id = ?, model = ? WHERE id = ?').run(providerId, model, id)
    },
    remove(id) {
      // Cascade: delete messages of this session too
      db.prepare('DELETE FROM chats WHERE session_id = ?').run(id)
      db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id)
    }
  }
}
