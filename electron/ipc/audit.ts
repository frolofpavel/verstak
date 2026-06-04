import { ipcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import { queryAudit, exportAuditCsv, clearAudit, type AuditQueryOpts } from '../storage/audit-log'

export function registerAuditIpc(db: Database): void {
  ipcMain.handle('audit:query', (_e, projectPath: string, opts: AuditQueryOpts = {}) => {
    return queryAudit(db, projectPath, opts)
  })

  ipcMain.handle('audit:export', (_e, projectPath: string) => {
    return exportAuditCsv(db, projectPath)
  })

  ipcMain.handle('audit:clear', (_e, projectPath: string, olderThan?: number) => {
    return clearAudit(db, projectPath, olderThan)
  })
}
