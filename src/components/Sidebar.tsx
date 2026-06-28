import { useEffect, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useProject, type ViewId } from '../store/projectStore'
import { ModelPicker } from './ModelPicker'
import { CreateClientModal } from './CreateClientModal'
import { useT } from '../i18n'


type ChatContextMenuState = { x: number; y: number; id: number; title: string }

const CHAT_MENU_W = 168
const CHAT_MENU_H = 76

function clampChatMenuPos(x: number, y: number): { left: number; top: number } {
  const pad = 8
  const maxX = Math.max(pad, window.innerWidth - CHAT_MENU_W - pad)
  const maxY = Math.max(pad, window.innerHeight - CHAT_MENU_H - pad)
  return { left: Math.min(Math.max(pad, x), maxX), top: Math.min(Math.max(pad, y), maxY) }
}

function ChatNavSection() {
  const t = useT()
  const { path, chatSessions, activeChatId, activeView, setActiveView, switchChatSession, newChatSession, forkChat, refreshChatSessions, chatSnapshots, patchChatSession, cleanupReviewsFor } = useProject()
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [contextMenu, setContextMenu] = useState<ChatContextMenuState | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const editInputRef = useRef<HTMLInputElement | null>(null)
  const editOriginalRef = useRef('')

  const isActiveSection = activeView === 'chat'

  useEffect(() => {
    setOpen(false)
  }, [path])

  useEffect(() => {
    if (!open && editingId != null) void commitEdit()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- commit on collapse only
  }, [open])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return
      close()
    }
    // Откладываем listener — иначе тот же ПКМ, что открыл меню, сразу его закрывает.
    const timer = window.setTimeout(() => {
      window.addEventListener('pointerdown', onPointerDown, true)
    }, 0)
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [contextMenu])

  function focusEditInput() {
    requestAnimationFrame(() => {
      const el = editInputRef.current
      if (!el) return
      el.focus()
      el.select()
    })
  }

  function startEdit(id: number, currentTitle: string) {
    editOriginalRef.current = currentTitle
    setEditingId(id)
    setEditTitle(currentTitle)
    focusEditInput()
  }

  function cancelEdit() {
    setEditingId(null)
    setEditTitle('')
    editOriginalRef.current = ''
  }

  async function commitEdit() {
    if (editingId == null) return
    const nextTitle = editTitle.trim()
    const idToEdit = editingId
    const original = editOriginalRef.current
    cancelEdit()
    if (!nextTitle || nextTitle === original) return
    patchChatSession(idToEdit, { title: nextTitle })
    try {
      await window.api.chatSessions.rename(idToEdit, nextTitle)
    } catch (err) {
      console.error('[Sidebar] rename failed, reverting:', err)
      await refreshChatSessions()
    }
  }
  function openContextMenu(e: MouseEvent, id: number, title: string) {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, id, title })
  }

  async function removeSession(id: number, title: string) {
    const msg = t.sidebar.deleteChatConfirm.replace('{title}', title)
    if (!window.confirm(msg)) return
    await window.api.chatSessions.remove(id)
    // Grok audit fix: каскадное удаление review-чатов в БД работало, но в
    // store оставались stale entries и openedReviewId мог указывать на
    // удалённый ревью. Чистим in-memory state синхронно.
    cleanupReviewsFor(id)
    await refreshChatSessions()
    // If we deleted the active one, switch to the most recent remaining or create a new one
    const fresh = useProject.getState().chatSessions
    if (fresh.length > 0) {
      await switchChatSession(fresh[0].id)
    } else {
      await newChatSession()
    }
  }

  return (
    <>
      <div className="gg-chat-nav-head">
        <button
          className={`gg-nav-item ${isActiveSection ? 'is-active' : ''}`}
          onClick={() => setActiveView('chat')}
          style={{ flex: 1 }}
        >
          <span className="gg-nav-icon"><ChatIconNode /></span>
          <span className="gg-nav-label">{t.sidebar.chat}</span>
          <span className="gg-nav-badge" style={{ background: 'transparent', border: 'none', color: 'var(--text-tertiary)' }}>
            {chatSessions.length}
          </span>
        </button>
        <button
          className="gg-chat-nav-toggle"
          onClick={() => setOpen(v => !v)}
          title={open ? t.sidebar.collapse : t.sidebar.expand}
        >{open ? '▾' : '▸'}</button>
        <button
          className="gg-chat-nav-new"
          onClick={() => void newChatSession()}
          title={t.sidebar.newChat}
        >+</button>
      </div>
      {open && (
        <div className="gg-chat-nav-list">
          {chatSessions.map(s => (
            <div
              key={s.id}
              className={`gg-chat-nav-item ${s.id === activeChatId && isActiveSection ? 'is-active' : ''} ${editingId === s.id ? 'is-editing' : ''}`}
              onContextMenu={(e) => openContextMenu(e, s.id, s.title)}
            >
              {editingId === s.id ? (
                <input
                  ref={editInputRef}
                  className="gg-chat-nav-edit"
                  value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  onInput={e => setEditTitle(e.currentTarget.value)}
                  onMouseDown={e => e.stopPropagation()}
                  onBlur={e => {
                    const row = e.currentTarget.closest('.gg-chat-nav-item')
                    if (row && e.relatedTarget instanceof Node && row.contains(e.relatedTarget)) return
                    void commitEdit()
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      e.stopPropagation()
                      void commitEdit()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      e.stopPropagation()
                      cancelEdit()
                    }
                  }}
                />
              ) : (
                <button
                  className="gg-chat-nav-pick"
                  onClick={() => { void switchChatSession(s.id); setActiveView('chat') }}
                  onDoubleClick={() => void startEdit(s.id, s.title)}
                  onContextMenu={(e) => openContextMenu(e, s.id, s.title)}
                  title={s.title}
                >
                  <span className={`gg-chat-nav-dot ${chatSnapshots[s.id]?.isStreaming ? 'is-streaming' : chatSnapshots[s.id]?.hasUnread ? 'is-unread' : ''}`} />
                  <span className="gg-chat-nav-title">{s.parentChatId != null ? '⑂ ' : ''}{s.title}</span>
                  {s.providerId && (
                    <span className="gg-chat-nav-provider" title={`${s.providerId}${s.model ? ' · ' + s.model : ''}`}>
                      {shortProviderTag(s.providerId)}
                    </span>
                  )}
                </button>
              )}
              {editingId !== s.id && (
                <button
                  className="gg-chat-nav-x"
                  onClick={() => void removeSession(s.id, s.title)}
                  onContextMenu={(e) => openContextMenu(e, s.id, s.title)}
                  title={t.sidebar.delete}
                >×</button>
              )}
            </div>
          ))}
        </div>
      )}
      {contextMenu && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          className="gg-chat-nav-menu"
          style={clampChatMenuPos(contextMenu.x, contextMenu.y)}
          role="menu"
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            type="button"
            className="gg-chat-nav-menu-item"
            role="menuitem"
            onClick={() => {
              const { id, title } = contextMenu
              setContextMenu(null)
              requestAnimationFrame(() => startEdit(id, title))
            }}
          >
            {t.sidebar.renameChat}
          </button>
          <button
            type="button"
            className="gg-chat-nav-menu-item"
            role="menuitem"
            onClick={() => {
              const { id } = contextMenu
              setContextMenu(null)
              void (async () => { const b = await forkChat(id); if (b) setActiveView('chat') })().catch(() => {})
            }}
            title="Создать ветку — копию этого чата, чтобы исследовать другой путь, не теряя оригинал (недоступно во время ответа)"
          >
            ⑂ Ветвить
          </button>
          <button
            type="button"
            className="gg-chat-nav-menu-item is-danger"
            role="menuitem"
            onClick={() => {
              const { id, title } = contextMenu
              setContextMenu(null)
              void removeSession(id, title)
            }}
          >
            {t.sidebar.delete}
          </button>
        </div>,
        document.body,
      )}
    </>
  )
}

