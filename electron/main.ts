import { app, BrowserWindow, safeStorage, session, dialog, protocol, net, Menu } from 'electron'
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
import { registerProjectMapIpc } from './ipc/project-map'
import { registerFilesIpc } from './ipc/files'
import { registerTasksIpc } from './ipc/tasks'
import { registerJournalIpc } from './ipc/journal'
import { getActiveProjectPath } from './state/project-state'
import { registerSettingsIpc } from './ipc/settings'
import { registerCliAuthIpc } from './ipc/cli-auth'
import { registerAiIpc, abortSend } from './ipc/ai'
import { registerChatsIpc } from './ipc/chats'
import { registerHandoffIpc } from './ipc/handoff'
import { registerTerminalIpc } from './ipc/terminal'
import {
  APP_DISPLAY_NAME,
  bindMainWindowLifecycle,
  installAppIdentity,
  installGlobalQuitHandlers
} from './app-lifecycle'
import { openDb } from './storage/db'
import { createSettings } from './storage/settings'
import { createChats } from './storage/chats'
import { createChatSessions } from './storage/chat-sessions'
import { createSubSessions } from './storage/sub-sessions'
import { createSessionTodos } from './storage/session-todos'
import { createAgentRuns } from './storage/agent-runs'
import { createVerifications } from './storage/verifications'
import { createDevTasks } from './storage/dev-tasks'
import { registerGitIpc } from './ipc/git'
import { registerDevTaskIpc, isActiveDevTask } from './ipc/dev-task'
import { registerAgentsIpc } from './ipc/agents'
import { registerAgentRunsIpc } from './ipc/agent-runs'
import { registerVerificationsIpc } from './ipc/verifications'
import { createTasks } from './storage/tasks'
import { createJournal } from './storage/journal'
import { createProjects } from './storage/projects'
import { createProjectGroups } from './storage/project-groups'
import { createUndoStack } from './storage/undo'
import { registerUndoIpc } from './ipc/undo'
import { createPlans } from './storage/plans'
import { registerPlansIpc } from './ipc/plans'
import { registerWorkflowsIpc } from './ipc/workflows'
import { createFeedback } from './storage/feedback'
import { registerFeedbackIpc } from './ipc/feedback'
import { registerVerifyIpc, execVerifyCommand } from './ipc/verify'
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
import { appendAudit, queryAudit } from './storage/audit-log'
import { registerProofIpc } from './ipc/proof'
import { registerDebugIpc } from './ipc/debug'
import { saveRunInput } from './storage/run-inputs'
import { trackToolForPatterns } from './ai/procedural-memory'
import { registerSuggestionsIpc } from './ipc/suggestions'
import { initAutoUpdater, registerReleaseNotesIpc } from './updater'
import { registerNotifyIpc } from './ipc/notify'
import { bindWindowChromeEvents, registerWindowIpc } from './ipc/window'
import { initNotificationWindow, registerNotificationWindowIpc } from './notification-window'
import { isInsideProjectIcons } from './storage/project-icons'
import { registerVoiceIpc } from './ipc/voice'
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
    title: APP_DISPLAY_NAME,
    icon: iconPath,
    show: false,
    backgroundColor: '#2e3440',
    frame: false,
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
  bindWindowChromeEvents(win)

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
 * Allow microphone access for VoiceInput.
 * Without this Electron silently rejects getUserMedia('audio').
 */
function installMediaPermissions(): void {
  const mediaPermissions = new Set(['media', 'audioCapture', 'videoCapture'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (mediaPermissions.has(permission)) return callback(true)
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return mediaPermissions.has(permission)
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

installAppIdentity()

// Tell Windows this is its own application so the taskbar uses our icon
// (and not the generic Electron / Node icon).
if (process.platform === 'win32') {
  app.setAppUserModelId('ru.verstak.ide')
}

installGlobalQuitHandlers()

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'gg-project-icon',
    privileges: { standard: true, secure: true, supportFetchAPI: true }
  }
])

