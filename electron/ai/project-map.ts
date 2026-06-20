/**
 * Project Map — фоновое сканирование структуры проекта в компактный JSON,
 * который AI может загрузить через get_project_map в начале задачи.
 *
 * Это даёт семантический слой поверх ripgrep: AI видит layout до того как
 * полезет читать файлы, и может прицельно искать вместо случайных list_directory.
 *
 * Что в карте:
 *   - дерево директорий (только структура, без содержимого)
 *   - все top-level символы из *.ts/*.tsx/*.js/*.jsx (functions, classes,
 *     React components, exports) через быстрый regex (не AST — слишком дорого
 *     для фоновой задачи)
 *   - количество строк в файле
 *
 * Регенерация: при mount активного проекта (один раз) + по явному вызову
 * AI tool refresh_project_map. Кэш в памяти, не на диск — не хочется
 * грязнить project root.
 */

import { readdir, stat, readFile } from 'fs/promises'
import { join, relative, dirname, resolve, extname } from 'path'

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'out', 'dist', '.next', '.vite', '.verstak',
  '.verstak-data', '.superpowers', '__pycache__', 'venv', '.venv',
  'target', 'build', '.cache', '.turbo', '.parcel-cache'
])

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs'])
const MAX_FILE_SCAN_BYTES = 256 * 1024
const MAX_TOTAL_FILES = 2000

interface FileSymbol {
  /** function | class | component | export | type */
  kind: string
  name: string
  line: number
}

interface ProjectFileEntry {
  path: string       // relative, posix-style
  lines: number
  symbols: FileSymbol[]
}

export interface ProjectMap {
  root: string
  generatedAt: number
  files: ProjectFileEntry[]
  /** Stats for quick overview. */
  stats: {
    totalFiles: number
    codeFiles: number
    totalLines: number
    truncated: boolean
  }
}

/**
 * Regex symbol extractor. Not as accurate as a real parser but fast (~5x
 * faster than spawning tsc) and good enough to give AI a structural map.
 */