/** 2-3 letter tag shown next to chat session name when it has a saved provider. */
function shortProviderTag(id: string): string {
  if (id === 'gemini-api') return 'GMN'
  if (id === 'gemini-cli') return 'ULT'
  if (id === 'claude') return 'CLD'
  if (id === 'claude-cli') return 'CC'
  if (id === 'grok') return 'GRK'
  if (id === 'grok-cli') return 'GB'
  if (id === 'openai') return 'GPT'
  if (id === 'codex-cli') return 'CDX'
  // RU + OpenAI-совместимые (ревью: без явных тэгов давали невнятные YAN/GIG/DEE).
  if (id === 'yandex-gpt') return 'YGP'
  if (id === 'gigachat') return 'GIG'
  if (id === 'deepseek') return 'DSK'
  if (id === 'qwen') return 'QWN'
  if (id === 'mistral') return 'MST'
  if (id === 'moonshot') return 'MSH'
  if (id === 'groq') return 'GRQ'
  if (id === 'openrouter') return 'OPR'
  if (id === 'ollama') return 'OLM'
  if (id === 'custom-openai') return 'CST'
  return id.slice(0, 3).toUpperCase()
}

function ChatIconNode() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 0 1-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  )
}

const FilesIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
)

interface NavItem {
  id: ViewId
  label: string
  icon: ReactElement
  badge?: string
}

