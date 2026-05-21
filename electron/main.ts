import { app, BrowserWindow, safeStorage, session } from 'electron'
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
import { createChatSessions } from './storage/chat-sessions'
import { createTasks } from './storage/tasks'
import { createJournal } from './storage/journal'
import { createProjects } from './storage/projects'
import { createUndoStack } from './storage/undo'
import { registerUndoIpc } from './ipc/undo'
import { createPlans } from './storage/plans'
import { registerPlansIpc } from './ipc/plans'
import { createFeedback } from './storage/feedback'
import { registerFeedbackIpc } from './ipc/feedback'
import { registerVerifyIpc } from './ipc/verify'
import { registerAutonomousIpc } from './ipc/autonomous'
import { createConnectorRegistry } from './connectors/registry'

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
      // sandbox: false is REQUIRED because our preload is an ESM (.mjs) file.
      // Electron's renderer sandbox is incompatible with ESM preloads — with
      // sandbox enabled, the preload silently fails to execute and window.api
      // is undefined (black screen). The remaining defence-in-depth: strict
      // contextIsolation + nodeIntegration:false (renderer still cannot reach
      // Node APIs except those we explicitly expose via contextBridge), plus
      // CSP in production.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true  // Allow <webview> for the in-app browser
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(HERE, '../renderer/index.html'))
  }
}

/**
 * Install a Content-Security-Policy header for the renderer in production.
 *
 * Skipped in dev: Vite's HMR client uses inline scripts, eval-based module
 * evaluation, and a websocket to localhost — a strict CSP breaks all of it
 * and you get a blank window. In a packaged build there's no HMR, so we
 * can lock things down. webview content runs in its own session and is
 * NOT affected by this CSP either way.
 */
/**
 * Allow microphone access so VoiceInput / Web Speech API can request it.
 * Without this Electron silently rejects getUserMedia('audio').
 */
function installMediaPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media') return callback(true)
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'media'
  })
}

function installCSP(): void {
  // ELECTRON_RENDERER_URL is set by electron-vite dev runner.
  if (process.env.ELECTRON_RENDERER_URL) return

  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "connect-src 'self' https:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'"
  ].join('; ')
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const rt = details.resourceType
    if (rt === 'mainFrame' || rt === 'subFrame' || rt === 'stylesheet' || rt === 'script') {
      const headers = { ...details.responseHeaders, 'Content-Security-Policy': [csp] }
      callback({ responseHeaders: headers })
      return
    }
    callback({ responseHeaders: details.responseHeaders })
  })
}

// Tell Windows this is its own application so the taskbar uses our icon
// (and not the generic Electron / Node icon).
if (process.platform === 'win32') {
  app.setAppUserModelId('com.pavelfrolof.geminigrok')
}

app.whenReady().then(() => {
  installCSP()
  installMediaPermissions()
  const dir = join(app.getPath('userData'), 'storage')
  mkdirSync(dir, { recursive: true })
  const db = openDb(join(dir, 'geminigrok.db'))
  const settings = createSettings(db, safeStorage)
  const chats = createChats(db)
  const chatSessions = createChatSessions(db)
  const tasks = createTasks(db)
  const journal = createJournal(db)
  const projects = createProjects(db)
  const undoStack = createUndoStack(db)
  const plans = createPlans(db)
  const feedback = createFeedback(db)
  const connectorRegistry = createConnectorRegistry()

  registerProjectIpc(projects)
  registerFilesIpc({ getProjectRoot: getActiveProjectPath })
  registerSettingsIpc(settings)
  registerAiIpc({
    getSecret: (key: string) => {
      const stored = settings.getSecret(key)
      if (stored) return stored
      const envMap: Record<string, string> = {
        gemini_api_key: 'GEMINI_API_KEY',
        anthropic_api_key: 'ANTHROPIC_API_KEY',
        openai_api_key: 'OPENAI_API_KEY',
        xai_api_key: 'XAI_API_KEY',
      }
      return process.env[envMap[key] ?? ''] ?? null
    },
    getProviderId: () => {
      const v = settings.getSecret('provider')
      if (v === 'gemini-cli' || v === 'claude' || v === 'claude-cli'
        || v === 'grok' || v === 'grok-cli'
        || v === 'openai' || v === 'codex-cli') return v
      return 'gemini-api'
    },
    getProviderModel: (id) => settings.getSecret(`model_${id}`),
    recordWrite: (projectPath, filePath, before, after) => {
      undoStack.push(projectPath, filePath, before, after)
    },
    recentWrites: (projectPath, limit) => {
      const list = undoStack.list(projectPath)
      return list.slice(0, limit).map(e => ({ filePath: e.filePath, createdAt: e.createdAt }))
    },
    recordPlan: (projectPath, title, steps) => {
      const plan = plans.create(projectPath, title, steps)
      return { id: plan.id }
    },
    recordJournal: (projectPath, kind, title, detail) => {
      journal.append(projectPath, kind, title, detail ?? null)
    },
    readJournal: (projectPath, limit) => {
      return journal.list(projectPath, limit).map(e => ({
        kind: e.kind, title: e.title, detail: e.detail, createdAt: e.createdAt
      }))
    },
    connectors: {
      list: () => connectorRegistry.list().map(c => ({ ...c })),
      query: (id, args, signal) => connectorRegistry.query(id, args, {
        getSecret: (k) => settings.getSecret(k),
        signal
      })
    },
    getAgentMode: () => {
      const v = settings.getSecret('agent_mode')
      if (v === 'ask' || v === 'accept-edits' || v === 'plan' || v === 'auto' || v === 'bypass') return v
      return 'ask'
    }
  })
  registerChatsIpc(chats, chatSessions)
  registerTasksIpc(tasks)
  registerJournalIpc(journal)
  registerUndoIpc(undoStack)
  registerPlansIpc(plans)
  registerFeedbackIpc(feedback)
  registerVerifyIpc(getActiveProjectPath)
  registerAutonomousIpc({
    getSecret: (key) => {
      const stored = settings.getSecret(key)
      if (stored) return stored
      const envMap: Record<string, string> = {
        gemini_api_key: 'GEMINI_API_KEY',
        anthropic_api_key: 'ANTHROPIC_API_KEY',
        openai_api_key: 'OPENAI_API_KEY',
        xai_api_key: 'XAI_API_KEY'
      }
      return process.env[envMap[key] ?? ''] ?? null
    },
    getProviderId: () => {
      const v = settings.getSecret('provider')
      if (v === 'gemini-cli' || v === 'claude' || v === 'claude-cli'
        || v === 'grok' || v === 'grok-cli'
        || v === 'openai' || v === 'codex-cli') return v
      return 'gemini-api'
    },
    getProviderModel: (id) => settings.getSecret(`model_${id}`),
    recordJournal: (projectPath, kind, title, detail) => {
      journal.append(projectPath, kind, title, detail ?? null)
    },
    readJournal: (projectPath, limit) => {
      return journal.list(projectPath, limit).map(e => ({
        kind: e.kind, title: e.title, detail: e.detail, createdAt: e.createdAt
      }))
    },
    recentWrites: (projectPath, limit) => {
      return undoStack.list(projectPath).slice(0, limit).map(e => ({ filePath: e.filePath, createdAt: e.createdAt }))
    },
    getActiveProject: () => getActiveProjectPath()
  })
  registerTerminalIpc()
  createWindow()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
