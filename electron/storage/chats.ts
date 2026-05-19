import type { Database } from 'better-sqlite3'

export type Role = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: number
  role: Role
  content: string
  createdAt: number
}

export interface Chats {
  /** List messages — new API: by sessionId. */
  listBySession: (sessionId: number) => ChatMessage[]
  /** Legacy: list all messages of a project (across sessions) — left for back-compat callers. */
  list: (projectPath: string) => ChatMessage[]
  /** Append a message to a specific session. */
  appendToSession: (sessionId: number, projectPath: string, role: Role, content: string) => void
}

export function createChats(db: Database): Chats {
  const touchSession = db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?')
  return {
    listBySession(sessionId) {
      return db.prepare(
        'SELECT id, role, content, created_at as createdAt FROM chats WHERE session_id = ? ORDER BY id ASC'
      ).all(sessionId) as ChatMessage[]
    },
    list(projectPath) {
      return db.prepare(
        'SELECT id, role, content, created_at as createdAt FROM chats WHERE project_path = ? ORDER BY id ASC'
      ).all(projectPath) as ChatMessage[]
    },
    appendToSession(sessionId, projectPath, role, content) {
      const now = Date.now()
      db.prepare(
        'INSERT INTO chats (session_id, project_path, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(sessionId, projectPath, role, content, now)
      touchSession.run(now, sessionId)
    }
  }
}
