import type { Database } from 'better-sqlite3'

export type Role = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: number
  role: Role
  content: string
  createdAt: number
}

export interface ChatSearchResult {
  session_id: number
  role: string
  content: string
  created_at: number
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

const MAX_CONTENT_SNIPPET = 500

/**
 * FTS5 full-text search across all chat messages for a given project.
 * Joins chats_fts → chats → chat_sessions so results are scoped to the project.
 * If query is empty — returns the last `limit` messages across all sessions.
 * Wraps FTS MATCH in try/catch: FTS5 throws on malformed queries (e.g. bare
 * special chars like "*" or "?").
 */
export function searchConversations(db: Database, projectPath: string, query: string, limit = 10): ChatSearchResult[] {
  const safeLimit = Math.max(1, Math.min(50, limit))

  if (!query.trim()) {
    // Empty query — return most recent messages for this project
    const rows = db.prepare(`
      SELECT c.session_id, c.role, c.content, c.created_at
      FROM chats c
      JOIN chat_sessions cs ON c.session_id = cs.id
      WHERE cs.project_path = ?
      ORDER BY c.created_at DESC
      LIMIT ?
    `).all(projectPath, safeLimit) as ChatSearchResult[]
    return rows.map(r => ({ ...r, content: r.content.slice(0, MAX_CONTENT_SNIPPET) }))
  }

  try {
    const rows = db.prepare(`
      SELECT c.session_id, c.role, c.content, c.created_at
      FROM chats c
      JOIN chats_fts ON c.rowid = chats_fts.rowid
      JOIN chat_sessions cs ON c.session_id = cs.id
      WHERE chats_fts MATCH ? AND cs.project_path = ?
      ORDER BY c.created_at DESC
      LIMIT ?
    `).all(query, projectPath, safeLimit) as ChatSearchResult[]
    return rows.map(r => ({ ...r, content: r.content.slice(0, MAX_CONTENT_SNIPPET) }))
  } catch {
    // FTS5 threw on the query (e.g. special chars) — fall back to LIKE search
    try {
      const likePattern = `%${query.replace(/[%_]/g, '\\$&')}%`
      const rows = db.prepare(`
        SELECT c.session_id, c.role, c.content, c.created_at
        FROM chats c
        JOIN chat_sessions cs ON c.session_id = cs.id
        WHERE c.content LIKE ? ESCAPE '\\' AND cs.project_path = ?
        ORDER BY c.created_at DESC
        LIMIT ?
      `).all(likePattern, projectPath, safeLimit) as ChatSearchResult[]
      return rows.map(r => ({ ...r, content: r.content.slice(0, MAX_CONTENT_SNIPPET) }))
    } catch {
      return []
    }
  }
}
