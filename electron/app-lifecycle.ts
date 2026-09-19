import { app, BrowserWindow } from 'electron'
import { abortSend } from './ipc/ai'
import { killAllTerminalSessions } from './ipc/terminal'
import { destroyNotificationWindow } from './notification-window'
import { mcpClient } from './mcp/client'

/** Имя в диспетчере задач / process.title (Windows). */
export const APP_DISPLAY_NAME = 'VERSTAK'

export function installAppIdentity(): void {
  app.setName(APP_DISPLAY_NAME)
  process.title = APP_DISPLAY_NAME
}

let shutdownDone = false
let appQuitting = false

export function shouldHideWindowOnClose(
  platform: NodeJS.Platform,
  isQuitting: boolean,
): boolean {
  return platform === 'darwin' && !isQuitting
}

/** Освобождает вспомогательные окна/PTY/MCP — иначе процесс висит после закрытия UI. */
export function runAppShutdown(): void {
  if (shutdownDone) return
  shutdownDone = true
  destroyNotificationWindow()
  killAllTerminalSessions()
  abortSend(0)
  mcpClient.disconnectAll()
}

export function bindMainWindowLifecycle(mainWindow: BrowserWindow): void {
  mainWindow.on('close', (event) => {
    if (shouldHideWindowOnClose(process.platform, appQuitting)) {
      event.preventDefault()
      mainWindow.hide()
      return
    }
    runAppShutdown()
  })
}

export function installGlobalQuitHandlers(): void {
  app.on('before-quit', () => {
    appQuitting = true
    runAppShutdown()
  })
  app.on('activate', () => {
    const mainWindow = BrowserWindow.getAllWindows()[0]
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  process.on('unhandledRejection', (reason) => {
    console.warn('[app] unhandledRejection:', reason)
  })
}
