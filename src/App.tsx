import { useEffect, useRef, useState } from 'react'
import { ProjectRail } from './components/ProjectRail'
import { Sidebar } from './components/Sidebar'
import { Settings } from './components/Settings'
import { Chat } from './components/Chat'
import { TasksView } from './components/TasksView'
import { JournalView } from './components/JournalView'
import { PlanView } from './components/PlanView'
import { FeedbackView } from './components/FeedbackView'
import { BrowserView } from './components/BrowserView'
import { StubView } from './components/StubView'
import { DiffView } from './components/DiffView'
import { CommandConfirm } from './components/CommandConfirm'
import { Terminal } from './components/Terminal'
import { OnboardingWizard } from './components/OnboardingWizard'
import { useProject } from './store/projectStore'

const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 480
const SIDEBAR_DEFAULT = 260
const SIDEBAR_WIDTH_KEY = 'gg.sidebarWidth'

export function App() {
  const [showSettings, setShowSettings] = useState(false)
  const [showTerminal, setShowTerminal] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  // Onboarding: показывается при первом запуске пока не помечен completed
  // в settings. После — больше не появляется.
  const [showOnboarding, setShowOnboarding] = useState(false)
  useEffect(() => {
    void (async () => {
      try {
        const done = await window.api.settings.getKey('onboarding_completed')
        if (!done) setShowOnboarding(true)
      } catch { /* первый запуск, settings ещё нет */ setShowOnboarding(true) }
    })()
  }, [])
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const stored = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) || '0', 10)
    return stored >= SIDEBAR_MIN && stored <= SIDEBAR_MAX ? stored : SIDEBAR_DEFAULT
  })
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const { path, activeView, isStreaming, setStreaming, clearPendingWrites, setPendingCommand } = useProject()
  const canShowTerminal = path && showTerminal

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
        e.preventDefault()
        const modes: Array<'ask' | 'accept-edits' | 'plan' | 'auto' | 'bypass'> = ['ask', 'accept-edits', 'plan', 'auto', 'bypass']
        void (async () => {
          const current = (await window.api.settings.getKey('agent_mode')) as typeof modes[number] | null
          const idx = modes.indexOf(current ?? 'ask')
          const next = modes[(idx + 1) % modes.length]
          await window.api.settings.setKey('agent_mode', next)
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
    document.documentElement.style.setProperty('--gg-sidebar-w', `${sidebarWidth}px`)
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth)) } catch { /* ignore */ }
  }, [sidebarWidth])

  return (
    <div className={`gg-app ${sidebarOpen ? '' : 'is-sidebar-collapsed'}`}>
      <ProjectRail
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(v => !v)}
      />
      {sidebarOpen && (
        <>
          <Sidebar onOpenSettings={() => setShowSettings(true)} />
          <div
            className="gg-sidebar-resize"
            onMouseDown={startDrag}
            title="Перетащи чтобы изменить ширину"
          />
        </>
      )}
      <main className="gg-main">
        {activeView === 'chat' && (
          <Chat
            onOpenSettings={() => setShowSettings(true)}
            onToggleTerminal={() => setShowTerminal(t => !t)}
            terminalOpen={showTerminal}
          />
        )}
        {activeView === 'tasks' && <TasksView />}
        {activeView === 'journal' && <JournalView />}
        {activeView === 'plan' && <PlanView />}
        {activeView === 'workflow' && <StubView title="Workflow" description="Здесь будут пайплайны и цепочки агентов. В работе." />}
        {activeView === 'calendar' && <StubView title="Calendar" description="Здесь будут события и дедлайны проекта. В работе." />}
        {activeView === 'feedback' && <FeedbackView />}
        {activeView === 'browser' && <BrowserView />}
        {activeView === 'chat' && canShowTerminal && (
          <div className="gg-terminal-wrap">
            <div className="gg-terminal-header">
              <span className="gg-terminal-dot" />
              <span>Терминал</span>
              <button
                className="gg-terminal-close"
                onClick={() => setShowTerminal(false)}
                title="Скрыть"
              >×</button>
            </div>
            <div className="gg-terminal-body">
              <Terminal />
            </div>
          </div>
        )}
      </main>
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
      {showOnboarding && <OnboardingWizard onComplete={() => setShowOnboarding(false)} />}
      <DiffView />
      <CommandConfirm />
    </div>
  )
}
