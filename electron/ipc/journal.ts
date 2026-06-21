import { ipcMain } from 'electron'
import type { Journal, JournalKind } from '../storage/journal'

export function registerJournalIpc(journal: Journal): void {
  ipcMain.handle('journal:list', (_e, projectPath: string, limit?: number) => journal.list(projectPath, limit))
  ipcMain.handle('journal:currentSession', (_e, projectPath: string) => journal.currentSession(projectPath))
  ipcMain.handle('journal:append', (_e, projectPath: string, kind: JournalKind, title: string, detail?: string | null) => {
    if (kind === 'manual') throw new Error('Manual journal entries are disabled')
    return journal.append(projectPath, kind, title, detail ?? null)
  })
}
