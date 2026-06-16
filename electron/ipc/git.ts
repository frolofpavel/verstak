import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { safeRealJoin } from '../ai/path-policy'
import { scanText } from '../ai/secret-scanner'

const execFileAsync = promisify(execFile)

/**
 * Git READ IPC (Dev Task Flow, Фаза 1) — структурированные status/diff/log для
 * панели задач. ТОЛЬКО чтение: ветки/коммиты/push добавит git-write в Фазе 3.
 *
 * Безопасность — основа для будущего git-write:
 *   - argv-форма: execFile('git', [...], {cwd}) без shell → нет command injection.
 *   - top-frame guard: <webview>/out-of-process frames имеют не-top sender — им
 *     git недоступен (как в verify.ts).
 *   - весь вывод через scanText — diff/log могут содержать токены/ключи в коде.
 *   - cwd всегда = getProjectRoot(); пользовательский path — через safeRealJoin.
 *
 * Денилист на запись в Фазе 1 не нужен (read-only). argv-форма исключает
 * подмену команды; git сам не выполняет произвольный shell на read-операциях.
 */

const GIT_TIMEOUT = 15_000
const MAX_BUFFER = 8 * 1024 * 1024
// Кап патча ~50КБ — чтобы тяжёлый diff не раздул IPC / UI.
const PATCH_CAP = 50 * 1024

/**
 * Денилист git-write (Dev Task Flow, Фаза 3). Жёсткий запрет деструктива и
 * сетевых операций на уровне обёртки git-вызова — НЕ доверяем валидации выше.
 * Любой argv, попадающий под правило ниже, отклоняется до запуска процесса.
 *
 * Блокируем:
 *   - push / fetch / pull / remote — никакой сети (авто-push не делаем, см. roadmap §9);
 *   - reset --hard, clean -fd, checkout --force / -f — деструктив рабочего дерева;
 *   - rebase, filter-branch, filter-repo — переписывание истории;
 *   - --no-verify — обход хуков (CLAUDE.md: commit без --no-verify);
 *   - --amend — переписывание существующего коммита;
 *   - -f / --force в любом виде — форсирование.
 *
 * Безопасные subcommand'ы (status/diff/log/add/commit/branch/checkout/rev-parse)
 * проходят, если их argv не содержит запрещённых токенов.
 */
const FORBIDDEN_SUBCOMMANDS = new Set([
  'push', 'fetch', 'pull', 'remote',
  'rebase', 'filter-branch', 'filter-repo',
  'reflog', 'gc', 'prune'
])
const FORBIDDEN_FLAGS = new Set(['--force', '-f', '--no-verify', '--amend', '--hard', '-D'])

/**
 * Бросает Error если argv содержит запрещённую операцию. Проверяется:
 *   1) первый токен (subcommand) — против FORBIDDEN_SUBCOMMANDS;
 *   2) любой токен — против FORBIDDEN_FLAGS;
 *   3) опасные пары: reset --hard, clean -f/-fd, checkout --force.
 * Тест на это обязателен (tests/ipc/git-denylist.test.ts).
 */
export function assertGitAllowed(argv: string[]): void {
  const sub = argv[0] ?? ''
  if (FORBIDDEN_SUBCOMMANDS.has(sub)) {
    throw new Error(`git-write денилист: subcommand «${sub}» запрещён`)
  }
  for (const tok of argv) {
    if (FORBIDDEN_FLAGS.has(tok)) {
      throw new Error(`git-write денилист: флаг «${tok}» запрещён`)
    }
  }
  // reset --hard — деструктивный сброс рабочего дерева.
  if (sub === 'reset' && argv.includes('--hard')) {
    throw new Error('git-write денилист: reset --hard запрещён')
  }
  // clean -f / -fd / --force — удаление неотслеженных файлов.
  if (sub === 'clean') {
    if (argv.some(a => a === '-f' || a === '-fd' || a === '-df' || a === '--force')) {
      throw new Error('git-write денилист: clean -fd запрещён')
    }
    // Любой clean считаем опасным (даже dry-run не нужен агенту).
    throw new Error('git-write денилист: git clean запрещён')
  }
  // checkout --force / -f — потеря локальных правок.
  if (sub === 'checkout' && argv.some(a => a === '--force' || a === '-f')) {
    throw new Error('git-write денилист: checkout --force запрещён')
  }
}

/** Имя ветки: только [\w./-], без '..' (traversal/ref-обман) и пробелов. */
export function isValidBranchName(name: string): boolean {
  if (!name || /\s/.test(name)) return false
  if (name.includes('..')) return false
  return /^[\w./-]+$/.test(name)
}

