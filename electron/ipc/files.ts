import { ipcMain, shell } from 'electron'
import { readdir, stat, readFile, lstat } from 'fs/promises'
import { extname, join, isAbsolute, resolve, basename, relative } from 'path'
import { homedir } from 'os'
import { safeRealJoin, isWithinKnownRoots } from '../ai/path-policy'
import { isForbiddenPath, scanText } from '../ai/secret-scanner'
import { readSpreadsheet } from '../ai/office'
import type { FileNode } from '../shared-types'

export type { FileNode }

const IGNORE = new Set(['node_modules', '.git', 'out', 'dist', '.verstak-data', '.superpowers'])
const MAX_READ_BYTES = 2 * 1024 * 1024  // 2 MB safety cap
const SKILL_PREVIEW_ROOTS = [
  join(homedir(), '.verstak', 'skills'),
  join(homedir(), '.claude', 'skills'),
  join(homedir(), '.grok', 'skills'),
  join(homedir(), '.grok', 'bundled', 'skills'),
  join(homedir(), '.codex', 'skills')
]

type PreviewPathResult =
  | { ok: true; path: string; displayPath: string; source: 'project' | 'skill' | 'known-root' | 'absolute' }
  | { ok: false; error: string; requestedPath: string; searched: string[] }

type PreviewSource = 'project' | 'skill' | 'known-root' | 'absolute'

