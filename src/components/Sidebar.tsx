import { useProject } from '../store/projectStore'
import type { FileNode } from '../types/api'

function TreeNode({ node, depth }: { node: FileNode; depth: number }) {
  return (
    <div>
      <div style={{ paddingLeft: depth * 12, color: node.isDirectory ? '#ccc' : '#999', fontSize: 13 }}>
        {node.isDirectory ? '📁' : '📄'} {node.name}
      </div>
      {node.children?.map(child => <TreeNode key={child.path} node={child} depth={depth + 1} />)}
    </div>
  )
}

export function Sidebar() {
  const { path, tree, setProject } = useProject()

  async function openProject() {
    const picked = await window.api.projects.pick()
    if (picked) await setProject(picked)
  }

  return (
    <aside style={{ width: 260, background: '#1a1a2e', color: '#ccc', padding: 12, overflow: 'auto', height: '100vh' }}>
      <button onClick={openProject} style={{ width: '100%', padding: 8, marginBottom: 12 }}>
        {path ? 'Сменить проект' : 'Открыть проект'}
      </button>
      {path && <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>{path}</div>}
      {tree.map(node => <TreeNode key={node.path} node={node} depth={0} />)}
    </aside>
  )
}