// ----------------------------------------------------------- git-write helpers
// Экспортируемые операции записи — переиспользуются и IPC-хендлерами (ниже), и
// оркестратором Dev Task Flow (ipc/dev-task.ts). Единая точка через runGit →
// assertGitAllowed гарантирует денилист push/force/reset для всех вызовов.

export interface GitWriteResult { ok: boolean; error?: string }

/** Создать и переключиться на ветку (checkout -b name [from]). */
export async function gitBranchCreate(cwd: string, name: string, from?: string): Promise<{ ok: boolean; branch?: string; error?: string }> {
  if (!isValidBranchName(name)) return { ok: false, error: 'invalid-branch-name' }
  if (from && !isValidBranchName(from) && !/^[\w./@^~-]+$/.test(from)) return { ok: false, error: 'invalid-from' }
  const argv = ['checkout', '-b', name]
  if (from) argv.push(from)
  try {
    await runGit(cwd, argv)
    return { ok: true, branch: name }
  } catch (err) {
    return { ok: false, error: scanText(err instanceof Error ? err.message : String(err)).redacted }
  }
}

/** Переключиться на ветку: verstak/* ИЛИ уже существующую (force запрещён). */
export async function gitCheckout(cwd: string, ref: string): Promise<GitWriteResult> {
  if (!isValidBranchName(ref)) return { ok: false, error: 'invalid-ref' }
  try {
    if (!ref.startsWith('verstak/')) {
      const { stdout } = await runGit(cwd, ['branch', '--list', ref])
      if (!stdout.trim()) return { ok: false, error: 'ref-not-allowed' }
    }
    await runGit(cwd, ['checkout', ref])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: scanText(err instanceof Error ? err.message : String(err)).redacted }
  }
}

/** Поставить пути в индекс. Каждый path — через safeRealJoin (внутри проекта). */
export async function gitAdd(cwd: string, paths: string[]): Promise<GitWriteResult> {
  const clean = paths.filter(p => typeof p === 'string' && p.trim())
  if (clean.length === 0) return { ok: false, error: 'no-paths' }
  for (const rel of clean) {
    try { await safeRealJoin(cwd, rel) } catch { return { ok: false, error: `path-outside-project: ${rel}` } }
  }
  try {
    await runGit(cwd, ['add', '--', ...clean])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: scanText(err instanceof Error ? err.message : String(err)).redacted }
  }
}

/** Закоммитить (+ опц. add paths). --no-verify/--amend невозможны (денилист). */
export async function gitCommit(cwd: string, message: string, paths?: string[]): Promise<{ ok: boolean; sha?: string; error?: string }> {
  const msg = String(message ?? '').trim()
  if (!msg) return { ok: false, error: 'empty-message' }
  const clean = Array.isArray(paths) ? paths.filter(p => typeof p === 'string' && p.trim()) : []
  if (clean.length > 0) {
    const added = await gitAdd(cwd, clean)
    if (!added.ok) return { ok: false, error: added.error }
  }
  try {
    await runGit(cwd, ['commit', '-m', msg])
    const { stdout } = await runGit(cwd, ['rev-parse', 'HEAD'])
    return { ok: true, sha: stdout.trim() }
  } catch (err) {
    return { ok: false, error: scanText(err instanceof Error ? err.message : String(err)).redacted }
  }
}

export interface GitStatus {
  branch: string | null
  ahead: number
  behind: number
  staged: string[]
  unstaged: string[]
  untracked: string[]
}

export interface GitDiffStatEntry {
  path: string
  added: number
  removed: number
  status: string
}

export interface GitDiff {
  stat: GitDiffStatEntry[]
  patch?: string
}

export interface GitLogEntry {
  sha: string
  subject: string
  author: string
  date: string
}

/** True для top-level main frame; false для webview / out-of-process. */
function isTopFrame(e: Electron.IpcMainInvokeEvent): boolean {
  return !!e.sender && e.senderFrame?.parent == null
}

