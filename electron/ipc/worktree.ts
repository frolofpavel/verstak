import { ipcMain } from 'electron'
import { addWorktree, worktreeDiff, mergeWorktreeToMain, isGitRepo, sweepStaleWorktrees } from '../ai/git-worktree'
import { removeWorktreeLossless } from '../ai/worktree-lifecycle'
import { detectWorktreeState } from '../ai/worktree-status'
import type { WorktreeSessions } from '../storage/worktree-sessions'

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

    try {
      sweepStaleWorktrees(projectPath, wts.listActive(projectPath).map(s => s.worktreePath))
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
  })
}
