import { removeWorktree, snapshotWorktree, type WorktreeSnapshotKind } from './git-worktree'
import { detectWorktreeState, type WorktreeGitState } from './worktree-status'

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
