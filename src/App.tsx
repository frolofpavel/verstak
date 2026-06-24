import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { I18nContext, getTranslations, type Lang } from './i18n'
import { ProjectRail } from './components/ProjectRail'

import { ProjectSettings } from './components/ProjectSettings'
import type { ProjectMeta } from './types/api'
import { Sidebar } from './components/Sidebar'
import { Chat } from './components/Chat'
import { TasksView } from './components/TasksView'
import { FilesView } from './components/FilesView'
import { JournalView } from './components/JournalView'
import { RemindersView } from './components/RemindersView'
import { PlanView } from './components/PlanView'
import { FeedbackView } from './components/FeedbackView'
import { StubView } from './components/StubView'
import { AgentsPanel } from './components/AgentsPanel'
import { AgentRunsPanel } from './components/AgentRunsPanel'
import { DevTaskPanel } from './components/DevTaskPanel'
import { ProjectMapPanel } from './components/ProjectMapPanel'
import { DecisionsPanel } from './components/DecisionsPanel'
import { BrainPanel } from './components/BrainPanel'
import { DiffView } from './components/DiffView'
import { CommandConfirm } from './components/CommandConfirm'
import { InboxApprovals } from './components/InboxApprovals'

import { UpdateReadyToast } from './components/UpdateReadyToast'
import { WhatsNewModal } from './components/WhatsNewModal'
import { SideChat } from './components/SideChat'
import { prefetchDetectedClis } from './lib/prefetch-cli'
import { ModelRequiredPrompt } from './components/ModelRequiredPrompt'
import { WindowShell } from './components/TitleBar'
import { ArtifactPreviewContainer } from './components/ArtifactPreview'
import { TerminalErrorToast } from './components/TerminalErrorToast'
import { useProject } from './store/projectStore'
import { useSkills as useSkillsStore } from './store/skillStore'
import { readAgentMode, writeAgentMode } from './hooks/useAgentMode'

const AUTH_CACHE_KEY = 'gg.auth_completed'

const AuthScreen = lazy(() => import('./components/AuthScreen').then(m => ({ default: m.AuthScreen })))
const settingsImport = () => import('./components/Settings')
const Settings = lazy(() => settingsImport().then(m => ({ default: m.Settings })))
const Terminal = lazy(() => import('./components/Terminal').then(m => ({ default: m.Terminal })))
const BrowserView = lazy(() => import('./components/BrowserView').then(m => ({ default: m.BrowserView })))
const DesignView = lazy(() => import('./components/DesignView').then(m => ({ default: m.DesignView })))
const SkillsView = lazy(() => import('./components/SkillsView').then(m => ({ default: m.SkillsView })))
const AgentRunInspector = lazy(() => import('./components/AgentRunInspector').then(m => ({ default: m.AgentRunInspector })))
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

function readSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

