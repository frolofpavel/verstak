import { Suspense, lazy, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { I18nContext, getTranslations, type Lang } from './i18n'
import { ProjectRail } from './components/ProjectRail'

import type { ProjectMeta } from './types/api'
import { Sidebar } from './components/Sidebar'
import { Chat } from './components/Chat'
import { DiffView } from './components/DiffView'
import { CommandConfirm } from './components/CommandConfirm'
import { PlanConfirm } from './components/PlanConfirm'
import { InboxApprovals } from './components/InboxApprovals'

import { UpdateReadyToast } from './components/UpdateReadyToast'
import { WhatsNewModal } from './components/WhatsNewModal'
import { prefetchDetectedClis } from './lib/prefetch-cli'
import { ModelRequiredPrompt } from './components/ModelRequiredPrompt'
import { WindowShell } from './components/TitleBar'
import { ArtifactPreviewContainer } from './components/ArtifactPreview'
import { TerminalErrorToast } from './components/TerminalErrorToast'
import { GlobalTooltipHost } from './components/GlobalTooltipHost'
import { useProject } from './store/projectStore'
import { useActiveChatField } from './hooks/useActiveChatBundle'
import { useSkills as useSkillsStore } from './store/skillStore'
import { readAgentMode, writeAgentMode } from './hooks/useAgentMode'

const AUTH_CACHE_KEY = 'gg.auth_completed'

const AuthScreen = lazy(() => import('./components/AuthScreen').then(m => ({ default: m.AuthScreen })))
const ProjectSettings = lazy(() => import('./components/ProjectSettings').then(m => ({ default: m.ProjectSettings })))
const settingsImport = () => import('./components/Settings')
const Settings = lazy(() => settingsImport().then(m => ({ default: m.Settings })))
const Terminal = lazy(() => import('./components/Terminal').then(m => ({ default: m.Terminal })))
const SideChat = lazy(() => import('./components/SideChat').then(m => ({ default: m.SideChat })))
const FilePreviewPanel = lazy(() => import('./components/FilePreviewPanel').then(m => ({ default: m.FilePreviewPanel })))
const TasksView = lazy(() => import('./components/TasksView').then(m => ({ default: m.TasksView })))
const FilesView = lazy(() => import('./components/FilesView').then(m => ({ default: m.FilesView })))
const JournalView = lazy(() => import('./components/JournalView').then(m => ({ default: m.JournalView })))
const ScheduledTasksView = lazy(() => import('./components/ScheduledTasksView').then(m => ({ default: m.ScheduledTasksView })))
const RemindersView = lazy(() => import('./components/RemindersView').then(m => ({ default: m.RemindersView })))
const PlanView = lazy(() => import('./components/PlanView').then(m => ({ default: m.PlanView })))
const FeedbackView = lazy(() => import('./components/FeedbackView').then(m => ({ default: m.FeedbackView })))
const AgentsPanel = lazy(() => import('./components/AgentsPanel').then(m => ({ default: m.AgentsPanel })))
const AgentRunsPanel = lazy(() => import('./components/AgentRunsPanel').then(m => ({ default: m.AgentRunsPanel })))
const DevTaskPanel = lazy(() => import('./components/DevTaskPanel').then(m => ({ default: m.DevTaskPanel })))
const ProjectMapPanel = lazy(() => import('./components/ProjectMapPanel').then(m => ({ default: m.ProjectMapPanel })))
const DecisionsPanel = lazy(() => import('./components/DecisionsPanel').then(m => ({ default: m.DecisionsPanel })))
const BrainPanel = lazy(() => import('./components/BrainPanel').then(m => ({ default: m.BrainPanel })))
// Браузер монтируется ВСЕГДА (см. PersistentBrowser): его инструменты должны
// работать до открытия вкладки — требование №5/№2 ТЗ. Lazy, чтобы не утяжелять старт;
// всегда-рендер ниже сам подтянет чанк на первом кадре.
const PersistentBrowser = lazy(() => import('./components/PersistentBrowser').then(m => ({ default: m.PersistentBrowser })))
const DesignView = lazy(() => import('./components/DesignView').then(m => ({ default: m.DesignView })))
const SkillsView = lazy(() => import('./components/SkillsView').then(m => ({ default: m.SkillsView })))
const AgentRunInspector = lazy(() => import('./components/AgentRunInspector').then(m => ({ default: m.AgentRunInspector })))
const ProjectRulesView = lazy(() => import('./components/ProjectRulesView').then(m => ({ default: m.ProjectRulesView })))
const MemoryGovernance = lazy(() => import('./components/MemoryGovernance').then(m => ({ default: m.MemoryGovernance })))
const WorkflowView = lazy(() => import('./components/WorkflowView').then(m => ({ default: m.WorkflowView })))
const WorkflowsPanel = lazy(() => import('./components/WorkflowsPanel').then(m => ({ default: m.WorkflowsPanel })))

function ViewFallback() {
  return <div className="gg-view-loading" aria-busy="true" />
}

/** Модальная оболочка настроек — не gg-view-loading в потоке main (серая полоса на полэкрана). */
function SettingsFallback() {
  return (
    <div className="gg-modal-backdrop" aria-busy="true" aria-label="Loading settings">
      <div className="gg-modal gg-modal-large" onClick={e => e.stopPropagation()}>
        <div className="gg-modal-header">
          <div className="gg-boot-line gg-boot-line--short" />
        </div>
        <div className="gg-settings-shell">
          <aside className="gg-settings-nav" aria-hidden />
          <div className="gg-settings-content" aria-hidden />
        </div>
      </div>
    </div>
  )
}

const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 480
const SIDEBAR_DEFAULT = 260
const SIDEBAR_WIDTH_KEY = 'gg.sidebarWidth'
const SIDEBAR_OPEN_KEY = 'gg-sidebar-open'
const SIDECHAT_MIN = 360
const SIDECHAT_MAX = 760
const SIDECHAT_DEFAULT = 460
const SIDECHAT_WIDTH_KEY = 'gg.sideChatWidth'

function readSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

function readSideChatWidth(): number {
  try {
    const stored = parseInt(localStorage.getItem(SIDECHAT_WIDTH_KEY) || '0', 10)
    return stored >= SIDECHAT_MIN && stored <= SIDECHAT_MAX ? stored : SIDECHAT_DEFAULT
  } catch {
    return SIDECHAT_DEFAULT
  }
}

export function App() {
  const [showSettings, setShowSettings] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<'models' | undefined>()
  const [modelPromptRecheck, setModelPromptRecheck] = useState(0)
  const [projectSettingsTarget, setProjectSettingsTarget] = useState<ProjectMeta | null>(null)
  // Right docked panel: terminal, file preview or parallel side-chat.
  const [rightPanel, setRightPanel] = useState<'none' | 'terminal' | 'sidechat' | 'file-preview'>('none')
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null)
  // Side-chat session id — created on first sent message, not on panel open.
  const [sideChatId, setSideChatId] = useState<number | null>(null)
  const [sideChatWidth, setSideChatWidth] = useState<number>(readSideChatWidth)
  const sideChatByProjectRef = useRef<Record<string, number | null>>({})
  const sideChatResizeRef = useRef<{ startX: number; startW: number; lastW: number } | null>(null)
  const mobileRunIdsRef = useRef<Set<number>>(new Set())
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpen)
  const [lang, setLang] = useState<Lang>('ru')

  useEffect(() => window.api.mobile.onRunRequest(payload => {
    void (async () => {
      try {
        const stored = await window.api.chats.list(payload.chatId)
        const messages = stored.map(message => ({ role: message.role, content: message.content }))
        const sendId = await window.api.ai.send(messages, payload.projectPath, String(payload.chatId))
        mobileRunIdsRef.current.add(sendId)
        await window.api.mobile.completeRunRequest(payload.requestId, sendId)
      } catch (error) {
        await window.api.mobile.completeRunRequest(payload.requestId, 0, error instanceof Error ? error.message : 'Не удалось запустить задачу')
      }
    })()
  }), [])

  useEffect(() => window.api.ai.onEvent(({ id, event }) => {
    if (!mobileRunIdsRef.current.has(id)) return
    void window.api.mobile.sendRunEvent(id, event).catch(() => {})
    if (event.type === 'done' || event.type === 'error') mobileRunIdsRef.current.delete(id)
  }), [])

  useEffect(() => {
    window.api.settings.getKey('app_language').then(v => {
      if (v === 'ru' || v === 'en') setLang(v)
    }).catch(() => {})
  }, [])

  const t = getTranslations(lang)

  function openSettings(tab?: 'models') {
    if (tab) setSettingsInitialTab(tab)
    void settingsImport()
    setShowSettings(true)
  }

  // ── Auth gate: null = загрузка, false = нужна авторизация, true = готово ──
  const [authDone, setAuthDone] = useState<boolean | null>(() => {
    try {
      return localStorage.getItem(AUTH_CACHE_KEY) === '1' ? true : null
    } catch {
      return null
    }
  })
  useEffect(() => {
    let cancelled = false
    const timeout = window.setTimeout(() => {
      if (!cancelled) setAuthDone(prev => (prev === null ? false : prev))
    }, 8000)

    void (async () => {
      try {
        const [authVal, profiles] = await Promise.all([
          window.api.settings.getKey('auth_completed'),
          window.api.userProfiles.list(),
        ])
        if (cancelled) return
        if (authVal === 'true') {
          try { localStorage.setItem(AUTH_CACHE_KEY, '1') } catch { /* ignore */ }
          setAuthDone(true)
        } else if (profiles.length === 1) {
          await window.api.userProfiles.setActive(profiles[0].id)
          await window.api.settings.setKey('auth_completed', 'true')
          try { localStorage.setItem(AUTH_CACHE_KEY, '1') } catch { /* ignore */ }
          setAuthDone(true)
        } else {
          try { localStorage.removeItem(AUTH_CACHE_KEY) } catch { /* ignore */ }
          setAuthDone(false)
        }
      } catch {
        if (cancelled) return
        try { localStorage.removeItem(AUTH_CACHE_KEY) } catch { /* ignore */ }
        setAuthDone(false)
      }
    })()

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [])

  useEffect(() => {
    if (!authDone) return
    void prefetchDetectedClis()
    void settingsImport()
  }, [authDone])
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const stored = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) || '0', 10)
    return stored >= SIDEBAR_MIN && stored <= SIDEBAR_MAX ? stored : SIDEBAR_DEFAULT
  })
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const { path, activeView, setActiveView, setStreaming, clearPendingWrites, setPendingCommand, dismissAllPendingPlans, setProject } = useProject(useShallow(s => ({
    path: s.path,
    activeView: s.activeView,
    setActiveView: s.setActiveView,
    setStreaming: s.setStreaming,
    clearPendingWrites: s.clearPendingWrites,
    setPendingCommand: s.setPendingCommand,
    dismissAllPendingPlans: s.dismissAllPendingPlans,
    setProject: s.setProject,
  })))
  const isStreaming = useActiveChatField('isStreaming') ?? false
  const chatSessions = useProject(s => s.chatSessions)

  useEffect(() => {
    if (!authDone) return
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const offProject = window.api.notify.onOpenProject((projectPath) => {
      if (!projectPath) return
      if (path && norm(path) === norm(projectPath)) return
      void setProject(projectPath)
    })
    const offHelp = window.api.notify.onOpenHelp(() => {
      void useProject.getState().openHelpChat()
    })
    const offReminders = window.api.notify.onOpenReminders((projectPath) => {
      void (async () => {
        if (projectPath && (!path || norm(path) !== norm(projectPath))) {
          await setProject(projectPath)
        }
        useProject.getState().setActiveView('reminders')
      })()
    })
    const offChat = window.api.notify.onOpenChat(({ projectPath, chatId }) => {
      void (async () => {
        if (!chatId) return
        if (projectPath && (!path || norm(path) !== norm(projectPath))) {
          await setProject(projectPath)
        }
        const store = useProject.getState()
        if (!store.chatSessions.some(c => c.id === chatId)) {
          await store.refreshChatSessions()
        }
        await useProject.getState().switchChatSession(chatId)
        useProject.getState().setActiveView('chat')
      })()
    })
    return () => {
      offProject()
      offHelp()
      offReminders()
      offChat()
    }
  }, [authDone, path, setProject])
  // Panels require an open project (the terminal/file tree are project-scoped).
  const effectiveRightPanel = path ? rightPanel : 'none'

  function rememberSideChatId(id: number | null) {
    if (path) sideChatByProjectRef.current[path] = id
    setSideChatId(id)
  }

  // Chat sessions are project-scoped; remember the selected right-dock chat per project.
  useEffect(() => {
    if (!path) {
      setSideChatId(null)
      setPreviewFilePath(null)
      setRightPanel(p => (p === 'sidechat' || p === 'file-preview' ? 'none' : p))
      return
    }
    const saved = sideChatByProjectRef.current[path] ?? null
    setSideChatId(saved && chatSessions.some(c => c.id === saved) ? saved : null)
  }, [path, chatSessions])

  function openSideChat() {
    if (!path) return
    const saved = sideChatByProjectRef.current[path] ?? null
    if (saved && useProject.getState().chatSessions.some(c => c.id === saved)) {
      setSideChatId(saved)
    }
    setRightPanel('sidechat')
  }

  function openFilePreview(filePath: string) {
    if (!path) return
    setPreviewFilePath(filePath)
    setRightPanel('file-preview')
  }

  function startSideChatResize(e: ReactMouseEvent<HTMLDivElement>) {
    e.preventDefault()
    sideChatResizeRef.current = { startX: e.clientX, startW: sideChatWidth, lastW: sideChatWidth }
    document.body.classList.add('gg-resizing-sidechat')
  }

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const drag = sideChatResizeRef.current
      if (!drag) return
      const next = Math.max(SIDECHAT_MIN, Math.min(SIDECHAT_MAX, drag.startW + (drag.startX - e.clientX)))
      drag.lastW = next
      setSideChatWidth(next)
    }
    function onUp() {
      const drag = sideChatResizeRef.current
      if (!drag) return
      sideChatResizeRef.current = null
      document.body.classList.remove('gg-resizing-sidechat')
      try { localStorage.setItem(SIDECHAT_WIDTH_KEY, String(drag.lastW)) } catch { /* ignore */ }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('gg-resizing-sidechat')
    }
  }, [])

  // Ctrl/Cmd+B toggles the project sidebar; Esc cancels active stream (safety
  // net — if the UI ever feels stuck during a long agentic loop, Esc kills it).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'b' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        setSidebarOpen(v => !v)
      } else if (e.key === 'Tab' && e.shiftKey && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        // Shift+Tab — cycle через agent mode (как в Claude Code). Игнорируем
        // когда фокус в input/textarea (там Shift+Tab — обычная навигация).
        // В справке режим зафиксирован на «План» — не переключаем глобально.
        if (useProject.getState().helpMode) return
        e.preventDefault()
        const modes: Array<'ask' | 'accept-edits' | 'plan' | 'auto' | 'bypass'> = ['ask', 'accept-edits', 'plan', 'auto', 'bypass']
        void (async () => {
          const state = useProject.getState()
          const current = await readAgentMode(state.activeChatId, state.helpMode)
          const idx = modes.indexOf(current ?? 'ask')
          const next = modes[(idx + 1) % modes.length]
          await writeAgentMode(state.activeChatId, state.helpMode, next)
        })()
      } else if (e.key === 'Escape' && e.shiftKey) {
        // Shift+Esc = emergency abort. Tell main to kill every active stream
        // and clear any pending confirmations, then reset renderer state so
        // the UI never sticks in a stuck-streaming state.
        e.preventDefault()
        void window.api.ai.stop(0).catch(() => {})
        setStreaming(false)
        clearPendingWrites()
        setPendingCommand(null)
        // §10 хвост: аварийный выход снимает карточки планов ВМЕСТЕ с
        // освобождением удержанных чекпойнтов — решения не будет, а снапшоты
        // истории иначе оставались бы в БД навсегда.
        dismissAllPendingPlans()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isStreaming, setStreaming, clearPendingWrites, setPendingCommand, dismissAllPendingPlans])

  // Mouse-drag resize handle on the sidebar's right edge.
  function startDrag(e: React.MouseEvent) {
    dragRef.current = { startX: e.clientX, startW: sidebarWidth }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    // Track the latest value the drag computed so we can persist it on `up`
    // without depending on React state flushing in time.
    let latest = dragRef.current.startW
    function move(ev: MouseEvent) {
      if (!dragRef.current) return
      const dx = ev.clientX - dragRef.current.startX
      latest = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, dragRef.current.startW + dx))
      setSidebarWidth(latest)
    }
    function up() {
      dragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      // Persist directly from the most recent move's value — no DOM read,
      // no race with React's flush.
      try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(latest))) } catch { /* private mode */ }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // Push width to CSS via custom property so the grid recomputes.
  useEffect(() => {
    document.documentElement.style.setProperty('--gg-sidebar-target-w', `${sidebarWidth}px`)
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth)) } catch { /* ignore */ }
  }, [sidebarWidth])

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_OPEN_KEY, sidebarOpen ? '1' : '0')
    } catch { /* ignore */ }
  }, [sidebarOpen])

  if (authDone === null) {
    return (
      <I18nContext.Provider value={getTranslations(lang)}>
        <WindowShell>
          <div className="gg-app gg-app-booting" aria-busy="true">
            <div className="gg-boot-rail" />
            <div className="gg-boot-main">
              <div className="gg-boot-line gg-boot-line--wide" />
              <div className="gg-boot-line" />
              <div className="gg-boot-line gg-boot-line--short" />
            </div>
          </div>
        </WindowShell>
      </I18nContext.Provider>
    )
  }
  if (!authDone) return (
    <I18nContext.Provider value={getTranslations(lang)}>
      <WindowShell>
        <Suspense fallback={<div className="gg-app gg-app-booting" aria-busy="true" />}>
          <AuthScreen onComplete={() => {
            try { localStorage.setItem(AUTH_CACHE_KEY, '1') } catch { /* ignore */ }
            setAuthDone(true)
          }} onLangChange={setLang} />
        </Suspense>
      </WindowShell>
    </I18nContext.Provider>
  )

  return (
    <I18nContext.Provider value={getTranslations(lang)}>
    <WindowShell>
    <div className={`gg-app gg-app-atelier ${!sidebarOpen ? 'is-sidebar-collapsed' : ''}`}>
      <ProjectRail
        onOpenProjectSettings={setProjectSettingsTarget}
        onOpenAppSettings={() => openSettings()}
        onOpenHelp={() => void useProject.getState().openHelpChat()}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(v => !v)}
      />
      <Sidebar
        onOpenSettings={() => openSettings()}
        aria-hidden={!sidebarOpen}
      />
      <div
        className="gg-sidebar-resize"
        onMouseDown={sidebarOpen ? startDrag : undefined}
        title={t.settings.resizeDrag}
        aria-hidden={!sidebarOpen}
      />
      <main className="gg-main">
        {/* Chat НЕ размонтируется при уходе на другие вкладки — иначе его
            слушатель ai:event отваливается и фоновый стрим (CLI вроде Codex)
            теряет ответ. Прячем через display:none, слушатель остаётся жив. */}
        <div className="gg-chat-area" style={activeView === 'chat' ? undefined : { display: 'none' }}>
            <Chat
              onOpenSettings={() => openSettings()}
              rightPanel={effectiveRightPanel}
              onSelectRightPanel={setRightPanel}
              isSettingsOpen={showSettings}
              onOpenSideChat={() => void openSideChat()}
              onOpenFilePreview={openFilePreview}
            />
            {effectiveRightPanel === 'terminal' && (
              <div className="gg-terminal-wrap">
                <div className="gg-terminal-header">
                  <span className="gg-terminal-dot" />
                  <span>{t.views.terminal}</span>
                  <button
                    className="gg-terminal-close"
                    onClick={() => setRightPanel('none')}
                    title={t.views.hide}
                  >×</button>
                </div>
                <div className="gg-terminal-body">
                  <Suspense fallback={<ViewFallback />}>
                    <Terminal />
                  </Suspense>
                </div>
              </div>
            )}
            {effectiveRightPanel === 'sidechat' && (
              <Suspense fallback={<ViewFallback />}>
                <SideChat
                  sideChatId={sideChatId}
                  width={sideChatWidth}
                  onResizeStart={startSideChatResize}
                  onSessionCreated={rememberSideChatId}
                  onSessionSelected={rememberSideChatId}
                  onClose={() => setRightPanel('none')}
                />
              </Suspense>
            )}
            {effectiveRightPanel === 'file-preview' && (
              <Suspense fallback={<ViewFallback />}>
                <FilePreviewPanel
                  path={previewFilePath}
                  width={sideChatWidth}
                  onResizeStart={startSideChatResize}
                  onClose={() => setRightPanel('none')}
                />
              </Suspense>
            )}
        </div>
        {activeView === 'tasks' && <Suspense fallback={<ViewFallback />}><TasksView /></Suspense>}
        {activeView === 'journal' && <Suspense fallback={<ViewFallback />}><JournalView /></Suspense>}
        {activeView === 'reminders' && <Suspense fallback={<ViewFallback />}><RemindersView /></Suspense>}
        {activeView === 'inspector' && (
          <Suspense fallback={<ViewFallback />}><AgentRunInspector /></Suspense>
        )}
        {activeView === 'project-rules' && (
          <Suspense fallback={<ViewFallback />}><ProjectRulesView /></Suspense>
        )}
        {activeView === 'agents' && <Suspense fallback={<ViewFallback />}><AgentsPanel /></Suspense>}
        {activeView === 'tasks-manager' && <Suspense fallback={<ViewFallback />}><AgentRunsPanel /></Suspense>}
        {activeView === 'task' && <Suspense fallback={<ViewFallback />}><DevTaskPanel /></Suspense>}
        {activeView === 'project-map' && <Suspense fallback={<ViewFallback />}><ProjectMapPanel /></Suspense>}
        {activeView === 'decisions' && <Suspense fallback={<ViewFallback />}><DecisionsPanel /></Suspense>}
        {activeView === 'brain' && <Suspense fallback={<ViewFallback />}><BrainPanel /></Suspense>}
        {activeView === 'files' && <Suspense fallback={<ViewFallback />}><FilesView /></Suspense>}
        {activeView === 'memory-gov' && (
          <Suspense fallback={<ViewFallback />}><MemoryGovernance /></Suspense>
        )}
        {activeView === 'plan' && <Suspense fallback={<ViewFallback />}><PlanView /></Suspense>}
        {activeView === 'scheduler' && <Suspense fallback={<ViewFallback />}><ScheduledTasksView /></Suspense>}
        {activeView === 'workflow' && (
          <div className="gg-workflow-scroll">
            <Suspense fallback={<ViewFallback />}>
              <WorkflowsPanel />
              <WorkflowView />
            </Suspense>
          </div>
        )}
        {activeView === 'feedback' && <Suspense fallback={<ViewFallback />}><FeedbackView /></Suspense>}
        {/* Браузер рендерится БЕЗУСЛОВНО и скрыт, когда его вкладка не выбрана, —
            иначе window.verstakBrowser нет и browser_navigate падает «вкладка не
            открыта», пока человек сам не откроет вкладку. fallback=null: пока чанк
            грузится, слот невидим и не мигает поверх активной вкладки. */}
        <Suspense fallback={null}>
          <PersistentBrowser active={activeView === 'browser'} />
        </Suspense>
        {activeView === 'skills' && (
          <Suspense fallback={<ViewFallback />}>
          <SkillsView
            onActivateSkill={slash => {
              const skills = useSkillsStore.getState().skills
              const skill = skills.find(s => s.slash === slash || s.id === slash)
              useSkillsStore.getState().queueDraftSkill(skill?.id ?? slash)
              if (!skill) void useSkillsStore.getState().refresh().catch(() => {})
              setActiveView('chat')
            }}
          />
          </Suspense>
        )}
        {activeView === 'design' && (
          <Suspense fallback={<ViewFallback />}>
            <DesignView onGoToChat={() => setActiveView('chat')} />
          </Suspense>
        )}
      </main>
      {showSettings && (
        <Suspense fallback={<SettingsFallback />}>
          <Settings
            initialTab={settingsInitialTab}
            onClose={() => {
              setShowSettings(false)
              setSettingsInitialTab(undefined)
              setModelPromptRecheck(v => v + 1)
            }}
          />
        </Suspense>
      )}
      <ModelRequiredPrompt
        active={authDone === true && !showSettings}
        recheckToken={modelPromptRecheck}
        onOpenModelsSettings={() => {
          openSettings('models')
        }}
      />
      {projectSettingsTarget && (
        <Suspense fallback={<SettingsFallback />}>
          <ProjectSettings
            project={projectSettingsTarget}
            onClose={() => setProjectSettingsTarget(null)}
            onProjectUpdated={setProjectSettingsTarget}
          />
        </Suspense>
      )}

      <ArtifactPreviewContainer />
      <TerminalErrorToast />
      <DiffView />
      <CommandConfirm />
      <PlanConfirm />
      <InboxApprovals />
      <UpdateReadyToast />
      <WhatsNewModal />
      <GlobalTooltipHost />

    </div>
    </WindowShell>
    </I18nContext.Provider>
  )
}
