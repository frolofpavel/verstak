import { useState, type ReactElement } from 'react'
import { useProject, type ViewId } from '../store/projectStore'
import { useProvider } from '../hooks/useProvider'
import type { FileNode } from '../types/api'
import iconUrl from '../assets/icon.png'

function TreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1)
  const isDir = node.isDirectory
  return (
    <>
      <div
        className={`gg-tree-node ${isDir ? 'is-dir' : 'is-file'}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => isDir && setOpen(o => !o)}
      >
        <span className="gg-tree-icon">{isDir ? (open ? '▾' : '▸') : '·'}</span>
        <span className="gg-tree-name">{node.name}</span>
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

const NAV: NavItem[] = [
  { id: 'chat',     label: 'Chat',     icon: ChatIcon },
  { id: 'tasks',    label: 'Tasks',    icon: TasksIcon },
  { id: 'journal',  label: 'Journal',  icon: JournalIcon },
  { id: 'plan',     label: 'Plan',     icon: PlanIcon,     badge: 'soon' },
  { id: 'workflow', label: 'Workflow', icon: WorkflowIcon, badge: 'soon' },
  { id: 'calendar', label: 'Calendar', icon: CalendarIcon, badge: 'soon' }
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
      <div className="gg-sidebar-header">
        <div className="gg-brand">
          <img src={iconUrl} alt="GeminiGrok" className="gg-brand-img" />
          <span className="gg-brand-text">GeminiGrok</span>
        </div>
      </div>

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

            <div className="gg-sidebar-section">
              <div className="gg-sidebar-section-title">Файлы</div>
            </div>
            <div className="gg-tree">
              {tree.map(node => <TreeNode key={node.path} node={node} depth={0} />)}
            </div>
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