function extractSymbols(content: string, ext = ''): FileSymbol[] {
  const lines = content.split('\n')
  const out: FileSymbol[] = []
  const seen = new Set<string>()
  if (ext === '.py') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      let m = /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/.exec(line)
      if (m) { addSym('function', m[1], i + 1); continue }
      m = /^\s*class\s+([A-Za-z_][\w]*)\b/.exec(line)
      if (m) { addSym('class', m[1], i + 1); continue }
    }
    return out.slice(0, 50)
  }
  if (ext === '.go') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      let m = /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_][\w]*)\s*\(/.exec(line)
      if (m) { addSym('function', m[1], i + 1); continue }
      m = /^\s*type\s+([A-Za-z_][\w]*)\s+(?:struct|interface|func|\w+)/.exec(line)
      if (m) { addSym('type', m[1], i + 1); continue }
    }
    return out.slice(0, 50)
  }
  if (ext === '.rs') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      let m = /^\s*pub\s+(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*\(/.exec(line)
      if (m) { addSym('function', m[1], i + 1); continue }
      m = /^\s*pub\s+(?:struct|enum|trait)\s+([A-Za-z_][\w]*)\b/.exec(line)
      if (m) { addSym('type', m[1], i + 1); continue }
    }
    return out.slice(0, 50)
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // export function / export async function
    let m = /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line)
    if (m) { addSym('function', m[1], i + 1); continue }
    // export class
    m = /^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line)
    if (m) { addSym('class', m[1], i + 1); continue }
    // export const Foo = ... (likely React component if PascalCase)
    m = /^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*[:=]/.exec(line)
    if (m) {
      const name = m[1]
      const kind = /^[A-Z]/.test(name) ? 'component' : 'export'
      addSym(kind, name, i + 1)
      continue
    }
    // export type / interface
    m = /^\s*export\s+(type|interface)\s+([A-Za-z_$][\w$]*)/.exec(line)
    if (m) { addSym('type', m[2], i + 1); continue }
    // export default function/class
    m = /^\s*export\s+default\s+(?:async\s+)?(function|class)\s+([A-Za-z_$][\w$]*)?/.exec(line)
    if (m) { addSym(m[1], m[2] || 'default', i + 1); continue }
  }
  function addSym(kind: string, name: string, line: number): void {
    const key = `${kind}:${name}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ kind, name, line })
  }
  return out.slice(0, 50)  // hard cap per file
}

export async function buildProjectMap(root: string): Promise<ProjectMap> {
  const files: ProjectFileEntry[] = []
  let totalLines = 0
  let truncated = false

  async function walk(dir: string): Promise<void> {
    if (files.length >= MAX_TOTAL_FILES) { truncated = true; return }
    let entries: string[]
    try { entries = await readdir(dir) } catch { return }
    entries.sort()
    for (const name of entries) {
      if (files.length >= MAX_TOTAL_FILES) { truncated = true; return }
      if (IGNORE_DIRS.has(name)) continue
      if (name.startsWith('.') && name !== '.env.example') continue
      const abs = join(dir, name)
      let st
      try { st = await stat(abs) } catch { continue }
      if (st.isDirectory()) { await walk(abs); continue }
      if (!st.isFile()) continue
      const rel = relative(root, abs).replace(/\\/g, '/')
      const dotIdx = name.lastIndexOf('.')
      const ext = dotIdx > 0 ? name.slice(dotIdx) : ''
      // Code file → extract symbols + line count
      if (CODE_EXT.has(ext) && st.size <= MAX_FILE_SCAN_BYTES) {
        let content: string
        try { content = await readFile(abs, 'utf8') } catch { continue }
        const lines = content.split('\n').length
        totalLines += lines
        const symbols = extractSymbols(content, ext)
        files.push({ path: rel, lines, symbols })
      } else {
        // Non-code or oversized: just record path
        files.push({ path: rel, lines: 0, symbols: [] })
      }
    }
  }
  await walk(root)

  const codeFiles = files.filter(f => f.lines > 0).length
  return {
    root,
    generatedAt: Date.now(),
    files,
    stats: { totalFiles: files.length, codeFiles, totalLines, truncated }
  }
}

export interface ProjectMapTextOptions {
  /**
   * 'compact': directory headers + file paths only, no per-file symbols,
   * with a soft byte budget. Used by Context Pack to fit the map into the
   * system prompt without re-parsing the full output.
   * 'full' (default): everything including symbols.
   */
  mode?: 'full' | 'compact'
  /** Soft cap on output chars in compact mode (default 1500). */
  maxChars?: number
}

/** Textual representation for the AI. Default 'full' for `get_project_map`
 *  tool; Context Pack passes mode='compact' to fit budget. */
export function projectMapToText(map: ProjectMap, opts: ProjectMapTextOptions = {}): string {
  const mode = opts.mode ?? 'full'
  const maxChars = opts.maxChars ?? 1500
  const compact = mode === 'compact'

  const lines: string[] = []
  lines.push(`# Project Map`)
  lines.push(`Generated: ${new Date(map.generatedAt).toISOString()}`)
  lines.push(`Files: ${map.stats.totalFiles} (${map.stats.codeFiles} code), ${map.stats.totalLines} lines${map.stats.truncated ? ' [truncated]' : ''}`)
  lines.push('')
  // Group by top-level directory
  const groups = new Map<string, ProjectFileEntry[]>()
  for (const f of map.files) {
    const top = f.path.includes('/') ? f.path.split('/')[0] : '(root)'
    if (!groups.has(top)) groups.set(top, [])
    groups.get(top)!.push(f)
  }
  let budget = compact ? maxChars : Number.POSITIVE_INFINITY
  outer: for (const [top, fs] of groups) {
    const head = `## ${top}/ (${fs.length} files)`
    lines.push(head)
    budget -= head.length
    for (const f of fs) {
      if (budget <= 0) {
        lines.push('…(truncated)')
        break outer
      }
      const sym = !compact && f.symbols.length > 0
        ? '  ' + f.symbols.map(s => `${s.kind}:${s.name}`).join(', ')
        : ''
      const line = `- ${f.path}${f.lines ? ` (${f.lines}L)` : ''}${sym}`
      lines.push(line)
      budget -= line.length
    }
    if (!compact) lines.push('')
  }
  return lines.join('\n')
}

// ============================================================================
// Dependency map — Feature 5
// ============================================================================

export interface DependencyMap {
  files: Record<string, {
    imports: string[]      // relative posix paths this file imports (resolved)
    importedBy: string[]   // files that import this file
    exports: string[]      // exported symbol names
  }>
}

