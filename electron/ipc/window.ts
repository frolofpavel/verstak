import { BrowserWindow, ipcMain } from 'electron'

function senderWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

export function registerWindowIpc(): void {
  ipcMain.handle('window:minimize', (e) => {
    senderWindow(e)?.minimize()
  })

  ipcMain.handle('window:maximize', (e) => {
    const win = senderWindow(e)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })

  ipcMain.handle('window:close', (e) => {
    senderWindow(e)?.close()
  })

  ipcMain.handle('window:is-maximized', (e) => {
    return senderWindow(e)?.isMaximized() ?? false
  })
}

export function bindWindowChromeEvents(win: BrowserWindow): void {
  const notify = () => {
    win.webContents.send('window:maximized-changed', win.isMaximized())
  }
  win.on('maximize', notify)
  win.on('unmaximize', notify)
}