async function runGit(cwd: string, argv: string[]): Promise<{ stdout: string; stderr: string }> {
  // Денилист — единая точка для READ и WRITE. read-команды его проходят
  // (status/diff/log/add/commit/branch не в FORBIDDEN), деструктив отсекается.
  assertGitAllowed(argv)
  const { stdout, stderr } = await execFileAsync('git', argv, {
    cwd, timeout: GIT_TIMEOUT, maxBuffer: MAX_BUFFER, windowsHide: true
  })
  return { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
}

/**
 * Парсит `git status --porcelain=v1 --branch` в структурированный статус.
 * Первая строка `## branch...upstream [ahead N, behind M]` — ветка + дивергенция;
 * далее строки `XY path` где X = staged-статус, Y = unstaged-статус (?? = untracked).
 */
function parseStatus(stdout: string): GitStatus {
  const result: GitStatus = { branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] }
  const lines = stdout.split('\n').filter(l => l.length > 0)
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const head = line.slice(3)
      // branch — до '...' (если есть upstream) либо до пробела.
      const branchPart = head.split('...')[0].split(' ')[0]
      // Detached HEAD: git печатает 'HEAD (no branch)'.
      result.branch = branchPart === 'HEAD' ? null : branchPart
      const ahead = head.match(/ahead (\d+)/)
      const behind = head.match(/behind (\d+)/)
      if (ahead) result.ahead = Number(ahead[1])
      if (behind) result.behind = Number(behind[1])
      continue
    }
    // Формат: XY<space>path  (для переименований path = 'old -> new').
    const x = line[0]
    const y = line[1]
    const path = line.slice(3)
    if (x === '?' && y === '?') {
      result.untracked.push(path)
      continue
    }
    // staged (index) — X не пробел и не '?'.
    if (x !== ' ' && x !== '?') result.staged.push(path)
    // unstaged (worktree) — Y не пробел и не '?'.
    if (y !== ' ' && y !== '?') result.unstaged.push(path)
  }
  return result
}

/**
 * Парсит `git diff --numstat`: строки `added<tab>removed<tab>path`.
 * Бинарные файлы дают '-' вместо чисел → added/removed = 0.
 */
function parseNumstat(stdout: string): GitDiffStatEntry[] {
  const entries: GitDiffStatEntry[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const added = parts[0] === '-' ? 0 : Number(parts[0])
    const removed = parts[1] === '-' ? 0 : Number(parts[1])
    const path = parts.slice(2).join('\t')
    entries.push({ path, added, removed, status: parts[0] === '-' ? 'binary' : 'modified' })
  }
  return entries
}

/**
 * Прочитать diff-stat (numstat) рабочего дерева — для оркестратора Dev Task Flow
 * (buildPackage). base опц.: сравнивает base..HEAD, иначе worktree. Не-git → [].
 * Read-only, проходит денилист (diff безопасен).
 */
export async function readDiffStat(cwd: string, base?: string): Promise<GitDiffStatEntry[]> {
  const args = ['diff', '--numstat']
  if (base && /^[\w./@^~-]+$/.test(base) && !base.startsWith('-')) {
    // `git diff <base>` (base vs рабочее дерево) — ВЕСЬ diff задачи от базы:
    // и закоммиченное, и незакоммиченное. НЕ `base..HEAD` (только коммиты) —
    // иначе в dirty-in-place (агент правит, но не коммитит) пакет пуст, хотя
    // правки есть в worktree, и расходится с commit (аудит P0 #7 diff-sync).
    args.splice(1, 0, base)
  }
  try {
    const { stdout } = await runGit(cwd, args)
    return parseNumstat(scanText(stdout).redacted)
  } catch {
    return []
  }
}

