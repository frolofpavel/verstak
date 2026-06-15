import { app, BrowserWindow, safeStorage, session, dialog, protocol, net } from 'electron'
import { pathToFileURL } from 'url'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'

// Linux AppImage + Electron sandbox: на некоторых дистрибутивах (Ubuntu 24+, Fedora)
// AppImage не может создать sandbox namespace. Electron падает с:
//   "The SUID sandbox helper binary was found, but is not configured correctly"
// Безопасный workaround: отключаем Chromium sandbox если запущены как AppImage.
// Наша безопасность обеспечивается через contextIsolation + nodeIntegration:false.
if (process.platform === 'linux' && process.env.APPIMAGE) {
  app.commandLine.appendSwitch('no-sandbox')
}

// In ESM modules __dirname is not a global. Recreate it from import.meta.url.
const HERE = dirname(fileURLToPath(import.meta.url))
import { registerProjectIpc } from './ipc/projects'
import { registerFilesIpc } from './ipc/files'
import { registerTasksIpc } from './ipc/tasks'
import { registerJournalIpc } from './ipc/journal'
import { getActiveProjectPath } from './state/project-state'
import { registerSettingsIpc } from './ipc/settings'
import { registerCliAuthIpc } from './ipc/cli-auth'
import { registerAiIpc } from './ipc/ai'
import { registerChatsIpc } from './ipc/chats'
import { registerHandoffIpc } from './ipc/handoff'
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
import { PROVIDERS, type ProviderId } from './ai/registry'
import { AGENT_MODES } from './ai/mode-policy'
import { createSkillRegistry } from './ai/skills/registry'
import { registerSkillsIpc } from './ipc/skills'
import { createUserProfiles } from './storage/user-profiles'
import { registerUserProfilesIpc } from './ipc/user-profiles'
import { registerMemoryIpc } from './ipc/memory'
import { saveMemory, searchMemories, applyMemoryDecay } from './storage/memories'
import { searchConversations } from './storage/chats'
import { registerCommandsIpc } from './ipc/commands'
import { registerMcpIpc } from './ipc/mcp'
import { mcpClient } from './mcp/client'
import { registerAuditIpc } from './ipc/audit'
import { appendAudit } from './storage/audit-log'
import { registerDebugIpc } from './ipc/debug'
import { saveRunInput } from './storage/run-inputs'
import { trackToolForPatterns } from './ai/procedural-memory'
import { registerSuggestionsIpc } from './ipc/suggestions'
import { initAutoUpdater } from './updater'
import { registerNotifyIpc } from './ipc/notify'
import { bindUiScaleToWindow } from './ui-scale'
import {
  mainWindowConstructorOptions,
  readMainWindowState,
  trackMainWindowState
} from './window-state'
import type { Settings } from './storage/settings'

function createWindow(settings: Settings): BrowserWindow {
  // HERE = out/main in dev and prod
  const iconPath = join(HERE, '../../resources/icon.png')
  const windowState = readMainWindowState(settings)
  const win = new BrowserWindow({
    ...mainWindowConstructorOptions(windowState),
    title: 'Verstak',
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

  trackMainWindowState(win, settings, windowState)

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(HERE, '../renderer/index.html'))
  }
  return win
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
    "img-src 'self' data: blob: gg-project-icon:",
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
  app.setAppUserModelId('ru.verstak.ide')
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'gg-project-icon',
    privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true }
  }
])