const SIDEBAR_SECTIONS_KEY = 'gg.sidebar.sections'

function readSectionOpen(sectionId: string, defaultOpen = true): boolean {
  try {
    const raw = localStorage.getItem(SIDEBAR_SECTIONS_KEY)
    if (!raw) return defaultOpen
    const data = JSON.parse(raw) as Record<string, boolean>
    return data[sectionId] ?? defaultOpen
  } catch {
    return defaultOpen
  }
}

function writeSectionOpen(sectionId: string, open: boolean) {
  try {
    const raw = localStorage.getItem(SIDEBAR_SECTIONS_KEY)
    const data = raw ? JSON.parse(raw) as Record<string, boolean> : {}
    data[sectionId] = open
    localStorage.setItem(SIDEBAR_SECTIONS_KEY, JSON.stringify(data))
  } catch { /* ignore */ }
}

function SidebarNavSection({
  sectionId,
  title,
  activeView,
  viewIds,
  children,
}: {
  sectionId: string
  title: string
  activeView: ViewId
  viewIds: ReadonlySet<ViewId>
  children: ReactNode
}) {
  const [open, setOpen] = useState(() => readSectionOpen(sectionId))

  useEffect(() => {
    if (viewIds.has(activeView)) setOpen(true)
  }, [activeView, viewIds])

  function toggle() {
    setOpen(v => {
      const next = !v
      writeSectionOpen(sectionId, next)
      return next
    })
  }

  return (
    <>
      <button
        type="button"
        className="gg-sidebar-section-collapsible"
        onClick={toggle}
        aria-expanded={open}
      >
        <span className="gg-sidebar-section-caret">{open ? '▾' : '▸'}</span>
        <span className="gg-sidebar-section-title">{title}</span>
      </button>
      {open && children}
    </>
  )
}

function NavButtons({ items, activeView, onSelect }: {
  items: NavItem[]
  activeView: ViewId
  onSelect: (id: ViewId) => void
}) {
  return (
    <div className="gg-nav">
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          className={`gg-nav-item ${activeView === item.id ? 'is-active' : ''}`}
          onClick={() => onSelect(item.id)}
        >
          <span className="gg-nav-icon">{item.icon}</span>
          <span className="gg-nav-label">{item.label}</span>
        </button>
      ))}
    </div>
  )
}

