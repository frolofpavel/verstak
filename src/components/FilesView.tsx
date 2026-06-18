import { useState } from 'react'
import { useProject } from '../store/projectStore'
import { useT } from '../i18n'
import type { FileNode } from '../types/api'

function touchMarker(kind: 'read' | 'write' | 'list'): { icon: string; title: string } {
  if (kind === 'write') return { icon: '●', title: 'AI правил этот файл в текущей сессии' }
  if (kind === 'read') return { icon: '○', title: 'AI читал этот файл в текущей сессии' }
  return { icon: '·', title: 'AI листал этот каталог в текущей сессии' }
}

function FileTreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1)
  const isDir = node.isDirectory
  const touched = useProject(s => s.touchedFiles[node.path])
  const marker = touched ? touchMarker(touched) : null

  function onClick() {
    if (isDir) {
      setOpen(o => !o)
      return
    }
    void window.api.files.revealInExplorer(node.path).catch(() => {})
  }

  return (
    <>
      <div
        className={`gg-tree-node ${isDir ? 'is-dir' : 'is-file'} ${touched ? `is-touched is-${touched}` : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={onClick}
        title={marker?.title}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      >
        <span className="gg-tree-icon">{isDir ? (open ? '▾' : '▸') : '·'}</span>
        <span className="gg-tree-name">{node.name}</span>
        {marker && <span className="gg-tree-touch" aria-hidden>{marker.icon}</span>}
      </div>
      {isDir && open && node.children?.map(child => (
        <FileTreeNode key={child.path} node={child} depth={depth + 1} />
      ))}
    </>
  )
}

export function FilesView() {
  const t = useT()
  const { path, tree } = useProject()

  if (!path) {
    return (
      <div className="gg-panel">
        <div className="gg-panel-empty" style={{ marginTop: 80 }}>{t.sidebar.openFolder}</div>
      </div>
    )
  }

  return (
    <div className="gg-panel">
      <div className="gg-panel-header">
        <h2 className="gg-panel-title">{t.sidebar.files}</h2>
        <div className="gg-panel-meta">{t.sidebar.inRoot.replace('{count}', String(tree.length))}</div>
      </div>
      <div className="gg-panel-body">
        {tree.length === 0 ? (
          <div className="gg-panel-empty">{t.sidebar.openFolder}</div>
        ) : (
          <div className="gg-files-view-tree">
            {tree.map(node => <FileTreeNode key={node.path} node={node} depth={0} />)}
          </div>
        )}
      </div>
    </div>
  )
}