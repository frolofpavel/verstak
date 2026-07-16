import type { Database } from 'better-sqlite3'

export type Role = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: number
  role: Role
  content: string
  thinking: string
  appliedSkills: AppliedSkillRef[]
  createdAt: number
}

export interface AppliedSkillRef {
  id: string
  name?: string
  icon?: string
  description?: string
}

export interface ChatSearchResult {
  session_id: number
  role: string
  content: string
  created_at: number
}

type ChatMessageRow = Omit<ChatMessage, 'appliedSkills'> & {
  appliedSkillsJson?: string
}

export interface Chats {
  /** List messages — new API: by sessionId. */
  listBySession: (sessionId: number) => ChatMessage[]
  listWindowBySession: (sessionId: number, opts?: { beforeId?: number | null; limit?: number }) => { messages: ChatMessage[]; totalCount: number; hasMoreBefore: boolean }
  /** Legacy: list all messages of a project (across sessions) — left for back-compat callers. */
  list: (projectPath: string) => ChatMessage[]
  /** Append a message to a specific session. */
  appendToSession: (sessionId: number, projectPath: string, role: Role, content: string, meta?: { appliedSkills?: AppliedSkillRef[] }) => ChatMessage
  /** Update an existing message body. Used for streaming assistant persistence. */
  updateMessage: (messageId: number, content: string) => boolean
  /** Update an existing message thinking stream. Used for crash-resume context. */
  updateThinking: (messageId: number, thinking: string) => boolean
  /** Макс. id сообщения сессии (граница для «Откатить задачу»). 0 если сессия пуста. */
  maxMessageId: (sessionId: number) => number
  /** Удалить сообщения сессии с id > afterMessageId (truncate диалога к чекпоинту).
   *  FTS чистится триггером chats_fts_ad. Возвращает число удалённых. */
  truncateAfter: (sessionId: number, afterMessageId: number) => number
}