const IMPORT_RE = /(?:^|\n)\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g
const REQUIRE_RE = /(?:^|\n)\s*(?:const|let|var)\s+[\s\S]*?=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const EXPORT_SYM_RE = /^\s*export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm
const EXPORT_DEFAULT_RE = /^\s*export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm

function collectImportPaths(content: string): string[] {
  const paths: string[] = []
  let m: RegExpExecArray | null
  IMPORT_RE.lastIndex = 0
  while ((m = IMPORT_RE.exec(content)) !== null) paths.push(m[1])
  REQUIRE_RE.lastIndex = 0
  while ((m = REQUIRE_RE.exec(content)) !== null) paths.push(m[1])
  return paths
}

function collectExports(content: string): string[] {
  const syms: string[] = []
  let m: RegExpExecArray | null
  EXPORT_SYM_RE.lastIndex = 0
  while ((m = EXPORT_SYM_RE.exec(content)) !== null) syms.push(m[1])
  EXPORT_DEFAULT_RE.lastIndex = 0
  while ((m = EXPORT_DEFAULT_RE.exec(content)) !== null) syms.push(m[1])
  return [...new Set(syms)]
}

/** Resolve a bare import specifier to a relative posix path within the project,
 *  or null if it's an external package. */
function resolveImport(fromAbs: string, specifier: string, root: string): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null  // npm package
  const fromDir = dirname(fromAbs)
  const resolved = resolve(fromDir, specifier)
  // Try with known extensions if the specifier had none
  const candidates: string[] = [resolved]
  const ext = extname(resolved)
  if (!ext) {
    candidates.push(
      resolved + '.ts', resolved + '.tsx', resolved + '.js', resolved + '.jsx',
      join(resolved, 'index.ts'), join(resolved, 'index.tsx'), join(resolved, 'index.js')
    )
  }
  for (const c of candidates) {
    // We can't do existsSync here (async context) — use best-effort posix path
    const rel = relative(root, c).replace(/\\/g, '/')
    if (!rel.startsWith('..')) return rel
  }
  return null
}

// In-memory dependency map cache keyed by project root
const depCache = new Map<string, DependencyMap>()

export async function buildDependencyMap(projectRoot: string): Promise<DependencyMap> {
  const fileMap: DependencyMap['files'] = {}

  async function walk(dir: string): Promise<void> {
    let entries: string[]
    try { entries = await readdir(dir) } catch { return }
    entries.sort()
    for (const name of entries) {
      if (IGNORE_DIRS.has(name)) continue
      if (name.startsWith('.')) continue
      const abs = join(dir, name)
      let st
      try { st = await stat(abs) } catch { continue }
      if (st.isDirectory()) { await walk(abs); continue }
      if (!st.isFile()) continue
      const dotIdx = name.lastIndexOf('.')
      const ext = dotIdx > 0 ? name.slice(dotIdx) : ''
      if (!CODE_EXT.has(ext)) continue
      if (st.size > MAX_FILE_SCAN_BYTES) continue
      let content: string
      try { content = await readFile(abs, 'utf8') } catch { continue }
      const rel = relative(projectRoot, abs).replace(/\\/g, '/')
      const rawImports = collectImportPaths(content)
      const resolvedImports: string[] = []
      for (const spec of rawImports) {
        const r = resolveImport(abs, spec, projectRoot)
        if (r) resolvedImports.push(r)
      }
      fileMap[rel] = {
        imports: [...new Set(resolvedImports)],
        importedBy: [],  // filled in pass 2
        exports: collectExports(content)
      }
    }
  }

  await walk(projectRoot)

  // Pass 2: fill importedBy
  for (const [file, info] of Object.entries(fileMap)) {
    for (const imp of info.imports) {
      // imp may lack extension — try exact match first, then with extensions
      const candidates = [imp, imp + '.ts', imp + '.tsx', imp + '.js', imp + '.jsx']
      for (const c of candidates) {
        if (fileMap[c]) {
          if (!fileMap[c].importedBy.includes(file)) fileMap[c].importedBy.push(file)
          break
        }
      }
    }
  }

  return { files: fileMap }
}

