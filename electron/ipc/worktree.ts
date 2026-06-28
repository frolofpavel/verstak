import { ipcMain } from 'electron'
import { addWorktree, removeWorktree, worktreeDiff, mergeWorktreeToMain, isGitRepo } from '../ai/git-worktree'
import type { WorktreeSessions } from '../storage/worktree-sessions'

/**
 * #5 worktree-lifecycle IPC. isolate → создать persistent worktree для чата (прогоны
 * пишут туда); status → есть ли изменения; merge → применить в main локально (БЕЗ
 * push) + закрыть; discard → отбросить. addWorktree/mergeWorktreeToMain — git-worktree.ts.
 */
export function registerWorktreeIpc(wts: WorktreeSessions): void {
  ipcMain.handle('worktree:isolate', (_e, chatId: number, projectPath: string) => {
    if (!projectPath || !isGitRepo(projectPath)) return { ok: false, error: 'Изоляция требует git-репозиторий проекта.' }
    const existing = wts.getActive(chatId)
    if (existing) return { ok: true, worktreePath: existing.worktreePath } // уже изолирован
    const path = addWorktree(projectPath, `chat-${chatId}`)
    if (!path) return { ok: false, error: 'Не удалось создать worktree (нет коммитов / ошибка git).' }
    wts.create(chatId, projectPath, path)
    return { ok: true, worktreePath: path }
  })

  ipcMain.handle('worktree:status', (_e, chatId: number) => {
    const s = wts.getActive(chatId)
    if (!s) return { active: false as const }
    const diff = worktreeDiff(s.worktreePath)
    const fileCount = (diff.match(/^diff --git /gm) || []).length
    return { active: true as const, worktreePath: s.worktreePath, fileCount, hasChanges: diff.trim().length > 0 }
  })

  ipcMain.handle('worktree:merge', (_e, chatId: number) => {
    const s = wts.getActive(chatId)
    if (!s) return { ok: false, error: 'Нет активного worktree для этого чата.' }
    const r = mergeWorktreeToMain(s.projectPath, s.worktreePath)
    if (!r.ok) return r // main НЕ тронут (git apply атомарен), worktree оставляем для повтора
    wts.finish(chatId, 'merged')
    removeWorktree(s.projectPath, s.worktreePath)
    return { ok: true }
  })

  ipcMain.handle('worktree:discard', (_e, chatId: number) => {
    const s = wts.getActive(chatId)
    if (!s) return { ok: true }
    wts.finish(chatId, 'dismissed')
    removeWorktree(s.projectPath, s.worktreePath)
    return { ok: true }
  })
}