export function App() {
  const [showSettings, setShowSettings] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<'models' | undefined>()
  const [modelPromptRecheck, setModelPromptRecheck] = useState(0)
  const [projectSettingsTarget, setProjectSettingsTarget] = useState<ProjectMeta | null>(null)
  // Right docked panel: terminal or parallel side-chat.
  const [rightPanel, setRightPanel] = useState<'none' | 'terminal' | 'sidechat'>('none')
  // Side-chat session id — created on first sent message, not on panel open.
  const [sideChatId, setSideChatId] = useState<number | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpen)
  const [lang, setLang] = useState<Lang>('ru')

  useEffect(() => {
    window.api.settings.getKey('app_language').then(v => {
      if (v === 'ru' || v === 'en') setLang(v)
    }).catch(() => {})
  }, [])

  const t = getTranslations(lang)

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
  const { path, activeView, setActiveView, isStreaming, setStreaming, clearPendingWrites, setPendingCommand, setProject } = useProject()

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

  // Project switch invalidates the side-chat session (chat sessions are
  // project-scoped). Drop the id and close the panel if it was open.
  useEffect(() => {
    setSideChatId(null)
    setRightPanel(p => (p === 'sidechat' ? 'none' : p))
  }, [path])

  function openSideChat() {
    if (!path) return
    setRightPanel('sidechat')
  }

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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isStreaming, setStreaming, clearPendingWrites, setPendingCommand])

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
        onOpenAppSettings={() => setShowSettings(true)}
        onOpenHelp={() => void useProject.getState().openHelpChat()}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(v => !v)}
      />
      <Sidebar
        onOpenSettings={() => setShowSettings(true)}
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
              onOpenSettings={() => setShowSettings(true)}
              rightPanel={effectiveRightPanel}
              onSelectRightPanel={setRightPanel}
              onOpenSideChat={() => void openSideChat()}
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
              <SideChat
                sideChatId={sideChatId}
                onSessionCreated={setSideChatId}
                onClose={() => setRightPanel('none')}
              />
            )}
        </div>
        {activeView === 'tasks' && <TasksView />}
        {activeView === 'journal' && <JournalView />}
        {activeView === 'reminders' && <RemindersView />}
        {activeView === 'inspector' && (
          <Suspense fallback={<ViewFallback />}><AgentRunInspector /></Suspense>
        )}
        {activeView === 'agents' && <AgentsPanel />}
        {activeView === 'tasks-manager' && <AgentRunsPanel />}
        {activeView === 'task' && <DevTaskPanel />}
        {activeView === 'project-map' && <ProjectMapPanel />}
        {activeView === 'decisions' && <DecisionsPanel />}
        {activeView === 'brain' && <BrainPanel />}
        {activeView === 'files' && <FilesView />}
        {activeView === 'memory-gov' && (
          <Suspense fallback={<ViewFallback />}><MemoryGovernance /></Suspense>
        )}
        {activeView === 'plan' && <PlanView />}
        {activeView === 'workflow' && (
          <div className="gg-workflow-scroll">
            <Suspense fallback={<ViewFallback />}>
              <WorkflowsPanel />
              <WorkflowView />
            </Suspense>
          </div>
        )}
        {activeView === 'calendar' && <StubView title="Calendar" description="Здесь будут события и дедлайны проекта. В работе." />}
        {activeView === 'feedback' && <FeedbackView />}
        {activeView === 'browser' && (
          <Suspense fallback={<ViewFallback />}><BrowserView /></Suspense>
        )}
        {activeView === 'skills' && (
          <Suspense fallback={<ViewFallback />}>
          <SkillsView
            onActivateSkill={slash => {
              // Активируем скилл по slash-имени, затем переходим в чат
              const skills = useSkillsStore.getState().skills
              const skill = skills.find(s => s.slash === slash || s.id === slash)
              if (skill) useSkillsStore.getState().setActiveSkill(skill.id)
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
        {activeView === 'video' && (
          <div className="gg-view-placeholder">
            <div className="gg-view-placeholder-icon">🎬</div>
            <h2>{t.views.videoTitle}</h2>
            <p>{t.views.videoDesc}</p>
            <p className="gg-view-placeholder-hint">{t.views.videoHint}</p>
            <div className="gg-view-placeholder-actions">
              <button onClick={() => setActiveView('chat')}>{t.views.videoCreate}</button>
            </div>
          </div>
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
          setSettingsInitialTab('models')
          setShowSettings(true)
        }}
      />
      {projectSettingsTarget && (
        <ProjectSettings
          project={projectSettingsTarget}
          onClose={() => setProjectSettingsTarget(null)}
          onProjectUpdated={setProjectSettingsTarget}
        />
      )}

      <ArtifactPreviewContainer />
      <TerminalErrorToast />
      <DiffView />
      <CommandConfirm />
      <InboxApprovals />
      <UpdateReadyToast />
      <WhatsNewModal />

    </div>
    </WindowShell>
    </I18nContext.Provider>
  )
}