app.whenReady().then(() => {
  protocol.handle('gg-project-icon', (request) => {
    const prefix = 'gg-project-icon://local/'
    if (!request.url.startsWith(prefix)) return new Response(null, { status: 404 })
    const filePath = decodeURIComponent(request.url.slice(prefix.length))
    return net.fetch(pathToFileURL(filePath).href)
  })
  installCSP()
  installMediaPermissions()
  const dir = join(app.getPath('userData'), 'storage')
  mkdirSync(dir, { recursive: true })
  let db
  try {
    db = openDb(join(dir, 'verstak.db'))
  } catch (err) {
    // DB locked, disk full, schema migration failed — show GUI error
    // instead of crashing silently with stderr only.
    const msg = err instanceof Error ? err.message : String(err)
    dialog.showErrorBox(
      'Verstak: не удалось открыть базу данных',
      `Путь: ${join(dir, 'verstak.db')}\n\nОшибка: ${msg}\n\n` +
      `Возможные причины: файл заблокирован другим процессом Verstak, ` +
      `диск переполнен, или повреждённая миграция схемы.\n\n` +
      `Что попробовать:\n` +
      `1. Закрой все другие копии Verstak\n` +
      `2. Проверь свободное место на диске\n` +
      `3. Если ничего не помогает — переименуй verstak.db в .bak и перезапусти ` +
      `(чаты будут потеряны, но проект откроется)`
    )
    app.quit()
    return
  }
  // Затухание памяти — раз в запуск, тихо
  try {
    const decayResult = applyMemoryDecay(db)
    if (decayResult.decayed > 0 || decayResult.deleted > 0) {
      console.log(`[memory] decay: ${decayResult.decayed} updated, ${decayResult.deleted} deleted`)
    }
  } catch (err) {
    console.warn('[memory] decay failed:', err instanceof Error ? err.message : err)
  }

  const settings = createSettings(db, safeStorage)

  const ENV_MAP: Record<string, string> = {
    gemini_api_key: 'GEMINI_API_KEY',
    anthropic_api_key: 'ANTHROPIC_API_KEY',
    openai_api_key: 'OPENAI_API_KEY',
    xai_api_key: 'XAI_API_KEY',
  }
  const getSecret = (key: string): string | null => {
    const stored = settings.getSecret(key)
    if (stored) return stored
    return process.env[ENV_MAP[key] ?? ''] ?? null
  }
  const getProviderId = (): ProviderId => {
    const v = settings.getSecret('provider')
    if (v && v in PROVIDERS) return v as ProviderId
    return 'gemini-api'
  }
  const getProviderModel = (id: ProviderId): string | null => settings.getSecret(`model_${id}`)
  const getAgentMode = () => {
    const v = settings.getSecret('agent_mode')
    if (v && AGENT_MODES.some(m => m.id === v)) return v as typeof AGENT_MODES[number]['id']
    return 'ask' as const
  }

  const chats = createChats(db)
  const chatSessions = createChatSessions(db)
  const tasks = createTasks(db)
  const journal = createJournal(db)
  const projects = createProjects(db)
  const undoStack = createUndoStack(db)
  const plans = createPlans(db)
  const feedback = createFeedback(db)
  const connectorRegistry = createConnectorRegistry()
  const userProfiles = createUserProfiles(db)

  // Skill registry — собирает скиллы из server API + ~/.verstak/skills/ +
  // built-in. См. electron/ai/skills/loader.ts. Конфиг сервера читается из
  // settings (URL можно сменить через UI). Refresh при старте — async,
  // не блокирует window open.
  const skillRegistry = createSkillRegistry(() => ({
    serverBase: settings.getSecret('skills_server_base')
  }))
  void skillRegistry.refresh().catch(err => {
    console.warn('[skills] initial refresh failed:', err instanceof Error ? err.message : err)
  })

  registerProjectIpc(projects, db)
  registerFilesIpc({ getProjectRoot: getActiveProjectPath })
  registerSettingsIpc(settings)
  registerCliAuthIpc(settings)
  registerAiIpc({
    getSecret,
    getProviderId,
    getProviderModel,
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
    saveMemory: (projectPath, type, content, tags) => {
      return saveMemory(db, projectPath, type as import('./storage/memories').MemoryType, content, tags)
    },
    searchMemories: (projectPath, query, limit) => {
      return searchMemories(db, projectPath, query, limit)
    },
    searchConversations: (projectPath, query, limit) => {
      return searchConversations(db, projectPath, query, limit)
    },
    connectors: {
      list: () => connectorRegistry.list().map(c => ({ ...c })),
      query: (id, args, signal) => connectorRegistry.query(id, args, {
        getSecret: (k) => settings.getSecret(k),
        signal
      })
    },
    getAgentMode,
    // Передаём skillRegistry в AI deps чтобы delegate_task tool мог
    // подтянуть system prompt sub-skill'а. Без этого delegate_task
    // работает с generic промптом.
    skillRegistry: {
      list: () => skillRegistry.list().map(s => ({
        id: s.id,
        name: s.name,
        default_provider: s.default_provider,
        default_model: s.default_model ?? undefined,
        systemPrompt: s.systemPrompt
      }))
    },
    // MCP client — внешние инструменты через Model Context Protocol
    mcpClient,
    // Процедурная память — детектирует паттерны решения задач
    trackToolPattern: (projectPath, event) => {
      trackToolForPatterns(db, projectPath, event)
    },
    // Audit log — пишем каждое агентное действие
    appendAudit: (projectPath, chatId, action, detail, providerId, model, runId) => {
      appendAudit(db, { timestamp: Date.now(), projectPath, chatId, action, detail, providerId, model, runId })
    },
    // Debug Packet — снапшот реального входа run'а (provider/model/system/user)
    saveRunInput: (input) => {
      saveRunInput(db, input)
    }
  })
  registerChatsIpc(chats, chatSessions, db)
  registerHandoffIpc(chats, chatSessions)
  registerTasksIpc(tasks)
  registerJournalIpc(journal)
  registerUndoIpc(undoStack)
  registerPlansIpc(plans)
  registerFeedbackIpc(feedback)
  registerVerifyIpc(getActiveProjectPath)
  registerAutonomousIpc({
    getSecret,
    getProviderId,
    getProviderModel,
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
  registerSkillsIpc(skillRegistry, { getSecret })
  registerUserProfilesIpc(userProfiles)
  registerMemoryIpc(db)
  registerCommandsIpc()
  registerMcpIpc(settings)
  registerAuditIpc(db)
  registerDebugIpc(db, chats)
  registerSuggestionsIpc(db)
  const mainWindow = createWindow(settings)
  const iconPath = join(HERE, '../../resources/icon.png')
  registerNotifyIpc(() => mainWindow, iconPath)
  bindUiScaleToWindow(mainWindow, settings)

  if (!process.env.VITE_DEV_SERVER_URL) {
    // Авто-обновления только в production (не в npm run dev)
    initAutoUpdater(mainWindow)
  }
})
app.on('before-quit', () => { mcpClient.disconnectAll() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
