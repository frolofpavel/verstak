import { ipcMain } from 'electron'
import type { Verifications } from '../storage/verifications'

/**
 * IPC для истории Verification Artifact (Фаза 3).
 *
 *  - verifications:list   → история проекта (новейшие первыми)
 *  - verifications:latest → свежайшая верификация проекта/чата (Review DoD)
 *  - verifications:latest-by-run → свежайшая верификация конкретного runId
 *  - verifications:get    → одна строка по id
 */
export function registerVerificationsIpc(verifications: Verifications): void {
  ipcMain.handle('verifications:list', (_e, projectPath: string, limit?: number) =>
    verifications.list(projectPath, limit)
  )
  ipcMain.handle('verifications:latest', (_e, projectPath: string, chatId?: number | null) =>
    verifications.latest(projectPath, chatId)
  )
  ipcMain.handle('verifications:latest-by-run', (_e, projectPath: string, runId: string) =>
    verifications.latestByRunId(projectPath, runId)
  )
  ipcMain.handle('verifications:get', (_e, id: number) =>
    verifications.get(id)
  )
}