function normalizePreviewInput(value: string): string {
  return String(value || '').trim().replace(/^["'`]+|["'`.,;:!?]+$/g, '')
}

function previewRoots(deps: FilesIpcDeps): string[] {
  return [deps.getProjectRoot(), ...deps.getKnownRoots(), ...SKILL_PREVIEW_ROOTS].filter(Boolean) as string[]
}

function previewSource(abs: string, deps: FilesIpcDeps): PreviewSource {
  if (isWithinKnownRoots(abs, SKILL_PREVIEW_ROOTS)) return 'skill'
  const root = deps.getProjectRoot()
  if (root && isWithinKnownRoots(abs, [root])) return 'project'
  if (isWithinKnownRoots(abs, deps.getKnownRoots())) return 'known-root'
  return 'absolute'
}

async function resolvePreviewPath(requested: string, deps: FilesIpcDeps): Promise<PreviewPathResult> {
  const input = normalizePreviewInput(requested)
  const searched: string[] = []
  if (!input) {
    return { ok: false, error: 'Путь к файлу пустой', requestedPath: requested, searched }
  }

  const allowedRoots = previewRoots(deps)

  async function probe(abs: string): Promise<string | null> {
    const candidate = resolve(abs)
    searched.push(candidate)
    if (!isWithinKnownRoots(candidate, allowedRoots)) return null
    try {
      const st = await stat(candidate)
      return st.isFile() ? candidate : null
    } catch {
      return null
    }
  }

  if (isAbsolute(input)) {
    const found = await probe(input)
    if (found) {
      return { ok: true, path: found, displayPath: found, source: previewSource(found, deps) }
    }
    return {
      ok: false,
      error: isWithinKnownRoots(input, allowedRoots)
        ? 'Файл не найден по указанному абсолютному пути'
        : 'Предпросмотр этого пути запрещён: файл находится вне проекта и доступных папок скиллов',
      requestedPath: input,
      searched
    }
  }

  const roots = [deps.getProjectRoot(), ...deps.getKnownRoots(), ...SKILL_PREVIEW_ROOTS].filter(Boolean) as string[]
  const variants = new Set<string>([input])
  const normalized = input.replace(/\\/g, '/').replace(/^\/+/, '')
  variants.add(normalized)
  const base = normalized.replace(/\/SKILL\.md$/i, '').replace(/\.md$/i, '')
  if (base && base !== normalized) variants.add(base)
  if (base && !/[/.]/.test(basename(base))) {
    variants.add(`${base}.md`)
    variants.add(`${base}/SKILL.md`)
  } else if (base) {
    variants.add(`${base}/SKILL.md`)
  }

  for (const root of roots) {
    for (const variant of variants) {
      const found = await probe(join(root, variant))
      if (found) {
        return { ok: true, path: found, displayPath: input, source: previewSource(found, deps) }
      }
    }
  }

  return {
    ok: false,
    error: 'Файл не найден. Verstak проверил текущий проект, известные проекты и доступные папки скиллов',
    requestedPath: input,
    searched: searched.slice(0, 20)
  }
}

async function resolveReadablePreviewPath(path: string, deps: FilesIpcDeps): Promise<string> {
  const resolved = await resolvePreviewPath(path, deps)
  if (!resolved.ok) throw new Error(resolved.error)
  return resolved.path
}

function containingPreviewRoot(abs: string, deps: FilesIpcDeps): string | null {
  const roots = [deps.getProjectRoot(), ...deps.getKnownRoots(), ...SKILL_PREVIEW_ROOTS].filter(Boolean) as string[]
  let best: string | null = null
  for (const root of roots) {
    if (isWithinKnownRoots(abs, [root]) && (!best || root.length > best.length)) best = root
  }
  return best
}

function relForPolicy(abs: string, deps: FilesIpcDeps): string {
  const root = containingPreviewRoot(abs, deps)
  return root ? relative(root, abs).replace(/\\/g, '/') : abs
}

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

  ipcMain.handle('files:resolve-preview-path', async (_e, path: string): Promise<PreviewPathResult> => {
    return resolvePreviewPath(path, deps)
  })

  /**
   * Открывает папку проекта в системном проводнике (Explorer / Finder /
   * Nautilus). Используется кнопкой «↗» в Project Settings. Использует
   * electron.shell.openPath — это безопасный встроенный API, не shell exec.
   */
  ipcMain.handle('files:reveal', async (_e, path: string) => {
    // Открываем в проводнике только пути внутри зарегистрированных проектов —
    // иначе renderer мог бы открыть произвольную системную папку.
    const abs = await resolveReadablePreviewPath(path, deps)
    // shell.openPath возвращает '' при успехе, или текст ошибки.
    const err = await shell.openPath(abs)
    return { ok: err === '', error: err || null }
  })

  /**
   * Конвертация DOCX → HTML через mammoth.js для embedded preview.
   * Возвращает чистый body HTML (без обёртки) + messages с предупреждениями
   * от mammoth (несконвертированные стили и т.п.).
   */
  ipcMain.handle('files:docx-to-html', async (_e, path: string) => {
    try {
      const abs = await resolveReadablePreviewPath(path, deps)
      // Root-guard: конвертируем только docx внутри зарегистрированных проектов.
      // isForbiddenPath по относительному пути от объемлющего проекта — не даём
      // вытащить содержимое секретного файла под видом docx.
      const relPath = relForPolicy(abs, deps)
      if (isForbiddenPath(relPath)) {
        throw new Error(`Доступ запрещён политикой безопасности: ${relPath} (secrets/credentials)`)
      }
      const mammoth = await import('mammoth')
      const result = await mammoth.convertToHtml({ path: abs })
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

  ipcMain.handle('files:xlsx-to-markdown', async (_e, path: string) => {
    try {
      const abs = await resolveReadablePreviewPath(path, deps)
      const root = containingPreviewRoot(abs, deps)
      if (!root) throw new Error('Проект не открыт')
      const relPath = relative(root, abs).replace(/\\/g, '/')
      if (extname(relPath).toLowerCase() !== '.xlsx') {
        throw new Error('Это не Excel-файл .xlsx')
      }
      const markdown = await readSpreadsheet(root, relPath)
      return { ok: true, markdown }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
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
    const abs = await resolveReadablePreviewPath(path, deps)
    const root = containingPreviewRoot(abs, deps)
    if (!root) throw new Error('Проект не открыт')
    // SECURITY: symlink-safe resolution (was: textual-only resolve + relative).
    // We must compute the relative path against the project root for both the
    // forbidden-path policy check and the realpath escape check.
    const relPath = root ? relative(root, abs).replace(/\\/g, '/') : abs
    if (isForbiddenPath(relPath)) {
      throw new Error(`Доступ запрещён политикой безопасности: ${relPath} (secrets/credentials)`)
    }
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