export async function getDependencyMap(root: string, refresh = false): Promise<DependencyMap> {
  if (!refresh) {
    const cached = depCache.get(root)
    if (cached) return cached
  }
  const map = await buildDependencyMap(root)
  depCache.set(root, map)
  return map
}

export function invalidateDependencyMap(root: string): void {
  depCache.delete(root)
}

/** Один файл-хаб: путь + сколько раз его импортируют (importedBy). */
export interface DependencyHub {
  path: string
  importedBy: number
}

/**
 * Топ-N самых импортируемых файлов проекта — архитектурные опоры.
 * Используется и Context Pack'ом (инжект в system prompt), и панелью Карта
 * (визуальное выделение хабов), чтобы ранжирование было единым.
 */
export function computeDependencyHubs(dep: DependencyMap, limit = 7): DependencyHub[] {
  const hubs: DependencyHub[] = []
  for (const [path, info] of Object.entries(dep.files)) {
    if (info.importedBy.length > 0) hubs.push({ path, importedBy: info.importedBy.length })
  }
  hubs.sort((a, b) => b.importedBy - a.importedBy || a.path.localeCompare(b.path))
  return hubs.slice(0, limit)
}

// In-memory cache keyed by project root
interface ProjectMapCacheEntry {
  map: ProjectMap
  timestamp: number
}

const cache = new Map<string, ProjectMapCacheEntry>()

const CACHE_TTL = 30_000 // 30 seconds

// Tracks files modified since the last full build. Key = project root.
const dirtyFiles = new Map<string, Set<string>>()

/**
 * Mark a file as dirty so the next getProjectMap call re-parses only that
 * file instead of doing a full rebuild (incremental update path).
 */
export function markFileDirty(root: string, filePath: string): void {
  if (!dirtyFiles.has(root)) dirtyFiles.set(root, new Set())
  dirtyFiles.get(root)!.add(filePath)
}

export async function getProjectMap(root: string, refresh = false): Promise<ProjectMap> {
  const cached = cache.get(root)
  if (!refresh && cached && Date.now() - cached.timestamp < CACHE_TTL) {
    const dirty = dirtyFiles.get(root)
    if (!dirty || dirty.size === 0) return cached.map

    // Incremental update: re-parse only dirty files (threshold: ≤10 files)
    if (dirty.size <= 10) {
      for (const filePath of dirty) {
        const relativePath = relative(root, filePath).replace(/\\/g, '/')
        const entry = cached.map.files.find(f => f.path === relativePath)
        if (entry) {
          try {
            const content = await readFile(filePath, 'utf8')
            entry.symbols = extractSymbols(content)
            entry.lines = content.split('\n').length
          } catch {
            // Файл удалён или недоступен — оставляем старую запись
          }
        }
      }
      dirty.clear()
      cached.timestamp = Date.now()
      return cached.map
    }
  }

  // Full rebuild
  dirtyFiles.delete(root)
  const map = await buildProjectMap(root)
  cache.set(root, { map, timestamp: Date.now() })
  return map
}

export function invalidateProjectMap(root: string): void {
  cache.delete(root)
  dirtyFiles.delete(root)
}

// Защита от спама warm'а: пока идёт прогрев конкретного root — переиспользуем
// тот же промис вместо параллельных полных сканов. После завершения запись
// удаляется, тёплый кэш дальше отдаётся дёшево самими get*-функциями.
const warming = new Map<string, Promise<void>>()

/**
 * Фоновый прогрев обеих карт (структура + граф зависимостей) для проекта.
 * Вызывается при открытии/смене активного проекта, чтобы к первому ai:send
 * и к открытию панели Карта кэш был уже тёплым, а не строился лениво.
 *
 * Идемпотентно: повторный warm при тёплом кэше дёшев (get* вернут кэш);
 * параллельные вызовы для одного root делят один промис.
 */
export function warmProjectMaps(root: string): Promise<void> {
  const inFlight = warming.get(root)
  if (inFlight) return inFlight
  const p = (async () => {
    // refresh=true чтобы первый warm после открытия точно построил карту даже
    // если в кэше валялась устаревшая запись от прошлой сессии того же root.
    await Promise.all([
      getProjectMap(root, true).catch(() => null),
      getDependencyMap(root, true).catch(() => null)
    ])
  })().finally(() => { warming.delete(root) })
  warming.set(root, p)
  return p
}
