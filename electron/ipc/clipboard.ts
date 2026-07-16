import { clipboard, ipcMain } from 'electron'

export function registerClipboardIpc(): void {
  ipcMain.handle('clipboard:write-text', (_event, text: unknown) => {
    if (typeof text !== 'string') return false
    clipboard.writeText(text)
    return true
  })
}