const WORK_VIEW_IDS = new Set<ViewId>(['chat', 'plan', 'tasks', 'skills', 'workflow'])
const CONTROL_VIEW_IDS = new Set<ViewId>(['journal', 'scheduler', 'reminders', 'tasks-manager', 'inspector', 'agents', 'decisions'])
const PROJECT_VIEW_IDS = new Set<ViewId>(['project-map', 'memory-gov', 'files', 'brain'])
const TOOLS_VIEW_IDS = new Set<ViewId>(['browser', 'design', 'feedback'])

const ChatIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 0 1-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
  </svg>
)
const PlanIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="13" x2="15" y2="13" />
    <line x1="9" y1="17" x2="13" y2="17" />
  </svg>
)
const TasksIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 11 12 14 22 4" />
    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
  </svg>
)
const WorkflowIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="5" cy="6" r="2" />
    <circle cx="19" cy="12" r="2" />
    <circle cx="5" cy="18" r="2" />
    <path d="M7 6h6a4 4 0 0 1 4 4v0M7 18h6a4 4 0 0 0 4-4v0" />
  </svg>
)
const CalendarIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
  </svg>
)
const JournalIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </svg>
)
const BrowserIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
)
const FeedbackIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 11.5a8.38 8.38 0 0 1 -8.5 8.5 8.5 8.5 0 0 1 -3.8 -0.9L3 21l1.4 -5.5a8.38 8.38 0 0 1 -0.9 -3.5 8.5 8.5 0 0 1 17 -0.5z" />
  </svg>
)
const SkillsIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
  </svg>
)
const DesignIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 19l7-7 3 3-7 7-3-3z" />
    <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
    <path d="M2 2l7.586 7.586" />
    <circle cx="11" cy="11" r="2" />
  </svg>
)
const InspectorIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
)
const MemoryIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a4 4 0 0 0-4 4 3 3 0 0 0-2 5.5A3 3 0 0 0 8 17a3.5 3.5 0 0 0 4 1 3.5 3.5 0 0 0 4-1 3 3 0 0 0 2-5.5A3 3 0 0 0 16 6a4 4 0 0 0-4-4z" />
    <path d="M12 2v16" />
  </svg>
)
const AgentsIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="7" r="3" />
    <circle cx="5" cy="17" r="2.5" />
    <circle cx="19" cy="17" r="2.5" />
    <path d="M12 10v3M10 13l-3.5 2M14 13l3.5 2" />
  </svg>
)
const TasksManagerIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <rect x="3" y="10" width="18" height="4" rx="1" />
    <rect x="3" y="16" width="18" height="4" rx="1" />
    <line x1="7" y1="6" x2="7" y2="6" />
    <line x1="7" y1="12" x2="7" y2="12" />
    <line x1="7" y1="18" x2="7" y2="18" />
  </svg>
)
const DecisionsIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
    <rect x="9" y="3" width="6" height="4" rx="1" />
    <path d="M9 14l2 2 4-4" />
  </svg>
)
const BrainIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <rect x="9" y="9" width="6" height="6" />
    <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
  </svg>
)
const ProjectMapIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="1 6 8 3 16 6 23 3 23 18 16 21 8 18 1 21 1 6" />
    <line x1="8" y1="3" x2="8" y2="18" />
    <line x1="16" y1="6" x2="16" y2="21" />
  </svg>
)
// Chat is rendered separately above the rest of the nav (expandable section
// with its own list of chat sessions + create button).
// NAV is built inside the component to use translations.

interface SidebarProps {
  onOpenSettings: () => void
  'aria-hidden'?: boolean
}

