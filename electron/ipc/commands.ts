import { ipcMain } from 'electron'
import { loadCommands } from '../ai/commands'

export function registerCommandsIpc(): void {
  ipcMain.handle('commands:list', (_e, projectPath: string | null) => {
    return loadCommands(projectPath)
  })
}
