import { ipcMain, shell } from 'electron'
import { readdir, stat, readFile, lstat } from 'fs/promises'
import { join } from 'path'
import { safeRealJoin, isWithinKnownRoots } from '../ai/path-policy'
import { isForbiddenPath, scanText } from '../ai/secret-scanner'
import type { FileNode } from '../shared-types'

export type { FileNode }

const IGNORE = new Set(['node_modules', '.git', 'out', 'dist', '.verstak-data', '.superpowers'])
const MAX_READ_BYTES = 2 * 1024 * 1024  // 2 MB safety cap

// export для regression-теста (ревью F4): symlink-директория наружу не должна
// раскрываться listTree (lstat + isSymbolicLink continue).
export async function listTree(current: string, depth: number): Promise<FileNode[]> {
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
    let lst
    try { lst = await lstat(abs) } catch { continue }
    if (lst.isSymbolicLink()) continue // Игнорируем символические ссылки во избежание обхода дерева наружу или бесконечных циклов
    if (lst.isDirectory()) {
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
  getKnownRoots: () => string[]
}

export function registerFilesIpc(deps: FilesIpcDeps): void {
  ipcMain.handle('files:tree', async (_e, root: string) => {
    // listTree ограничен root + IGNORE + depth, но сам root приходит из renderer —
    // обходим только зарегистрированные проекты, иначе можно листить любой диск.
    if (!isWithinKnownRoots(root, deps.getKnownRoots())) {
      throw new Error('Доступ запрещён: вне зарегистрированных проектов')
    }
    return listTree(root, 0)
  })

  /**
   * Открывает папку проекта в системном проводнике (Explorer / Finder /
   * Nautilus). Используется кнопкой «↗» в Project Settings. Использует
   * electron.shell.openPath — это безопасный встроенный API, не shell exec.
   */
  ipcMain.handle('files:reveal', async (_e, path: string) => {
    // Открываем в проводнике только пути внутри зарегистрированных проектов —
    // иначе renderer мог бы открыть произвольную системную папку.
    if (!isWithinKnownRoots(path, deps.getKnownRoots())) {
      throw new Error('Доступ запрещён: вне зарегистрированных проектов')
    }
    // shell.openPath возвращает '' при успехе, или текст ошибки.
    const err = await shell.openPath(path)
    return { ok: err === '', error: err || null }
  })

  /**
   * Конвертация DOCX → HTML через mammoth.js для embedded preview.
   * Возвращает чистый body HTML (без обёртки) + messages с предупреждениями
   * от mammoth (несконвертированные стили и т.п.).
   */
  ipcMain.handle('files:docx-to-html', async (_e, path: string) => {
    try {
      // Root-guard: конвертируем только docx внутри зарегистрированных проектов.
      if (!isWithinKnownRoots(path, deps.getKnownRoots())) {
        throw new Error('Доступ запрещён: вне зарегистрированных проектов')
      }
      // isForbiddenPath по относительному пути от объемлющего проекта — не даём
      // вытащить содержимое секретного файла под видом docx.
      const root = deps.getProjectRoot()
      const relPath = root && path.startsWith(root) ? path.slice(root.length).replace(/^[\\/]+/, '') : path
      if (isForbiddenPath(relPath)) {
        throw new Error(`Доступ запрещён политикой безопасности: ${relPath} (secrets/credentials)`)
      }
      const mammoth = await import('mammoth')
      const result = await mammoth.convertToHtml({ path })
      return {
        ok: true,
        // Прогоняем HTML через secret-scanner — содержимое документа не доверяем.
        html: scanText(result.value).redacted,
        warnings: result.messages.slice(0, 10).map(m => `${m.type}: ${m.message}`)
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  /**
   * F6: @-mentions — прочитать набор упомянутых файлов и собрать контекст-блок для
   * инъекции в сообщение агента. Безопасно: projectPath против known-roots,
   * safeRealJoin (anti-symlink-escape), isForbiddenPath (секреты), scanText (redact).
   * Кап 10 файлов × 12000 симв. Непрочитанные молча пропускаются.
   */
  ipcMain.handle('files:resolveMentions', async (_e, projectPath: string, paths: string[]): Promise<string> => {
    if (!projectPath || !isWithinKnownRoots(projectPath, deps.getKnownRoots())) return ''
    const blocks: string[] = []
    for (const rel of (Array.isArray(paths) ? paths : []).slice(0, 10)) {
      try {
        if (isForbiddenPath(rel)) continue
        const abs = await safeRealJoin(projectPath, rel)
        const st = await stat(abs)
        if (!st.isFile() || st.size > MAX_READ_BYTES) continue
        const raw = await readFile(abs, 'utf8')
        let safe = scanText(raw).redacted
        if (safe.length > 12000) safe = safe.slice(0, 12000) + '\n…[обрезано по лимиту]'
        blocks.push('### @' + rel + '\n```\n' + safe + '\n```')
      } catch { /* файл не прочитан — пропускаем */ }
    }
    return blocks.length ? '<mentioned_files>\n' + blocks.join('\n\n') + '\n</mentioned_files>' : ''
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
