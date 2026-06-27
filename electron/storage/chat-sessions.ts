import type { Database } from 'better-sqlite3'
import { HELP_PROJECT_PATH } from './help-scope'

/**
 * `kind` распределяет чаты на две группы:
 *  - 'main'   — обычные чаты пользователя, показываются в Sidebar
 *  - 'review' — sub-чаты ревьюера, спрятаны от Sidebar, висят как pill в
 *               Timeline родительского чата через parentChatId.
 *  - 'subagent' — персистентные суб-сессии делегированных агентов (Фаза 2).
 *               Тоже спрятаны от Sidebar, привязаны к main-чату через
 *               parentChatId. Метаданные суба — в sub-sessions.ts.
 */
export type ChatKind = 'main' | 'review' | 'subagent' | 'help'

export interface ChatSession {
  id: number
  projectPath: string
  title: string
  providerId: string | null
  model: string | null
  createdAt: number
  lastMessageAt: number
  kind: ChatKind
  parentChatId: number | null
}

export interface ChatSessions {
  /** Только main-чаты — для рендера в Sidebar. */
  list: (projectPath: string) => ChatSession[]
  /** Единый глобальный чат справки — скрыт из Sidebar. */
  getOrCreateHelp: () => ChatSession
  /** Все review-чаты, относящиеся к одному родителю. */
  listReviews: (parentChatId: number) => ChatSession[]
  get: (id: number) => ChatSession | null
  create: (projectPath: string, opts?: {
    title?: string
    providerId?: string | null
    model?: string | null
    kind?: ChatKind
    parentChatId?: number | null
  }) => ChatSession
  rename: (id: number, title: string) => void
  touch: (id: number) => void
  setProviderModel: (id: number, providerId: string | null, model: string | null) => void
  remove: (id: number) => void
  /** Tier-2 #3 — ветвление: новая main-сессия с копией сообщений источника до
   *  uptoMessageId (включительно; без него — вся история). parentChatId = источник
   *  → дерево веток. Исследовать альтернативный путь из точки, не теряя оригинал. */
  fork: (sourceId: number, opts?: { uptoMessageId?: number; title?: string }) => ChatSession | null
}

interface Row {
  id: number
  projectPath: string
  title: string
  providerId: string | null
  model: string | null
  createdAt: number
  lastMessageAt: number
  kind: ChatKind
  parentChatId: number | null
}

const SELECT = `
  SELECT id, project_path as projectPath, title, provider_id as providerId, model,
         created_at as createdAt, last_message_at as lastMessageAt,
         kind, parent_chat_id as parentChatId
  FROM chat_sessions
`

export function createChatSessions(db: Database): ChatSessions {
  const sessions: ChatSessions = {
    list(projectPath) {
      // Sidebar показывает ТОЛЬКО main-чаты. Review-чаты вытаскиваются
      // отдельно через listReviews() когда нужно показать pills в Timeline.
      return db.prepare(
        `${SELECT} WHERE project_path = ? AND kind = 'main' ORDER BY last_message_at DESC`
      ).all(projectPath) as Row[]
    },
    listReviews(parentChatId) {
      return db.prepare(
        `${SELECT} WHERE parent_chat_id = ? AND kind = 'review' ORDER BY created_at ASC`
      ).all(parentChatId) as Row[]
    },
    getOrCreateHelp() {
      const existing = db.prepare(
        `${SELECT} WHERE project_path = ? AND kind = 'help' LIMIT 1`
      ).get(HELP_PROJECT_PATH) as Row | undefined
      if (existing) return existing
      return sessions.create(HELP_PROJECT_PATH, { title: 'Справка Verstak', kind: 'help' })
    },
    get(id) {
      const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as Row | undefined
      return row ?? null
    },
    create(projectPath, opts = {}) {
      const now = Date.now()
      const title = opts.title ?? 'Новый чат'
      const kind: ChatKind = opts.kind ?? 'main'
      const parentChatId = opts.parentChatId ?? null
      const info = db.prepare(
        `INSERT INTO chat_sessions
          (project_path, title, provider_id, model, created_at, last_message_at, kind, parent_chat_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(projectPath, title, opts.providerId ?? null, opts.model ?? null, now, now, kind, parentChatId)
      return {
        id: Number(info.lastInsertRowid),
        projectPath, title,
        providerId: opts.providerId ?? null,
        model: opts.model ?? null,
        createdAt: now, lastMessageAt: now,
        kind, parentChatId
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
      // Cascade: review sub-chats этого main-чата + сообщения всех затронутых
      // сессий. Делаем в одной транзакции чтобы не оставить осиротевших.
      const tx = db.transaction(() => {
        const subIds = (db.prepare(
          'SELECT id FROM chat_sessions WHERE parent_chat_id = ?'
        ).all(id) as Array<{ id: number }>).map(r => r.id)
        const allIds = [id, ...subIds]
        const placeholders = allIds.map(() => '?').join(',')
        db.prepare(`DELETE FROM chats WHERE session_id IN (${placeholders})`).run(...allIds)
        db.prepare(`DELETE FROM chat_sessions WHERE id IN (${placeholders})`).run(...allIds)
      })
      tx()
    },
    fork(sourceId, opts = {}) {
      const source = sessions.get(sourceId)
      if (!source) return null
      const branch = sessions.create(source.projectPath, {
        title: opts.title ?? `${source.title} ⑂`,
        providerId: source.providerId,
        model: source.model,
        kind: 'main',
        parentChatId: sourceId,
      })
      const upto = opts.uptoMessageId
      const tx = db.transaction(() => {
        const rows = (upto != null
          ? db.prepare('SELECT role, content, created_at FROM chats WHERE session_id = ? AND id <= ? ORDER BY id ASC').all(sourceId, upto)
          : db.prepare('SELECT role, content, created_at FROM chats WHERE session_id = ? ORDER BY id ASC').all(sourceId)
        ) as Array<{ role: string; content: string; created_at: number }>
        const ins = db.prepare('INSERT INTO chats (session_id, project_path, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        for (const r of rows) ins.run(branch.id, source.projectPath, r.role, r.content, r.created_at)
      })
      tx()
      return branch
    }
  }
  return sessions
}
