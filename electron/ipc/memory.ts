import { ipcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import { saveMemory, searchMemories, listMemories, deleteMemory } from '../storage/memories'
import type { MemoryType } from '../storage/memories'

export function registerMemoryIpc(db: Database): void {
  ipcMain.handle('memory:save', (_e, args: { projectPath: string; type: MemoryType; content: string; tags: string[] }) =>
    saveMemory(db, args.projectPath, args.type, args.content, args.tags)
  )

  ipcMain.handle('memory:search', (_e, args: { projectPath: string; query: string; limit?: number }) =>
    searchMemories(db, args.projectPath, args.query, args.limit)
  )

  ipcMain.handle('memory:list', (_e, args: { projectPath: string }) =>
    listMemories(db, args.projectPath)
  )

  ipcMain.handle('memory:delete', (_e, args: { id: string }) =>
    deleteMemory(db, args.id)
  )
}
