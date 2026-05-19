import { app, BrowserWindow, safeStorage } from 'electron'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'

// In ESM modules __dirname is not a global. Recreate it from import.meta.url.
const HERE = dirname(fileURLToPath(import.meta.url))
import { registerProjectIpc } from './ipc/projects'
import { registerFilesIpc } from './ipc/files'
import { registerTasksIpc } from './ipc/tasks'
import { registerJournalIpc } from './ipc/journal'
import { getActiveProjectPath } from './state/project-state'
import { registerSettingsIpc } from './ipc/settings'
import { registerAiIpc } from './ipc/ai'
import { registerChatsIpc } from './ipc/chats'
import { registerTerminalIpc } from './ipc/terminal'
import { openDb } from './storage/db'
import { createSettings } from './storage/settings'
import { createChats } from './storage/chats'
import { createTasks } from './storage/tasks'
import { createJournal } from './storage/journal'
import { createProjects } from './storage/projects'

function createWindow(): void {
  // HERE = out/main in dev and prod
  const iconPath = join(HERE, '../../resources/icon.png')
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'GeminiGrok',
    icon: iconPath,
    webPreferences: {
      preload: join(HERE, '../preload/preload.mjs'),
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(HERE, '../renderer/index.html'))
  }
}

// Tell Windows this is its own application so the taskbar uses our icon
// (and not the generic Electron / Node icon).
if (process.platform === 'win32') {
  app.setAppUserModelId('com.pavelfrolof.geminigrok')
}

app.whenReady().then(() => {
  const dir = join(app.getPath('userData'), 'storage')
  mkdirSync(dir, { recursive: true })
  const db = openDb(join(dir, 'geminigrok.db'))
  const settings = createSettings(db, safeStorage)
  const chats = createChats(db)
  const tasks = createTasks(db)
  const journal = createJournal(db)
  const projects = createProjects(db)

  registerProjectIpc(projects)
  registerFilesIpc({ getProjectRoot: getActiveProjectPath })
  registerSettingsIpc(settings)
  registerAiIpc({
    getSecret: (key: string) => settings.getSecret(key),
    getProviderId: () => {
      const v = settings.getSecret('provider')
      if (v === 'gemini-cli' || v === 'claude' || v === 'claude-cli'
        || v === 'grok' || v === 'openai' || v === 'codex-cli') return v
      return 'gemini-api'
    },
    getProviderModel: (id) => settings.getSecret(`model_${id}`)
  })
  registerChatsIpc(chats)
  registerTasksIpc(tasks)
  registerJournalIpc(journal)
  registerTerminalIpc()
  createWindow()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
