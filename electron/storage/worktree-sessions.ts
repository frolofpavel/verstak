import type { Database } from 'better-sqlite3'

export type WorktreeState = 'active' | 'merged' | 'dismissed'

export interface WorktreeSession {
  chatId: number
  projectPath: string
  worktreePath: string
  state: WorktreeState
  createdAt: number
  endedAt: number | null
  snapshotRef: string | null
  baseRef: string | null
  lastActiveAt: number | null
  removedAt: number | null
}

export interface WorktreeSessions {
  create: (chatId: number, projectPath: string, worktreePath: string) => WorktreeSession
  getActive: (chatId: number) => WorktreeSession | null
  getLatest: (chatId: number) => WorktreeSession | null
  activePath: (chatId: number) => string | null
  finish: (chatId: number, state: 'merged' | 'dismissed') => void
  touch: (chatId: number, when?: number) => void
  setRefs: (chatId: number, refs: { snapshotRef?: string | null; baseRef?: string | null }) => void
  markRemoved: (chatId: number, worktreePath: string, when?: number) => void
  listActive: (projectPath: string) => WorktreeSession[]
  listProject: (projectPath: string) => WorktreeSession[]
}

const SELECT = `
  SELECT chat_id as chatId, project_path as projectPath, worktree_path as worktreePath,
         state, created_at as createdAt, ended_at as endedAt,
         snapshot_ref as snapshotRef, base_ref as baseRef,
         last_active_at as lastActiveAt, removed_at as removedAt
  FROM worktree_sessions
`

export function createWorktreeSessions(db: Database): WorktreeSessions {
  return {
    create(chatId, projectPath, worktreePath) {
      const now = Date.now()
      db.prepare("UPDATE worktree_sessions SET state = 'dismissed', ended_at = ? WHERE chat_id = ? AND state = 'active'").run(now, chatId)
      db.prepare(
        `INSERT INTO worktree_sessions (
           chat_id, project_path, worktree_path, state, created_at, ended_at,
           snapshot_ref, base_ref, last_active_at, removed_at
         )
         VALUES (?, ?, ?, 'active', ?, NULL, NULL, NULL, ?, NULL)`
      ).run(chatId, projectPath, worktreePath, now, now)
      return {
        chatId,
        projectPath,
        worktreePath,
        state: 'active',
        createdAt: now,
        endedAt: null,
        snapshotRef: null,
        baseRef: null,
        lastActiveAt: now,
        removedAt: null,
      }
    },
    getActive(chatId) {
      const row = db.prepare(`${SELECT} WHERE chat_id = ? AND state = 'active' ORDER BY created_at DESC LIMIT 1`).get(chatId) as WorktreeSession | undefined
      return row ?? null
    },
    getLatest(chatId) {
      const row = db.prepare(`${SELECT} WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`).get(chatId) as WorktreeSession | undefined
      return row ?? null
    },
    activePath(chatId) {
      const row = db.prepare("SELECT worktree_path as p FROM worktree_sessions WHERE chat_id = ? AND state = 'active' ORDER BY created_at DESC LIMIT 1").get(chatId) as { p: string } | undefined
      return row?.p ?? null
    },
    finish(chatId, state) {
      db.prepare("UPDATE worktree_sessions SET state = ?, ended_at = ? WHERE chat_id = ? AND state = 'active'").run(state, Date.now(), chatId)
    },
    touch(chatId, when = Date.now()) {
      db.prepare("UPDATE worktree_sessions SET last_active_at = ? WHERE chat_id = ? AND state = 'active'").run(when, chatId)
    },
    setRefs(chatId, refs) {
      db.prepare("UPDATE worktree_sessions SET snapshot_ref = COALESCE(?, snapshot_ref), base_ref = COALESCE(?, base_ref) WHERE chat_id = ? AND state = 'active'")
        .run(refs.snapshotRef ?? null, refs.baseRef ?? null, chatId)
    },
    markRemoved(chatId, worktreePath, when = Date.now()) {
      db.prepare("UPDATE worktree_sessions SET removed_at = ? WHERE chat_id = ? AND worktree_path = ? AND removed_at IS NULL")
        .run(when, chatId, worktreePath)
    },
    listActive(projectPath) {
      return db.prepare(`${SELECT} WHERE project_path = ? AND state = 'active' ORDER BY created_at DESC`).all(projectPath) as WorktreeSession[]
    },
    listProject(projectPath) {
      return db.prepare(`${SELECT} WHERE project_path = ? ORDER BY created_at DESC`).all(projectPath) as WorktreeSession[]
    },
  }
}
