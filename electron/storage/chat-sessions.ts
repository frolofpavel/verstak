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
  /** 2.0.8-B: привязка к подписочному аккаунту. accountId=null + mode='auto' →
   *  автовыбор активного; 'pinned' → жёстко закреплён (per-chat, не глобальный флаг). */
  subscriptionAccountId: number | null
  subscriptionMode: 'auto' | 'pinned'
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
  /** 2.0.8-B: привязка чата к подписочному аккаунту (get). null — чат не найден. */
  getSubscriptionBinding: (id: number) => { accountId: number | null; mode: 'auto' | 'pinned' } | null
  /** 2.0.8-B: задать привязку. pinned без accountId нормализуется в auto. */
  setSubscriptionBinding: (id: number, mode: 'auto' | 'pinned', accountId: number | null) => void
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
  subscriptionAccountId: number | null
  subscriptionMode: 'auto' | 'pinned'
}

const SELECT = `
  SELECT id, project_path as projectPath, title, provider_id as providerId, model,
         created_at as createdAt, last_message_at as lastMessageAt,
         kind, parent_chat_id as parentChatId,
         subscription_account_id as subscriptionAccountId, subscription_mode as subscriptionMode
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
        kind, parentChatId,
        subscriptionAccountId: null,
        subscriptionMode: 'auto',
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
      const tx = db.transaction(() => {
        // Каскад: РЕКУРСИВНО всё поддерево СКРЫТЫХ суб-чатов (review/subagent/help) —
        // иначе review на под-чате осиротевал бы (leak + мусор в поиске). Форк-ВЕТКИ
        // (kind='main') — самостоятельные чаты пользователя, их НЕ удаляем (data loss).
        const subIds = (db.prepare(`
          WITH RECURSIVE sub(sid) AS (
            SELECT id FROM chat_sessions WHERE parent_chat_id = ? AND kind != 'main'
            UNION
            SELECT cs.id FROM chat_sessions cs JOIN sub ON cs.parent_chat_id = sub.sid AND cs.kind != 'main'
          )
          SELECT sid FROM sub
        `).all(id) as Array<{ sid: number }>).map(r => r.sid)
        const allIds = [id, ...subIds]
        const placeholders = allIds.map(() => '?').join(',')
        db.prepare(`DELETE FROM chats WHERE session_id IN (${placeholders})`).run(...allIds)
        db.prepare(`DELETE FROM chat_sessions WHERE id IN (${placeholders})`).run(...allIds)
        // Форк-ветки, висевшие на удалённом чате, отвязываем в корень — их работа цела.
        db.prepare("UPDATE chat_sessions SET parent_chat_id = NULL WHERE parent_chat_id = ? AND kind = 'main'").run(id)
      })
      tx()
    },
    fork(sourceId, opts = {}) {
      const source = sessions.get(sourceId)
      if (!source) return null
      const upto = opts.uptoMessageId
      const now = Date.now()
      const title = opts.title ?? `${source.title} ⑂`
      // Атомарно: создание ветки + копия истории в ОДНОЙ транзакции — иначе при сбое
      // копирования осталась бы пустая осиротевшая сессия (инвариант как у remove).
      let branchId = 0
      const tx = db.transaction(() => {
        // 2.0.8-B: ветка НАСЛЕДУЕТ subscription-binding источника (карточка шаг 6).
        const info = db.prepare(
          `INSERT INTO chat_sessions (project_path, title, provider_id, model, created_at, last_message_at, kind, parent_chat_id, subscription_account_id, subscription_mode)
           VALUES (?, ?, ?, ?, ?, ?, 'main', ?, ?, ?)`
        ).run(source.projectPath, title, source.providerId, source.model, now, now, sourceId, source.subscriptionAccountId, source.subscriptionMode)
        branchId = Number(info.lastInsertRowid)
        const rows = (upto != null
          ? db.prepare('SELECT role, content, created_at FROM chats WHERE session_id = ? AND id <= ? ORDER BY id ASC').all(sourceId, upto)
          : db.prepare('SELECT role, content, created_at FROM chats WHERE session_id = ? ORDER BY id ASC').all(sourceId)
        ) as Array<{ role: string; content: string; created_at: number }>
        const ins = db.prepare('INSERT INTO chats (session_id, project_path, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        for (const r of rows) ins.run(branchId, source.projectPath, r.role, r.content, r.created_at)
      })
      tx()
      return {
        id: branchId,
        projectPath: source.projectPath,
        title,
        providerId: source.providerId,
        model: source.model,
        createdAt: now, lastMessageAt: now,
        kind: 'main', parentChatId: sourceId,
        subscriptionAccountId: source.subscriptionAccountId,
        subscriptionMode: source.subscriptionMode,
      }
    },
    getSubscriptionBinding(id) {
      const row = db.prepare(
        'SELECT subscription_account_id as accountId, subscription_mode as mode FROM chat_sessions WHERE id = ?'
      ).get(id) as { accountId: number | null; mode: 'auto' | 'pinned' } | undefined
      if (!row) return null
      return { accountId: row.accountId, mode: row.mode }
    },
    setSubscriptionBinding(id, mode, accountId) {
      // pinned без accountId бессмыслен → нормализуем в auto (не оставляем висячий pin).
      const effectiveMode = mode === 'pinned' && accountId != null ? 'pinned' : 'auto'
      const effectiveAccount = effectiveMode === 'pinned' ? accountId : null
      db.prepare('UPDATE chat_sessions SET subscription_account_id = ?, subscription_mode = ? WHERE id = ?')
        .run(effectiveAccount, effectiveMode, id)
    },
  }
  return sessions
}
