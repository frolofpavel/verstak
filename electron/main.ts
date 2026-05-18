import { app, BrowserWindow, safeStorage } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { registerProjectIpc } from './ipc/projects'
import { registerFilesIpc } from './ipc/files'
import { registerSettingsIpc } from './ipc/settings'
import { registerAiIpc } from './ipc/ai'
import { registerChatsIpc } from './ipc/chats'
import { registerTerminalIpc } from './ipc/terminal'
import { openDb } from './storage/db'
import { createSettings } from './storage/settings'
import { createChats } from './storage/chats'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'GeminiGrok',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  const dir = join(app.getPath('userData'), 'storage')
  mkdirSync(dir, { recursive: true })
  const db = openDb(join(dir, 'geminigrok.db'))
  const settings = createSettings(db, safeStorage)
  const chats = createChats(db)

  registerProjectIpc()
  registerFilesIpc()
  registerSettingsIpc(settings)
  registerAiIpc({
    getApiKey: () => settings.getSecret('gemini_api_key'),
    getProviderId: () => {
      const v = settings.getSecret('provider')
      return v === 'gemini-cli' ? 'gemini-cli' : 'gemini-api'
    }
  })
  registerChatsIpc(chats)
  registerTerminalIpc()
  createWindow()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
