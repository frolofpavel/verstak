import { useState, type ReactElement } from 'react'
import { useProject, type ViewId } from '../store/projectStore'
import { useProvider } from '../hooks/useProvider'
import type { FileNode } from '../types/api'

function ChatNavSection() {
  const { chatSessions, activeChatId, activeView, setActiveView, switchChatSession, newChatSession, refreshChatSessions, chatSnapshots, patchChatSession } = useProject()
  const [open, setOpen] = useState(true)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editTitle, setEditTitle] = useState('')

  const isActiveSection = activeView === 'chat'

  async function startEdit(id: number, currentTitle: string) {
    setEditingId(id)
    setEditTitle(currentTitle)
  }
  async function commitEdit() {
    if (editingId == null) return
    const t = editTitle.trim()
    const idToEdit = editingId
    // Очищаем edit-state СРАЗУ чтобы input закрылся даже если IPC упадёт
    setEditingId(null)
    setEditTitle('')
    if (!t) return
    // Optimistic local update — заголовок меняется мгновенно, без полной
    // перезагрузки chatSessions. Это убирает re-render волну, которая
    // ранее иногда обрывала входящий ai:event стрим (Pavel 2026-05-21).
    patchChatSession(idToEdit, { title: t })
    try {
      await window.api.chatSessions.rename(idToEdit, t)
    } catch (err) {
      // Если запись в DB упала — откатываем UI и подтягиваем правду
      console.error('[Sidebar] rename failed, reverting:', err)
      await refreshChatSessions()
    }
  }
  async function removeSession(id: number) {
    if (!window.confirm('Удалить этот чат и все его сообщения?')) return
    await window.api.chatSessions.remove(id)
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
          <span className="gg-nav-label">Chat</span>
          <span className="gg-nav-badge" style={{ background: 'transparent', border: 'none', color: 'var(--text-tertiary)' }}>
            {chatSessions.length}
          </span>
        </button>
        <button
          className="gg-chat-nav-toggle"
          onClick={() => setOpen(v => !v)}
          title={open ? 'Свернуть' : 'Развернуть'}
        >{open ? '▾' : '▸'}</button>
        <button
          className="gg-chat-nav-new"
          onClick={() => void newChatSession()}
          title="Новый чат"
        >+</button>
      </div>
      {open && (
        <div className="gg-chat-nav-list">
          {chatSessions.map(s => (
            <div
              key={s.id}
              className={`gg-chat-nav-item ${s.id === activeChatId && isActiveSection ? 'is-active' : ''}`}
            >
              {editingId === s.id ? (
                <input
                  autoFocus
                  className="gg-chat-nav-edit"
                  value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  onBlur={() => void commitEdit()}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void commitEdit()
                    if (e.key === 'Escape') { setEditingId(null); setEditTitle('') }
                  }}
                />
              ) : (
                <button
                  className="gg-chat-nav-pick"
                  onClick={() => { void switchChatSession(s.id); setActiveView('chat') }}
                  onDoubleClick={() => void startEdit(s.id, s.title)}
                  title={s.title}
                >
                  <span className={`gg-chat-nav-dot ${chatSnapshots[s.id]?.isStreaming ? 'is-streaming' : chatSnapshots[s.id]?.hasUnread ? 'is-unread' : ''}`} />
                  <span className="gg-chat-nav-title">{s.title}</span>
                  {s.providerId && (
                    <span className="gg-chat-nav-provider" title={`${s.providerId}${s.model ? ' · ' + s.model : ''}`}>
                      {shortProviderTag(s.providerId)}
                    </span>
                  )}
                </button>
              )}
              <button
                className="gg-chat-nav-x"
                onClick={() => void removeSession(s.id)}
                title="Удалить"
              >×</button>
            </div>
          ))}
        </div>
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
  return id.slice(0, 3).toUpperCase()
}

function ChatIconNode() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 0 1-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  )
}

function FilesSection({ tree }: { tree: FileNode[] }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className="gg-sidebar-section-collapsible"
        onClick={() => setOpen(v => !v)}
      >
        <span className="gg-sidebar-section-caret">{open ? '▾' : '▸'}</span>
        <span className="gg-sidebar-section-title">Файлы</span>
        <span className="gg-sidebar-section-count">{tree.length}</span>
      </button>
      {open && (
        <div className="gg-tree">
          {tree.map(node => <TreeNode key={node.path} node={node} depth={0} />)}
        </div>
      )}
    </>
  )
}

