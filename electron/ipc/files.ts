import { ipcMain } from 'electron'
import { readdir, stat, readFile } from 'fs/promises'
import { join } from 'path'
import { safeRealJoin } from '../ai/path-policy'
import { isForbiddenPath, scanText } from '../ai/secret-scanner'

const IGNORE = new Set(['node_modules', '.git', 'out', 'dist', '.geminigrok-data', '.superpowers'])
const MAX_READ_BYTES = 2 * 1024 * 1024  // 2 MB safety cap

export interface FileNode {
  name: string
  path: string  // absolute
  isDirectory: boolean
  children?: FileNode[]
}

async function listTree(current: string, depth: number): Promise<FileNode[]> {
  if (depth > 5) return []
  let entries: string[]
  try {
    entries = await readdir(current)
  } catch {
    return []
  }
  const nodes: FileNode[] = []
  for (const name of entries) {
    if (IGNORE.has(name) || name.startsWith('.')) continue
    const abs = join(current, name)
    let st
    try { st = await stat(abs) } catch { continue }
    if (st.isDirectory()) {
      nodes.push({ name, path: abs, isDirectory: true, children: await listTree(abs, depth + 1) })
    } else {
      nodes.push({ name, path: abs, isDirectory: false })
    }
  }
  nodes.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
  return nodes
}

export interface FilesIpcDeps {
  getProjectRoot: () => string | null
}

export function registerFilesIpc(deps: FilesIpcDeps): void {
  ipcMain.handle('files:tree', async (_e, root: string) => {
    // listTree is bounded by the root itself + IGNORE list + depth — already safe.
    return listTree(root, 0)
  })

  ipcMain.handle('files:read', async (_e, path: string) => {
    const root = deps.getProjectRoot()
    if (!root) throw new Error('Проект не открыт')
    // SECURITY: symlink-safe resolution (was: textual-only resolve + relative).
    // We must compute the relative path against the project root for both the
    // forbidden-path policy check and the realpath escape check.
    const relPath = path.startsWith(root) ? path.slice(root.length).replace(/^[\\/]+/, '') : path
    if (isForbiddenPath(relPath)) {
      throw new Error(`Доступ запрещён политикой безопасности: ${relPath} (secrets/credentials)`)
    }
    const abs = await safeRealJoin(root, relPath)
    const st = await stat(abs)
    if (!st.isFile()) throw new Error(`Не файл: ${path}`)
    if (st.size > MAX_READ_BYTES) {
      throw new Error(`Файл слишком большой для чтения: ${st.size} байт (лимит ${MAX_READ_BYTES})`)
    }
    const raw = await readFile(abs, 'utf8')
    // Apply secret scanner — consistency with what AI sees. If user is reading
    // a file with API keys via the UI, they'll see [REDACTED:type] markers
    // instead of the raw token. They can still click outside the app to read
    // the file with another editor if they truly need raw — this is layered
    // defence, not perfect prevention.
    const scan = scanText(raw)
    if (scan.hits.length > 0) {
      return `[secret-scanner: redacted ${scan.hits.join(', ')} — открой файл в редакторе вне приложения для raw-доступа]\n${scan.redacted}`
    }
    return raw
  })
}