export function registerGitIpc(getProjectRoot: () => string | null): void {
  // git:status — структурированный статус активного проекта.
  ipcMain.handle('git:status', async (e): Promise<GitStatus> => {
    if (!isTopFrame(e)) {
      return { branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] }
    }
    const cwd = getProjectRoot()
    if (!cwd) return { branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] }
    try {
      const { stdout } = await runGit(cwd, ['status', '--porcelain=v1', '--branch'])
      return parseStatus(scanText(stdout).redacted)
    } catch {
      // Не git-репозиторий / git не установлен — пустой статус, не падаем.
      return { branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] }
    }
  })

  // git:diff — numstat + сам патч (cap ~50КБ). base сравнивает base..HEAD,
  // staged показывает индекс (--cached), path сужает до файла (через safeRealJoin).
  ipcMain.handle('git:diff', async (e, opts?: { base?: string; staged?: boolean; path?: string }): Promise<GitDiff> => {
    if (!isTopFrame(e)) return { stat: [] }
    const cwd = getProjectRoot()
    if (!cwd) return { stat: [] }
    const base = opts?.base
    const staged = opts?.staged === true
    const rel = opts?.path
    // Базовые аргументы diff: --cached для индекса, base..HEAD для сравнения с базой.
    const baseArgs: string[] = []
    if (staged) baseArgs.push('--cached')
    if (base) {
      // Простая валидация ref-имени — argv-форма уже исключает injection,
      // но отсекаем явный мусор/опции (ведущий '-').
      if (!/^[\w./@^~-]+$/.test(base) || base.startsWith('-')) return { stat: [] }
      baseArgs.push(`${base}..HEAD`)
    }
    // Путь-ограничитель: валидируем через safeRealJoin (anti-traversal),
    // но git'у передаём относительный путь после '--' (pathspec, не опция).
    let pathSpec: string[] = []
    if (rel) {
      try {
        await safeRealJoin(cwd, rel)
      } catch {
        return { stat: [] }
      }
      pathSpec = ['--', rel]
    }
    try {
      const numstat = await runGit(cwd, ['diff', ...baseArgs, '--numstat', ...pathSpec])
      const stat = parseNumstat(scanText(numstat.stdout).redacted)
      const raw = await runGit(cwd, ['diff', ...baseArgs, ...pathSpec])
      let patch = scanText(raw.stdout).redacted
      if (patch.length > PATCH_CAP) patch = patch.slice(0, PATCH_CAP) + '\n… (патч обрезан)'
      return { stat, patch: patch.length > 0 ? patch : undefined }
    } catch {
      return { stat: [] }
    }
  })

  // git:log — последние коммиты (sha/subject/author/date). limit default 20.
  ipcMain.handle('git:log', async (e, opts?: { limit?: number }): Promise<GitLogEntry[]> => {
    if (!isTopFrame(e)) return []
    const cwd = getProjectRoot()
    if (!cwd) return []
    const limit = Math.max(1, Math.min(opts?.limit ?? 20, 200))
    // Разделитель \x1f (unit separator) между полями, \x1e (record separator)
    // между записями — устойчиво к переводам строк внутри subject.
    const format = '%H%x1f%s%x1f%an%x1f%ad'
    try {
      const { stdout } = await runGit(cwd, ['log', `-n${limit}`, '--date=short', `--format=${format}%x1e`])
      const redacted = scanText(stdout).redacted
      const entries: GitLogEntry[] = []
      for (const record of redacted.split('\x1e')) {
        const trimmed = record.replace(/^\n/, '')
        if (!trimmed.trim()) continue
        const [sha, subject, author, date] = trimmed.split('\x1f')
        if (!sha) continue
        entries.push({ sha, subject: subject ?? '', author: author ?? '', date: date ?? '' })
      }
      return entries
    } catch {
      return []
    }
  })

  // --------------------------------------------------------------- git-write
  // Все write-операции (Фаза 3): argv-форма + денилист (runGit → assertGitAllowed)
  // + top-frame guard. Push/force/reset/clean/rebase/--no-verify невозможны на
  // уровне обёртки. git-write доступен ТОЛЬКО за явными кнопками UI.

  // git:branchCreate — создать и переключиться на ветку (checkout -b).
  ipcMain.handle('git:branchCreate', async (e, opts: { name: string; from?: string }): Promise<{ ok: boolean; branch?: string; error?: string }> => {
    if (!isTopFrame(e)) return { ok: false, error: 'forbidden-frame' }
    const cwd = getProjectRoot()
    if (!cwd) return { ok: false, error: 'no-project' }
    return gitBranchCreate(cwd, String(opts?.name ?? '').trim(), opts?.from ? String(opts.from).trim() : undefined)
  })

  // git:checkout — переключиться на verstak/* или существующую ветку.
  ipcMain.handle('git:checkout', async (e, opts: { ref: string }): Promise<GitWriteResult> => {
    if (!isTopFrame(e)) return { ok: false, error: 'forbidden-frame' }
    const cwd = getProjectRoot()
    if (!cwd) return { ok: false, error: 'no-project' }
    return gitCheckout(cwd, String(opts?.ref ?? '').trim())
  })

  // git:add — поставить пути в индекс (каждый через safeRealJoin).
  ipcMain.handle('git:add', async (e, opts: { paths: string[] }): Promise<GitWriteResult> => {
    if (!isTopFrame(e)) return { ok: false, error: 'forbidden-frame' }
    const cwd = getProjectRoot()
    if (!cwd) return { ok: false, error: 'no-project' }
    return gitAdd(cwd, Array.isArray(opts?.paths) ? opts.paths : [])
  })

  // git:commit — закоммитить (+ опц. add paths). --no-verify/--amend невозможны.
  ipcMain.handle('git:commit', async (e, opts: { message: string; paths?: string[] }): Promise<{ ok: boolean; sha?: string; error?: string }> => {
    if (!isTopFrame(e)) return { ok: false, error: 'forbidden-frame' }
    const cwd = getProjectRoot()
    if (!cwd) return { ok: false, error: 'no-project' }
    return gitCommit(cwd, String(opts?.message ?? ''), opts?.paths)
  })
}