/**
 * Map a TouchKind to a one-glyph marker. Keeps the tree visually quiet —
 * full descriptions live in the title tooltip.
 */
function touchMarker(kind: 'read' | 'write' | 'list'): { icon: string; title: string } {
  if (kind === 'write') return { icon: '●', title: 'AI правил этот файл в текущей сессии' }
  if (kind === 'read') return { icon: '○', title: 'AI читал этот файл в текущей сессии' }
  return { icon: '·', title: 'AI листал этот каталог в текущей сессии' }
}

function TreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1)
  const isDir = node.isDirectory
  // Touched-by-AI marker. The store keys by the project-relative path the
  // tools emit — match against node.path. If it doesn't match (different
  // separator on Windows), fall through silently.
  const touched = useProject(s => s.touchedFiles[node.path])
  const marker = touched ? touchMarker(touched) : null
  return (
    <>
      <div
        className={`gg-tree-node ${isDir ? 'is-dir' : 'is-file'} ${touched ? `is-touched is-${touched}` : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => isDir && setOpen(o => !o)}
        title={marker?.title}
      >
        <span className="gg-tree-icon">{isDir ? (open ? '▾' : '▸') : '·'}</span>
        <span className="gg-tree-name">{node.name}</span>
        {marker && <span className="gg-tree-touch" aria-hidden>{marker.icon}</span>}
      </div>
      {isDir && open && node.children?.map(child => (
        <TreeNode key={child.path} node={child} depth={depth + 1} />
      ))}
    </>
  )
}

interface NavItem {
  id: ViewId
  label: string
  icon: ReactElement
  badge?: string
}

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

// Chat is rendered separately above the rest of the nav (expandable section
// with its own list of chat sessions + create button).
const NAV: NavItem[] = [
  { id: 'tasks',    label: 'Tasks',    icon: TasksIcon },
  { id: 'journal',  label: 'Journal',  icon: JournalIcon },
  { id: 'plan',     label: 'Plan',     icon: PlanIcon },
  { id: 'browser',  label: 'Browser',  icon: BrowserIcon },
  { id: 'workflow', label: 'Workflow', icon: WorkflowIcon, badge: 'soon' },
  { id: 'calendar', label: 'Calendar', icon: CalendarIcon, badge: 'soon' },
  { id: 'feedback', label: 'Feedback', icon: FeedbackIcon }
]

interface SidebarProps {
  onOpenSettings: () => void
}

export function Sidebar({ onOpenSettings }: SidebarProps) {
  const { path, tree, setProject, activeView, setActiveView } = useProject()
  const provider = useProvider()

  async function openProject() {
    const picked = await window.api.projects.pick()
    if (picked) await setProject(picked)
  }

  const shortPath = path ? path.replace(/^.*[\\/]/, '') : null

  return (
    <aside className="gg-sidebar">
      <div className="gg-sidebar-scroll">
        <div className="gg-sidebar-section">
          <div className="gg-sidebar-section-title">Проект</div>
        </div>
        <button
          className={`gg-project-button ${path ? 'has-project' : ''}`}
          onClick={openProject}
        >
          <span>{path ? '📁' : '＋'}</span>
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {shortPath ?? 'Открыть папку'}
          </span>
        </button>
        {path && <div className="gg-project-path" title={path}>{path}</div>}

        {path && (
          <>
            <ChatNavSection />
            <div className="gg-nav">
              {NAV.map(item => (
                <button
                  key={item.id}
                  className={`gg-nav-item ${activeView === item.id ? 'is-active' : ''} ${item.badge ? 'is-disabled' : ''}`}
                  onClick={() => { if (!item.badge) setActiveView(item.id) }}
                >
                  <span className="gg-nav-icon">{item.icon}</span>
                  <span className="gg-nav-label">{item.label}</span>
                  {item.badge && <span className="gg-nav-badge">{item.badge}</span>}
                </button>
              ))}
            </div>

            <FilesSection tree={tree} />
          </>
        )}
      </div>

      <div className="gg-sidebar-footer">
        <div className="gg-provider-badge">
          <span className={`gg-provider-dot ${provider.id === 'gemini-cli' ? 'cli' : ''}`} />
          <span>{provider.label} · {provider.transport}</span>
        </div>
        <button className="gg-settings-trigger" onClick={onOpenSettings} title="Настройки">⚙</button>
      </div>
    </aside>
  )
}