export function Sidebar({ onOpenSettings, 'aria-hidden': ariaHidden }: SidebarProps) {
  const { path, setProject, activeView, setActiveView, refreshProjectList } = useProject()
  const t = useT()
  const [showCreateClient, setShowCreateClient] = useState(false)

  const WORK_NAV: NavItem[] = [
    { id: 'plan',     label: t.sidebar.plan,     icon: PlanIcon },
    { id: 'tasks',    label: t.sidebar.tasks,    icon: TasksIcon },
    { id: 'skills',   label: t.sidebar.skills,   icon: SkillsIcon },
    { id: 'workflow', label: t.sidebar.workflow, icon: WorkflowIcon },
  ]

  const CONTROL_NAV: NavItem[] = [
    { id: 'journal',  label: t.sidebar.journal,  icon: JournalIcon },
    { id: 'scheduler', label: 'Расписание', icon: CalendarIcon },
    { id: 'reminders', label: t.sidebar.reminders, icon: CalendarIcon },
    { id: 'tasks-manager', label: t.sidebar.tasksManager, icon: TasksManagerIcon },
    { id: 'inspector', label: t.sidebar.inspector, icon: InspectorIcon },
    { id: 'agents',   label: t.sidebar.agents,   icon: AgentsIcon },
    { id: 'decisions', label: t.sidebar.decisions, icon: DecisionsIcon },
  ]

  const PROJECT_NAV: NavItem[] = [
    { id: 'project-map', label: t.sidebar.projectMap, icon: ProjectMapIcon },
    { id: 'brain', label: t.sidebar.brain, icon: BrainIcon },
    { id: 'memory-gov', label: t.sidebar.memory, icon: MemoryIcon },
    { id: 'files', label: t.sidebar.files, icon: FilesIcon },
  ]

  const TOOLS_NAV: NavItem[] = [
    { id: 'browser',  label: t.sidebar.browser,  icon: BrowserIcon },
    { id: 'design',   label: t.sidebar.design,   icon: DesignIcon },
    { id: 'feedback', label: t.sidebar.feedback, icon: FeedbackIcon },
  ]

  async function handleClientOpened(clientPath: string) {
    await setProject(clientPath)
    await refreshProjectList()
  }

  const shortPath = path ? path.replace(/^.*[\\/]/, '') : null

  return (
    <aside className="gg-sidebar" aria-hidden={ariaHidden}>
      <div className="gg-sidebar-scroll">
        <div className="gg-sidebar-section">
          <div className="gg-sidebar-section-title">{t.sidebar.project}</div>
        </div>
        <button
          className={`gg-project-button ${path ? 'has-project' : ''}`}
          onClick={() => setShowCreateClient(true)}
        >
          <span>{path ? '📁' : '＋'}</span>
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {shortPath ?? t.rail.createClient}
          </span>
        </button>
        {path && <div className="gg-project-path" title={path}>{path}</div>}

        {path && (
          <>
            <SidebarNavSection
              sectionId="work"
              title={t.sidebar.workSection}
              activeView={activeView}
              viewIds={WORK_VIEW_IDS}
            >
              <ChatNavSection />
              <NavButtons items={WORK_NAV} activeView={activeView} onSelect={setActiveView} />
            </SidebarNavSection>

            <SidebarNavSection
              sectionId="control"
              title={t.sidebar.controlSection}
              activeView={activeView}
              viewIds={CONTROL_VIEW_IDS}
            >
              <NavButtons items={CONTROL_NAV} activeView={activeView} onSelect={setActiveView} />
            </SidebarNavSection>

            <SidebarNavSection
              sectionId="project"
              title={t.sidebar.projectSection}
              activeView={activeView}
              viewIds={PROJECT_VIEW_IDS}
            >
              <NavButtons items={PROJECT_NAV} activeView={activeView} onSelect={setActiveView} />
            </SidebarNavSection>

            <SidebarNavSection
              sectionId="tools"
              title={t.sidebar.toolsSection}
              activeView={activeView}
              viewIds={TOOLS_VIEW_IDS}
            >
              <NavButtons items={TOOLS_NAV} activeView={activeView} onSelect={setActiveView} />
            </SidebarNavSection>
          </>
        )}
      </div>

      <div className="gg-sidebar-footer">
        <ModelPicker variant="footer" onOpenSettings={onOpenSettings} />
      </div>
      {showCreateClient && (
        <CreateClientModal
          onClose={() => setShowCreateClient(false)}
          onOpened={clientPath => void handleClientOpened(clientPath)}
        />
      )}
    </aside>
  )
}
