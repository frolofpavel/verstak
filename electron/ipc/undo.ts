import { ipcMain } from 'electron'
import { writeFile, unlink, stat } from 'fs/promises'
import type { UndoStack } from '../storage/undo'
import { safeRealJoin } from '../ai/path-policy'

export function registerUndoIpc(stack: UndoStack): void {
  ipcMain.handle('undo:list', (_e, projectPath: string) => stack.list(projectPath))
  ipcMain.handle('undo:count', (_e, projectPath: string) => stack.count(projectPath))
  ipcMain.handle('undo:clear', (_e, projectPath: string) => stack.clear(projectPath))

  /**
   * Snap a checkpoint at the current top of the undo stack. Returns the id
   * of the latest entry, or 0 if the stack is empty (0 is below any real
   * autoincrement id, so `id > 0` matches every future entry). The renderer
   * stores 0 the same as any other id — no null sentinel needed.
   */
  ipcMain.handle('undo:checkpoint', (_e, projectPath: string) => {
    const list = stack.list(projectPath)
    return list.length > 0 ? list[0].id : 0
  })

  /**
   * Revert every undo entry created AFTER `checkpointId`. Pops them newest-
   * first so dependent writes restore in the right order. `checkpointId=0`
   * is the "checkpoint at empty stack" case — every entry has id > 0, so the
   * filter naturally reverts everything.
   *
   * Returns the list of files restored + count, or { ok: false, reason } if
   * something blew up halfway. On failure we re-push popped-but-unrestored
   * entries so the user can retry.
   */
  ipcMain.handle('undo:revertToCheckpoint', async (_e, projectPath: string, checkpointId: number) => {
    const all = stack.list(projectPath)
    const toRevert = all.filter(e => e.id > checkpointId)
    if (toRevert.length === 0) return { ok: true, restored: [], count: 0 }
    const restored: string[] = []
    const failed: Array<{ id: number; filePath: string; before: string; after: string; reason: string }> = []
    // Newest first — undo entries reflect chronological writes; reversing
    // them restores files in their proper rollback order.
    for (const entry of toRevert) {
      const popped = stack.pop(entry.id)
      if (!popped) continue
      try {
        const abs = await safeRealJoin(projectPath, popped.filePath)
        const before = popped.beforeContent
        if (before === null || before === '') {
          try {
            await stat(abs)
            await unlink(abs)
          } catch { /* already gone */ }
        } else {
          await writeFile(abs, before, 'utf8')
        }
        restored.push(popped.filePath)
      } catch (err) {
        failed.push({
          id: popped.id,
          filePath: popped.filePath,
          before: popped.beforeContent ?? '',
          after: popped.afterContent ?? '',
          reason: err instanceof Error ? err.message : String(err)
        })
      }
    }
    // Re-push the failed ones so the user can see / retry
    for (const f of failed) {
      stack.push(projectPath, f.filePath, f.before, f.after)
    }
    if (failed.length > 0) {
      return { ok: false, restored, count: restored.length, failed }
    }
    return { ok: true, restored, count: restored.length }
  })

  // Pop the most recent (or specific) entry and restore the file's previous state.
  ipcMain.handle('undo:revert', async (_e, projectPath: string, id?: number) => {
    let entry = null
    if (id != null) {
      entry = stack.pop(id)
    } else {
      const list = stack.list(projectPath)
      if (list.length > 0) entry = stack.pop(list[0].id)
    }
    if (!entry) return { ok: false, reason: 'no entries' }
    try {
      // safeRealJoin: textual + symlink-aware. Same enforcement as
      // ai-tools and files.ts — no third path-policy drift.
      const abs = await safeRealJoin(projectPath, entry.filePath)
      const before = entry.beforeContent
      if (before === null || before === '') {
        // The file did not exist before — attempting to remove it now.
        try {
          await stat(abs)
          await unlink(abs)
        } catch { /* already gone */ }
      } else {
        await writeFile(abs, before, 'utf8')
      }
      return { ok: true, filePath: entry.filePath }
    } catch (err) {
      // Put it back on the stack so the user can retry
      stack.push(projectPath, entry.filePath, entry.beforeContent ?? '', entry.afterContent ?? '')
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  })
}
