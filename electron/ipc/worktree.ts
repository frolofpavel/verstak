import { ipcMain } from 'electron'
import {
  addWorktree,
  worktreeDiff,
  mergeWorktreeToMain,
  isGitRepo,
  snapshotWorktree,
  restoreWorktreeSnapshot,
} from '../ai/git-worktree'
import { removeWorktreeLossless, reconcileOrphanWorktrees, gcWorktrees } from '../ai/worktree-lifecycle'
import { detectWorktreeState } from '../ai/worktree-status'
import type { WorktreeSession, WorktreeSessions } from '../storage/worktree-sessions'

async function discardActiveWorktree(wts: WorktreeSessions, chatId: number): Promise<{ ok: boolean; error?: string }> {
  const session = wts.getActive(chatId)
  if (!session) return { ok: true }

  const removal = await removeWorktreeLossless(session.projectPath, session.worktreePath, { force: true, snapshot: true })
  if (!removal.ok) return { ok: false, error: removal.error || 'Не удалось безопасно удалить worktree.' }
  wts.setRefs(chatId, { snapshotRef: removal.snapshotRef, baseRef: removal.baseRef })
  wts.finish(chatId, 'dismissed')
  if (removal.removed) {
    wts.markRemoved(chatId, session.worktreePath)
  }
  return { ok: true }
}

async function summarizeSession(session: WorktreeSession) {
  const restorable = !!session.snapshotRef && session.removedAt != null
  const base = {
    chatId: session.chatId,
    projectPath: session.projectPath,
    worktreePath: session.worktreePath,
    state: session.state,
    snapshotRef: session.snapshotRef,
    baseRef: session.baseRef,
    lastActiveAt: session.lastActiveAt,
    removedAt: session.removedAt,
    restorable,
  }
  if (session.state !== 'active') return base
  try {
    const gitState = await detectWorktreeState(session.worktreePath)
    return {
      ...base,
      fileCount: gitState.dirtyFiles ?? 0,
      hasChanges: gitState.dirty || gitState.unpushed,
      gitState,
    }
  } catch {
    const diff = worktreeDiff(session.worktreePath)
    const fileCount = (diff.match(/^diff --git /gm) || []).length
    return {
      ...base,
      fileCount,
      hasChanges: diff.trim().length > 0,
    }
  }
}

export function registerWorktreeIpc(wts: WorktreeSessions): void {
  ipcMain.handle('worktree:isolate', (_e, chatId: number, projectPath: string) => {
    if (!projectPath || !isGitRepo(projectPath)) {
      return { ok: false, error: 'Изоляция требует git-репозиторий проекта.' }
    }

    const existing = wts.getActive(chatId)
    if (existing) {
      wts.touch(chatId)
      return { ok: true, worktreePath: existing.worktreePath }
    }

    // WT-05: перед новой изоляцией чистим осиротевшие (reconcile по реестру) и
    // GC'им давно неактивные завершённые сессии (idle 7д + clean). Best-effort.
    try {
      reconcileOrphanWorktrees(projectPath, {
        activePaths: () => wts.listActive(projectPath).map(s => s.worktreePath),
      })
      void gcWorktrees(projectPath, {
        listSessions: () => wts.listProject(projectPath).map(s => ({
          chatId: s.chatId,
          worktreePath: s.worktreePath,
          state: s.state,
          lastActiveAt: s.lastActiveAt,
          removedAt: s.removedAt,
        })),
        markRemoved: (chatId, worktreePath, when) => wts.markRemoved(chatId, worktreePath, when),
      }).catch(() => { /* best-effort GC */ })
    } catch {
      // best-effort cleanup only
    }

    const path = addWorktree(projectPath, `chat-${chatId}`)
    if (!path) {
      return { ok: false, error: 'Не удалось создать worktree (нет коммитов или ошибка git).' }
    }

    wts.create(chatId, projectPath, path)
    return { ok: true, worktreePath: path }
  })

  ipcMain.handle('worktree:list', async (_e, projectPath: string) => {
    if (!projectPath) return []
    return Promise.all(wts.listProject(projectPath).map(summarizeSession))
  })

  ipcMain.handle('worktree:status', async (_e, chatId: number) => {
    const session = wts.getActive(chatId)
    if (!session) return { active: false as const }

    wts.touch(chatId)
    try {
      const gitState = await detectWorktreeState(session.worktreePath)
      return {
        active: true as const,
        worktreePath: session.worktreePath,
        fileCount: gitState.dirtyFiles ?? 0,
        hasChanges: gitState.dirty || gitState.unpushed,
        gitState,
      }
    } catch {
      const diff = worktreeDiff(session.worktreePath)
      const fileCount = (diff.match(/^diff --git /gm) || []).length
      return {
        active: true as const,
        worktreePath: session.worktreePath,
        fileCount,
        hasChanges: diff.trim().length > 0,
      }
    }
  })

  ipcMain.handle('worktree:merge', async (_e, chatId: number) => {
    const session = wts.getActive(chatId)
    if (!session) return { ok: false, error: 'Нет активного worktree для этого чата.' }

    const result = mergeWorktreeToMain(session.projectPath, session.worktreePath)
    if (!result.ok) return result

    const removal = await removeWorktreeLossless(session.projectPath, session.worktreePath, { force: true, snapshot: true })
    if (!removal.ok) return { ok: false, error: removal.error || 'Не удалось безопасно удалить worktree.' }
    wts.setRefs(chatId, { snapshotRef: removal.snapshotRef, baseRef: removal.baseRef })
    wts.finish(chatId, 'merged')
    if (removal.removed) {
      wts.markRemoved(chatId, session.worktreePath)
    }
    return { ok: true }
  })

  ipcMain.handle('worktree:discard', async (_e, chatId: number) => {
    return discardActiveWorktree(wts, chatId)
  })

  ipcMain.handle('worktree:delete', async (_e, chatId: number) => {
    return discardActiveWorktree(wts, chatId)
  })

  ipcMain.handle('worktree:snapshot', async (_e, chatId: number) => {
    const session = wts.getActive(chatId)
    if (!session) return { ok: false, error: 'Нет активного worktree для этого чата.' }
    const result = snapshotWorktree(session.projectPath, session.worktreePath, { preserveHead: true })
    if (!result.ok) return { ok: false, error: result.error || 'Не удалось создать snapshot.' }
    wts.setRefs(chatId, { snapshotRef: result.snapshotRef, baseRef: result.baseRef })
    wts.touch(chatId)
    return { ok: true, snapshotRef: result.snapshotRef, baseRef: result.baseRef }
  })

  ipcMain.handle('worktree:restore', async (_e, chatId: number) => {
    const active = wts.getActive(chatId)
    if (active) return { ok: true, worktreePath: active.worktreePath }
    const session = wts.getLatest(chatId)
    if (!session?.snapshotRef) return { ok: false, error: 'Нет snapshot для восстановления worktree.' }
    const restored = restoreWorktreeSnapshot(session.projectPath, session.snapshotRef, session.baseRef, `restore-${chatId}`)
    if (!restored.ok || !restored.worktreePath) return { ok: false, error: restored.error || 'Не удалось восстановить worktree.' }
    wts.create(chatId, session.projectPath, restored.worktreePath)
    wts.setRefs(chatId, { snapshotRef: session.snapshotRef, baseRef: session.baseRef })
    return { ok: true, worktreePath: restored.worktreePath }
  })
}