export function createChats(db: Database): Chats {
  const touchSession = db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?')
  const chatColumns = (db.prepare('PRAGMA table_info(chats)').all() as Array<{ name: string }>).map(c => c.name)
  const hasThinkingColumn = chatColumns.includes('thinking')
  const hasAppliedSkillsColumn = chatColumns.includes('applied_skills')
  const thinkingSelect = hasThinkingColumn ? "COALESCE(thinking, '')" : "''"
  const appliedSkillsSelect = hasAppliedSkillsColumn ? "COALESCE(applied_skills, '[]')" : "'[]'"

  function parseAppliedSkills(raw: unknown): AppliedSkillRef[] {
    if (typeof raw !== 'string' || !raw.trim()) return []
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.flatMap((item): AppliedSkillRef[] => {
        if (!item || typeof item !== 'object') return []
        const src = item as Record<string, unknown>
        const id = typeof src.id === 'string' ? src.id.trim() : ''
        if (!id) return []
        return [{
          id,
          ...(typeof src.name === 'string' && src.name.trim() ? { name: src.name } : {}),
          ...(typeof src.icon === 'string' && src.icon.trim() ? { icon: src.icon } : {}),
          ...(typeof src.description === 'string' && src.description.trim() ? { description: src.description } : {}),
        }]
      })
    } catch {
      return []
    }
  }

  function stringifyAppliedSkills(skills: AppliedSkillRef[] | undefined): string {
    if (!skills?.length) return '[]'
    const clean = skills.flatMap((skill): AppliedSkillRef[] => {
      const id = skill.id?.trim()
      if (!id) return []
      return [{
        id,
        ...(skill.name?.trim() ? { name: skill.name.trim() } : {}),
        ...(skill.icon?.trim() ? { icon: skill.icon.trim() } : {}),
        ...(skill.description?.trim() ? { description: skill.description.trim() } : {}),
      }]
    })
    return JSON.stringify(clean)
  }

  function mapMessage(row: ChatMessageRow): ChatMessage {
    return {
      id: row.id,
      role: row.role,
      content: row.content,
      thinking: row.thinking,
      appliedSkills: parseAppliedSkills(row.appliedSkillsJson),
      createdAt: row.createdAt
    }
  }

  return {
    listBySession(sessionId) {
      const rows = db.prepare(
        `SELECT id, role, content, ${thinkingSelect} as thinking, ${appliedSkillsSelect} as appliedSkillsJson, created_at as createdAt FROM chats WHERE session_id = ? ORDER BY id ASC`
      ).all(sessionId) as ChatMessageRow[]
      return rows.map(mapMessage)
    },
    listWindowBySession(sessionId, opts) {
      const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? 50)))
      const beforeId = typeof opts?.beforeId === 'number' && Number.isFinite(opts.beforeId) ? Math.floor(opts.beforeId) : null
      const totalRow = db.prepare('SELECT COUNT(*) as count FROM chats WHERE session_id = ?').get(sessionId) as { count: number }
      const rows = beforeId != null
        ? db.prepare(
          `SELECT id, role, content, ${thinkingSelect} as thinking, ${appliedSkillsSelect} as appliedSkillsJson, created_at as createdAt FROM chats WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?`
        ).all(sessionId, beforeId, limit) as ChatMessageRow[]
        : db.prepare(
          `SELECT id, role, content, ${thinkingSelect} as thinking, ${appliedSkillsSelect} as appliedSkillsJson, created_at as createdAt FROM chats WHERE session_id = ? ORDER BY id DESC LIMIT ?`
        ).all(sessionId, limit) as ChatMessageRow[]
      const messages = rows.reverse().map(mapMessage)
      const firstId = messages[0]?.id ?? beforeId ?? 0
      const olderRow = firstId > 0
        ? db.prepare('SELECT COUNT(*) as count FROM chats WHERE session_id = ? AND id < ?').get(sessionId, firstId) as { count: number }
        : { count: 0 }
      return { messages, totalCount: totalRow.count, hasMoreBefore: olderRow.count > 0 }
    },
    list(projectPath) {
      const rows = db.prepare(
        `SELECT id, role, content, ${thinkingSelect} as thinking, ${appliedSkillsSelect} as appliedSkillsJson, created_at as createdAt FROM chats WHERE project_path = ? ORDER BY id ASC`
      ).all(projectPath) as ChatMessageRow[]
      return rows.map(mapMessage)
    },
    appendToSession(sessionId, projectPath, role, content, meta) {
      // 5.2 (review P0): один финальный assistant-ответ может прийти в append
      // дважды (active-чат Chat.tsx + snapshot-путь applyEventToChat) — голый
      // INSERT плодил дубль. Дедупим ПОВТОР того же assistant-сообщения, если
      // последнее сообщение сессии идентично. User не трогаем — там нет
      // двойного персиста, а намеренный повтор пользователя терять нельзя.
      if (role === 'assistant') {
        const last = db.prepare(
          `SELECT id, role, content, ${thinkingSelect} as thinking, ${appliedSkillsSelect} as appliedSkillsJson, created_at as createdAt FROM chats WHERE session_id = ? ORDER BY id DESC LIMIT 1`
        ).get(sessionId) as ChatMessageRow | undefined
        if (last && last.role === 'assistant' && last.content === content) {
          return mapMessage(last)
        }
      }
      const now = Date.now()
      const appliedSkills = stringifyAppliedSkills(meta?.appliedSkills)
      const info = hasAppliedSkillsColumn
        ? db.prepare(
          'INSERT INTO chats (session_id, project_path, role, content, applied_skills, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(sessionId, projectPath, role, content, appliedSkills, now)
        : db.prepare(
          'INSERT INTO chats (session_id, project_path, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(sessionId, projectPath, role, content, now)
      touchSession.run(now, sessionId)
      return {
        id: Number(info.lastInsertRowid),
        role,
        content,
        thinking: '',
        appliedSkills: parseAppliedSkills(appliedSkills),
        createdAt: now
      }
    },
    updateMessage(messageId, content) {
      const now = Date.now()
      const info = db.prepare('UPDATE chats SET content = ? WHERE id = ?').run(content, messageId)
      const row = db.prepare('SELECT session_id as sessionId FROM chats WHERE id = ?').get(messageId) as { sessionId: number } | undefined
      if (row?.sessionId) touchSession.run(now, row.sessionId)
      return info.changes > 0
    },
    updateThinking(messageId, thinking) {
      if (!hasThinkingColumn) return false
      const now = Date.now()
      const info = db.prepare('UPDATE chats SET thinking = ? WHERE id = ?').run(thinking, messageId)
      const row = db.prepare('SELECT session_id as sessionId FROM chats WHERE id = ?').get(messageId) as { sessionId: number } | undefined
      if (row?.sessionId) touchSession.run(now, row.sessionId)
      return info.changes > 0
    },
    maxMessageId(sessionId) {
      const row = db.prepare('SELECT COALESCE(MAX(id), 0) as maxId FROM chats WHERE session_id = ?').get(sessionId) as { maxId: number }
      return row.maxId
    },
    truncateAfter(sessionId, afterMessageId) {
      return db.prepare('DELETE FROM chats WHERE session_id = ? AND id > ?').run(sessionId, afterMessageId).changes
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
