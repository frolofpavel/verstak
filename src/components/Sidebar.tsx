import { useState } from 'react'
import { useProject } from '../store/projectStore'
import { useProvider } from '../hooks/useProvider'
import type { FileNode } from '../types/api'

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

interface SidebarProps {
  onOpenSettings: () => void
}

export function Sidebar({ onOpenSettings }: SidebarProps) {
  const { path, tree, setProject } = useProject()
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
          <div className="gg-brand-mark">G</div>
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
          <span>{provider.id === 'gemini-cli' ? 'CLI · подписка' : 'API · ключ'}</span>
        </div>
        <button className="gg-settings-trigger" onClick={onOpenSettings} title="Настройки">⚙</button>
      </div>
    </aside>
  )
}