// Аудит M20 / Rayner: single-instance lock (lock берётся выше, gotSingleInstanceLock).
// Без него вторая копия Verstak на старте прогоняет agentRuns.reconcileStale()
// против той же БД (WAL пускает второй процесс) и помечает ЖИВЫЕ прогоны первой
// копии как failed. Вторая копия — фокусируем существующее окно и выходим.
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return // вторая копия — ранний выход до операций с БД
  Menu.setApplicationMenu(null)
  registerWindowIpc()
  registerNotificationWindowIpc()

  protocol.handle('gg-project-icon', (request) => {
    const prefix = 'gg-project-icon://local/'
    if (!request.url.startsWith(prefix)) return new Response(null, { status: 404 })
    const filePath = decodeURIComponent(request.url.slice(prefix.length))
    // Отдаём ТОЛЬКО файлы из папки project-icons — иначе через этот протокол
    // можно прочитать любой локальный файл (gg-project-icon://local/<любой путь>).
    if (!isInsideProjectIcons(filePath)) return new Response(null, { status: 403 })
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
  const settings = createSettings(db, safeStorage)

  // Затухание памяти — после показа окна, не блокирует старт
  setImmediate(() => {
    try {
      const decayResult = applyMemoryDecay(db)
      if (decayResult.decayed > 0 || decayResult.deleted > 0) {
        console.log(`[memory] decay: ${decayResult.decayed} updated, ${decayResult.deleted} deleted`)
      }
    } catch (err) {
      console.warn('[memory] decay failed:', err instanceof Error ? err.message : err)
    }
  })

  const ENV_MAP: Record<string, string> = {
    gemini_api_key: 'GEMINI_API_KEY',
    anthropic_api_key: 'ANTHROPIC_API_KEY',
    openai_api_key: 'OPENAI_API_KEY',
    groq_api_key: 'GROQ_API_KEY',
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
  const subSessions = createSubSessions(db)
  const sessionTodos = createSessionTodos(db)
  // Multi-agent Manager (Фаза 2) — фундамент «задач» поверх run_id. ai.ts пишет
  // прогоны (create на старте / finish на завершении), панель Задач читает их.
  const agentRuns = createAgentRuns(db)
  // Реконсайл зависших прогонов: строки running/queued без ended_at — это
  // прогоны, прерванные крахом/выходом приложения (без живого процесса).
  // Помечаем их failed один раз на старте, чтобы они не висели «в работе».
  //
  // Crash-resume (P1): метку реконсайла фиксируем ДО reconcileStale, чтобы
  // отличить «прерванные именно этим стартом» от упавших раньше по реальной
  // ошибке. reconcileStale ставит ended_at=now (>= reconciledAt); findResumable
  // отбирает failed-прогоны с ended_at >= этой метки для баннера «сессия
  // прервана». Так Manager-поведение (running→failed) не меняется, а crash-
  // resume получает данные из той же таблицы без in-memory снапшота.
  const agentRunsReconciledAt = Date.now()
  try {
    const staleCount = agentRuns.reconcileStale()
    if (staleCount > 0) console.log(`[agent-runs] reconciled ${staleCount} stale run(s) → failed`)
  } catch (err) {
    console.warn('[agent-runs] reconcileStale failed:', err instanceof Error ? err.message : err)
  }
  // Verification Artifact (Фаза 3) — история DoD поверх файла-артефакта.
  // attest_verification пишет строку, Review подтягивает latest по чату.
  const verifications = createVerifications(db)
  // Dev Task Flow — фасад dev_tasks. Фаза 2: оркестратор open/revert + наблюдение
  // (registerDevTaskIpc ниже) + привязка прогонов к активной задаче чата. git-write
  // (ветки/commit) придёт в Фазах 3-5.
  const devTasks = createDevTasks(db)
  const tasks = createTasks(db)
  const journal = createJournal(db)
  const projects = createProjects(db)
  const projectGroups = createProjectGroups(db)
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

  // knownRoots — корни зарегистрированных проектов + активный путь. Единый
  // источник для всех root-guard'ов (терминал, files, project-map). Активный
  // путь добавляем даже если его нет в list() — как в terminal-фиксе.
  const knownRoots = () => {
    const roots = projects.list().map(p => p.path)
    const active = getActiveProjectPath()
    if (active && !roots.includes(active)) roots.push(active)
    return roots
  }

  // Минимальный IPC для первого кадра UI — окно открываем до тяжёлой регистрации.
  registerSettingsIpc(settings)
  registerCliAuthIpc(settings)
  registerUserProfilesIpc(userProfiles)
  registerProjectIpc(projects, projectGroups, db)
  registerProjectMapIpc(knownRoots)
  registerFilesIpc({ getProjectRoot: getActiveProjectPath, getKnownRoots: knownRoots })
  registerChatsIpc(chats, chatSessions, db)

  const mainWindow = createWindow(settings)
  bindMainWindowLifecycle(mainWindow)
  bindUiScaleToWindow(mainWindow, settings)
  initNotificationWindow(() => mainWindow)

  const registerDeferredIpc = () => {
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
    },
    // Персистентные суб-сессии (Фаза 2) — delegate_* пишут историю субов в БД.
    subSessions: {
      create: (opts) => subSessions.create(opts),
      update: (id, patch) => subSessions.update(id, patch),
      appendMessage: (subSessionId, projectPath, role, content) =>
        chats.appendToSession(subSessionId, projectPath, role, content)
    },
    // TodoGate (Фаза 3) — оркестрационный todo-лист сессии для todo_* / orchestrate.
    sessionTodos: {
      createBatch: (opts) => sessionTodos.createBatch(opts),
      update: (id, patch) => sessionTodos.update(id, patch as { status?: import('./storage/session-todos').TodoStatus; assigneeCallId?: string | null }),
      list: (projectPath, sessionId) => sessionTodos.list(projectPath, sessionId),
      findByTitle: (projectPath, sessionId, title) => sessionTodos.findByTitle(projectPath, sessionId, title)
    },
    // Multi-agent Manager (Фаза 1) — фасад agent_runs прокинут заранее. В ai.ts
    // пока НЕ используется: запись прогонов (create/finish/recordRunEvent) включит
    // Фаза 2. Здесь только делаем фундамент доступным для следующих фаз.
    agentRuns,
    // Verification Artifact (Фаза 3) — attest_verification пишет строку истории
    // после writeVerificationArtifact (best-effort). Только insert нужен в ctx.
    verifications: {
      insert: (row) => verifications.insert(row)
    },
    // Dev Task Flow (Фаза 2) — линкуем прогон к открытой dev_task чата, если
    // такая есть. Берём новейшую активную задачу этого чата (state не
    // committed/cancelled). Best-effort: нет задачи → no-op.
    linkDevTaskRun: (projectPath, chatId, runId) => {
      const active = devTasks.list(projectPath).find(t => t.chatId === chatId && isActiveDevTask(t))
      if (active) devTasks.linkRun(active.id, runId)
    }
  })
  registerAgentsIpc(subSessions, chats, sessionTodos)
  // Вкладка «Задачи» (Multi-agent Manager) — список прогонов + stop/resume (Фаза 4).
  // abortSend переиспользует ядро ai:stop; db — для getRunInput при resume.
  // agentRunsReconciledAt — метка реконсайла этого старта для ai:list-resumable
  // (Crash-resume): findResumable отбирает прогоны, помеченные failed ИМЕННО на
  // этом старте.
  registerAgentRunsIpc(agentRuns, subSessions, sessionTodos, db, abortSend, agentRunsReconciledAt)
  // История Verification Artifact (Фаза 3) — list/latest/get для Review DoD и панели.
  registerVerificationsIpc(verifications)
  // Proof Pack — доказательство выполнения прогона (proof.json + proof.html).
  registerProofIpc({
    agentRuns,
    verifications,
    getProjectRoot: getActiveProjectPath,
    queryAuditForRun: (runId) => queryAudit(db, getActiveProjectPath() ?? '', { runId }).map(a => ({ action: a.action, detail: a.detail, timestamp: a.timestamp }))
  })
  registerHandoffIpc(chats, chatSessions)
  registerTasksIpc(tasks)
  registerJournalIpc(journal)
  registerUndoIpc(undoStack)
  registerPlansIpc(plans)
  registerWorkflowsIpc({
    createPlan: (projectPath, title, steps) => {
      const plan = plans.create(projectPath, title, steps)
      return { id: plan.id }
    }
  })
  registerFeedbackIpc(feedback)
  registerVerifyIpc(getActiveProjectPath)
  // Git READ IPC (Dev Task Flow, Фаза 1) — структурированные status/diff/log.
  // ТОЛЬКО чтение; git-write (ветки/commit) добавит Фаза 3.
  registerGitIpc(getActiveProjectPath)
  // Dev Task Flow IPC (Фазы 2-4) — оркестратор open/openFromPreflight/get/list/
  // linkRun/revert/commit/buildPackage/createPr. Откат переиспользует undoStack
  // (тот же стек, что undo:*); runCheck = execVerifyCommand (денилист внутри);
  // git-write (ветки/commit) через ipc/git helpers (денилист push/force/reset).
  registerDevTaskIpc({
    tasks: devTasks,
    getProjectRoot: getActiveProjectPath,
    undoStack,
    runCheck: (command) => {
      const cwd = getActiveProjectPath()
      if (!cwd) return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'Проект не открыт' })
      return execVerifyCommand(cwd, command)
    },
    connectorQuery: (id, args) => {
      // Аудит B4: даже ручной тест коннектора из Настроек не должен висеть
      // вечно на зависшем хосте — 30с таймаут.
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), 30_000)
      return connectorRegistry.query(id, args, { getSecret: (k) => settings.getSecret(k), signal: ac.signal })
        .finally(() => clearTimeout(t))
    },
    getSecret: (k) => settings.getSecret(k),
    // Ревью F2: DoD-override поверх красных проверок → audit_log.
    recordAudit: (action, detail) => {
      try {
        const projectPath = getActiveProjectPath()
        if (!projectPath) return
        appendAudit(db, { timestamp: Date.now(), projectPath, chatId: null, action, detail, providerId: null, model: null, runId: null })
      } catch { /* audit best-effort */ }
    }
  })
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
  // getKnownRoots — корни проектов пользователя для валидации cwd терминала
  // (см. resolveSafeTerminalCwd). Та же лямбда, что и для files/project-map.
  registerTerminalIpc(knownRoots)
  registerSkillsIpc(skillRegistry, { getSecret })
  registerMemoryIpc(db)
  registerCommandsIpc()
  registerMcpIpc(settings)
  registerAuditIpc(db)
  registerDebugIpc(db, chats)
  registerSuggestionsIpc(db)
  registerReleaseNotesIpc()
  registerVoiceIpc()
  registerNotifyIpc(() => mainWindow, settings)

  if (!process.env.VITE_DEV_SERVER_URL) {
    // Авто-обновления только в production (не в npm run dev)
    initAutoUpdater(mainWindow)
  }
  }

  setImmediate(registerDeferredIpc)
})

