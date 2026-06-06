import { useEffect, useState } from 'react'
import { useProject } from '../store/projectStore'
import { useT } from '../i18n'
import type { FileNode } from '../types/api'

interface FilesPanelProps {
  onClose: () => void
}

/**
 * Right-docked project file browser (Codex-style). Loads the project tree via
 * files.tree IPC and renders collapsible folders. Click a file → reveal it in
 * the system explorer. Keeps parity with the left Sidebar tree but lives in the
 * right column next to (or instead of) the terminal.
 */
export function FilesPanel({ onClose }: FilesPanelProps) {
  const t = useT()
  const { path, tree } = useProject()
  // Own copy so the panel can refresh independently; falls back to the store's
  // tree (already loaded for the Sidebar) so it shows instantly on open.
  const [nodes, setNodes] = useState<FileNode[]>(tree)

  useEffect(() => {
    if (!path) { setNodes([]); return }
    // Reuse the store tree if present, otherwise fetch.
    if (tree.length > 0) { setNodes(tree); return }
    let cancelled = false
    void window.api.files.tree(path).then(res => {
      if (!cancelled) setNodes(res)
    }).catch(() => { if (!cancelled) setNodes([]) })
    return () => { cancelled = true }
  }, [path, tree])

  return (
    <div className="gg-files-panel">
      <div className="gg-files-panel-header">
        <span className="gg-files-panel-title">{t.sidebar.files}</span>
        <button
          className="gg-files-panel-close"
          onClick={onClose}
          title={t.views.hide}
        >×</button>
      </div>
      <div className="gg-files-panel-body">
        {nodes.length === 0 ? (
          <div className="gg-files-panel-empty">{t.sidebar.openFolder}</div>
        ) : (
          <div className="gg-files-panel-tree">
            {nodes.map(node => <FileTreeNode key={node.path} node={node} depth={0} />)}
          </div>
        )}
      </div>
    </div>
  )
}

function FileTreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1)
  const isDir = node.isDirectory
  function onClick() {
    if (isDir) { setOpen(o => !o); return }
    // File click → open in system explorer (v1: lightweight reveal).
    void window.api.files.revealInExplorer(node.path).catch(() => {})
  }
  return (
    <>
      <div
        className={`gg-files-panel-node ${isDir ? 'is-dir' : 'is-file'}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={onClick}
        title={node.path}
      >
        <span className="gg-files-panel-icon">{isDir ? (open ? '▾' : '▸') : '·'}</span>
        <span className="gg-files-panel-name">{node.name}</span>
      </div>
      {isDir && open && node.children?.map(child => (
        <FileTreeNode key={child.path} node={child} depth={depth + 1} />
      ))}
    </>
  )
}
