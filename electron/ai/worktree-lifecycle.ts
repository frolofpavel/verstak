import { removeWorktree, snapshotWorktree, reconcileOrphanWorktreePaths, type WorktreeSnapshotKind } from './git-worktree'
import { detectWorktreeState, type WorktreeGitState } from './worktree-status'

export const IDLE_WORKTREE_GC_MS = 7 * 24 * 60 * 60 * 1000

export interface LosslessRemoveOptions {
  force?: boolean
  snapshot?: boolean
}

export interface LosslessRemoveResult {
  ok: boolean
  removed: boolean
  state?: WorktreeGitState
  snapshotRef?: string | null
  snapshotKind?: WorktreeSnapshotKind | null
  baseRef?: string | null
  error?: string
}

export async function removeWorktreeLossless(
  repoRoot: string,
  worktreePath: string,
  options: LosslessRemoveOptions = {}
): Promise<LosslessRemoveResult> {
  const force = options.force === true
  const shouldSnapshot = options.snapshot !== false
  const state = await detectWorktreeState(worktreePath)
  const risky = state.dirty || state.unpushed

  if (risky && !force) {
    const reason = [
      state.dirty ? `${state.dirtyFiles ?? 0} dirty file(s)` : '',
      state.unpushed ? `${state.unpushedCommits ?? 0} unpushed commit(s)` : '',
    ].filter(Boolean).join(', ')
    return {
      ok: false,
      removed: false,
      state,
      error: `worktree has unsaved state: ${reason}`,
    }
  }

  let snapshotRef: string | null = null
  let snapshotKind: WorktreeSnapshotKind | null = null
  let baseRef: string | null = null

  if (risky && shouldSnapshot) {
    const snapshot = snapshotWorktree(repoRoot, worktreePath, { preserveHead: state.unpushed })
    if (!snapshot.ok) {
      return {
        ok: false,
        removed: false,
        state,
        snapshotRef: snapshot.snapshotRef,
        snapshotKind: snapshot.snapshotKind,
        baseRef: snapshot.baseRef,
        error: snapshot.error || 'cannot snapshot worktree',
      }
    }
    snapshotRef = snapshot.snapshotRef
    snapshotKind = snapshot.snapshotKind
    baseRef = snapshot.baseRef
  }

  const removed = removeWorktree(repoRoot, worktreePath)
  return {
    ok: removed,
    removed,
    state,
    snapshotRef,
    snapshotKind,
    baseRef,
    error: removed ? undefined : 'cannot remove worktree',
  }
}

// ── WT-05: idle-GC + registry-aware orphan reconcile ────────────────────────

export interface WorktreeGcEntry {
  chatId: number
  worktreePath: string
  state: 'active' | 'merged' | 'dismissed'
  lastActiveAt: number | null
  removedAt: number | null
}

export interface WorktreeGcDeps {
  now?: () => number
  idleMs?: number
  /** Все сессии проекта из реестра (worktree_sessions). */
  listSessions: () => WorktreeGcEntry[]
  /** Пометить сессию физически удалённой (removed_at). */
  markRemoved: (chatId: number, worktreePath: string, when?: number) => void
}

/**
 * GC завершённых worktree-сессий проекта, давно неактивных (last_active_at старше
 * idleMs, дефолт 7д) И чистых. Активные сессии НЕ трогаем (чат ими владеет), грязные
 * пропускаем (lossless remove без force откажет — данные бережём). removed_at уже
 * проставлен → пропуск. Каждое удаление помечается markRemoved.
 */
export async function gcWorktrees(repoRoot: string, deps: WorktreeGcDeps): Promise<{ removed: string[]; skipped: string[] }> {
  const now = deps.now ?? Date.now
  const idleMs = deps.idleMs ?? IDLE_WORKTREE_GC_MS
  const cutoff = now() - idleMs
  const removed: string[] = []
  const skipped: string[] = []
  for (const e of deps.listSessions()) {
    if (e.removedAt != null) continue          // уже удалён из дерева
    if (e.state === 'active') continue          // активную сессию не осиротим
    if ((e.lastActiveAt ?? 0) > cutoff) continue // ещё не idle
    const res = await removeWorktreeLossless(repoRoot, e.worktreePath, { force: false, snapshot: false })
    if (res.removed) {
      deps.markRemoved(e.chatId, e.worktreePath, now())
      removed.push(e.worktreePath)
    } else {
      skipped.push(e.worktreePath)              // грязный/unpushed/уже нет — бережём
    }
  }
  return { removed, skipped }
}

export interface WorktreeReconcileDeps {
  /** Пути активных сессий проекта — их не сносим. */
  activePaths: () => string[]
}

/**
 * Registry-aware reconcile: сносит verstak-wt worktree'ы из `git worktree list`,
 * которых нет среди активных путей реестра — осиротевшие (краш, удалённый чат).
 * Тонкая обёртка над path-based reconcileOrphanWorktreePaths с keepPaths из реестра.
 */
export function reconcileOrphanWorktrees(repoRoot: string, deps: WorktreeReconcileDeps): { removed: string[] } {
  return { removed: reconcileOrphanWorktreePaths(repoRoot, deps.activePaths()) }
}
