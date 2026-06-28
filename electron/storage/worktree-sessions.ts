import type { Database } from 'better-sqlite3'

/**
 * #5 worktree-lifecycle: персистентная изоляция чата в git-worktree. Один активный
 * worktree на чат (chat_id). Агентные прогоны изолированного чата пишут в worktree,
 * не в main; пользователь применяет накопленные изменения в main (локальный merge,
 * БЕЗ push) или отбрасывает. Состояния: active → merged / dismissed.
 */
export type WorktreeState = 'active' | 'merged' | 'dismissed'

export interface WorktreeSession {
  chatId: number
  projectPath: string
  worktreePath: string
  state: WorktreeState
  createdAt: number
  endedAt: number | null
}

export interface WorktreeSessions {
  /** Создать активный worktree-сеанс для чата (если уже есть active — заменяет). */
  create: (chatId: number, projectPath: string, worktreePath: string) => WorktreeSession
  /** Активный worktree чата или null. */
  getActive: (chatId: number) => WorktreeSession | null
  /** Путь активного worktree чата (для ре-рута file-тулзов) или null. */
  activePath: (chatId: number) => string | null
  /** Перевести активный сеанс чата в merged/dismissed (+ ended_at). */
  finish: (chatId: number, state: 'merged' | 'dismissed') => void
  /** Активные worktree-сеансы проекта (для индикации/очистки). */
  listActive: (projectPath: string) => WorktreeSession[]
}

const SELECT = `
  SELECT chat_id as chatId, project_path as projectPath, worktree_path as worktreePath,
         state, created_at as createdAt, ended_at as endedAt
  FROM worktree_sessions
`

export function createWorktreeSessions(db: Database): WorktreeSessions {
  return {
    create(chatId, projectPath, worktreePath) {
      const now = Date.now()
      // Один active на чат: гасим прежний active (dismissed) перед вставкой.
      db.prepare("UPDATE worktree_sessions SET state = 'dismissed', ended_at = ? WHERE chat_id = ? AND state = 'active'").run(now, chatId)
      db.prepare(
        `INSERT INTO worktree_sessions (chat_id, project_path, worktree_path, state, created_at, ended_at)
         VALUES (?, ?, ?, 'active', ?, NULL)`
      ).run(chatId, projectPath, worktreePath, now)
      return { chatId, projectPath, worktreePath, state: 'active', createdAt: now, endedAt: null }
    },
    getActive(chatId) {
      const row = db.prepare(`${SELECT} WHERE chat_id = ? AND state = 'active' ORDER BY created_at DESC LIMIT 1`).get(chatId) as WorktreeSession | undefined
      return row ?? null
    },
    activePath(chatId) {
      const row = db.prepare("SELECT worktree_path as p FROM worktree_sessions WHERE chat_id = ? AND state = 'active' ORDER BY created_at DESC LIMIT 1").get(chatId) as { p: string } | undefined
      return row?.p ?? null
    },
    finish(chatId, state) {
      db.prepare("UPDATE worktree_sessions SET state = ?, ended_at = ? WHERE chat_id = ? AND state = 'active'").run(state, Date.now(), chatId)
    },
    listActive(projectPath) {
      return db.prepare(`${SELECT} WHERE project_path = ? AND state = 'active' ORDER BY created_at DESC`).all(projectPath) as WorktreeSession[]
    },
  }
}
