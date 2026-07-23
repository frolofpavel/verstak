/**
 * T1.2 — git-worktree изоляция параллельных агентов. Каждый executor роя пишет в
 * свой worktree (общий .git, изолированное рабочее дерево) → параллельные правки
 * не клобберят друг друга на диске. Арбитр сравнивает `git diff` каждого, главный
 * агент применяет выбранный в main.
 *
 * Worktree'ы создаются в системном tmp (вне проекта). git worktree копирует только
 * ОТСЛЕЖИВАЕМЫЕ файлы (node_modules/.gitignore не копируются) → дёшево.
 * Всё graceful: не-git / ошибка git → null / [] / '', НИКОГДА не кидает.
 */
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { mkdtempSync, rmSync, realpathSync, chmodSync, lstatSync, readdirSync, existsSync, rmdirSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'

/**
 * Устойчивое удаление каталога на Windows. Два режима сбоя temp-репо/worktree:
 *  (1) ТРАНЗИЕНТНЫЕ ЛОКИ — антивирус/индексатор/фоновый git держат хендл файла → EPERM/EBUSY.
 *      Проверено на машине разработчика: именно это роняло worktree-тесты (readonly сам по себе
 *      здесь НЕ блокирует — `fs.rm({force})` сносит readonly-файл штатно). Лечится bounded-retry
 *      с backoff — лок обычно снимается за сотни мс.
 *  (2) READONLY git pack-файлов — на части Windows/Node `fs.rm` не снимает readonly-атрибут и
 *      падает EPERM. Защитно: при первом EPERM снимаем readonly рекурсивно и повторяем.
 * Кидает только если и второй заход упал (проблема НЕ readonly и не транзиентна — правда наружу).
 */
export function rmDirRobust(target: string): void {
  // Под ВНЕШНЕЙ нагрузкой (Codex/сборка/антивирус) хендл temp-дерева держится дольше — даём
  // ретраю больше времени (12×150мс linear backoff ≈ до ~12с на заход, два захода). Латентность
  // платится ТОЛЬКО при локе: без лока rmSync проходит с первой попытки без задержек.
  const opts = { recursive: true as const, force: true as const, maxRetries: 12, retryDelay: 150 }
  try {
    rmSync(target, opts)
    return
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY' && code !== 'ENOTEMPTY') throw e
  }
  clearReadonlyRecursive(target)
  rmSync(target, opts)
}

/** Рекурсивно снять readonly (chmod 0o666) — иначе Windows не даёт удалить git pack-файлы. */
function clearReadonlyRecursive(target: string): void {
  let st
  try { st = lstatSync(target) } catch { return } // исчез между заходами — ок
  if (st.isDirectory()) {
    let names: string[]
    try { names = readdirSync(target) } catch { names = [] }
    for (const name of names) clearReadonlyRecursive(join(target, name))
  }
  try { chmodSync(target, 0o666) } catch { /* best-effort — символические ссылки и т.п. */ }
}

/** Синхронный сон (Atomics.wait) для backoff между заходами. Блокирует поток, но платится
 *  ТОЛЬКО при сбое операции (happy-path не спит). SAB недоступен → просто без паузы. */
function sleepSync(ms: number): void {
  if (ms <= 0) return
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* SAB off — без backoff */ }
}

/**
 * Bounded-retry транзиентно-падающей операции — тот же принцип, что rmDirRobust, но для
 * git-ПОДКОМАНДЫ (не файловой системы). Под ВНЕШНЕЙ нагрузкой (Codex/сборка/антивирус) git
 * возвращает non-zero на удалении/prune worktree, хотя повтор через сотни мс проходит.
 * op() → true при успехе; isGone() — доп. критерий (worktree уже исчез, даже если git ошибся →
 * идемпотентно). Linear backoff. Латентность платится ТОЛЬКО при сбое: happy-path выходит на
 * первой попытке без пауз.
 *
 * Параметры НОРМАЛИЗУЮТСЯ до цикла (защита main-процесса: синхронный цикл с Atomics.wait
 * нельзя прервать извне — attempts: Infinity с падающим op повесил бы процесс навсегда,
 * baseDelayMs: Infinity — вечный сон):
 *  — attempts: default 6; non-finite → 0; finite → целое, clamp 0..10;
 *  — baseDelayMs: default 150; non-finite/отрицательная → 0; конечная ограничена 1000 мс.
 */
const RETRY_MAX_ATTEMPTS = 10
const RETRY_MAX_DELAY_MS = 1000

function normAttempts(value: number | undefined, dflt: number): number {
  if (value === undefined) return dflt
  if (!Number.isFinite(value)) return 0
  return Math.min(RETRY_MAX_ATTEMPTS, Math.max(0, Math.trunc(value)))
}

function normDelayMs(value: number | undefined, dflt: number): number {
  if (value === undefined) return dflt
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.min(RETRY_MAX_DELAY_MS, value)
}

export function retryTransient(
  op: () => boolean,
  opts: { attempts?: number; baseDelayMs?: number; isGone?: () => boolean } = {},
): boolean {
  const attempts = normAttempts(opts.attempts, 6)
  const base = normDelayMs(opts.baseDelayMs, 150)
  for (let i = 0; i < attempts; i++) {
    // Исключение из op/isGone — программная ошибка, НЕ транзиент git'а: заход засчитываем
    // неудачным (bounded), но никогда не превращаем в успех и не вешаем процесс.
    try { if (op()) return true } catch { /* неудачный заход */ }
    try { if (opts.isGone?.()) return true } catch { /* отсутствие не доказано */ }
    // Cap применяется к ФАКТИЧЕСКОМУ timeout каждого сна, а не только к base: иначе linear
    // backoff base*(i+1) при attempts=10 давал бы паузы до 10 с (суммарно десятки секунд
    // блокировки main process). Любой сон ≤ RETRY_MAX_DELAY_MS.
    if (i < attempts - 1) sleepSync(Math.min(RETRY_MAX_DELAY_MS, base * (i + 1)))
  }
  return false
}

/** Канонический путь для сравнения: realpath (git нормализует), без хвостовых слэшей,
 *  case-insensitive на Windows. Пути от addWorktree и `git worktree list` иначе расходятся. */
function canonPath(p: string): string {
  let out = p
  try { out = realpathSync(p) } catch { /* может не существовать */ }
  out = out.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? out.toLowerCase() : out
}

// Унаследованные GIT_*-переменные, локализующие репозиторий. При запуске изнутри
// git-хука (напр. pre-commit) GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE переопределяют
// `-C <dir>` → git адресует ЧУЖОЙ репозиторий. Снимаем их: на десктопе их нет
// (безвредно), но helper становится устойчивым в любом контексте вызова.
const GIT_REPO_ENV_VARS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of GIT_REPO_ENV_VARS) delete env[k]
  return env
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: gitEnv(),
    }).toString()
  } catch {
    return null
  }
}

export function isGitRepo(repoRoot: string): boolean {
  const out = git(repoRoot, ['rev-parse', '--is-inside-work-tree'])
  return out != null && out.trim() === 'true'
}

/**
 * Создать detached worktree на текущем HEAD во временной папке.
 * Возвращает путь к worktree или null (не git / нет коммитов / ошибка).
 */
export function addWorktree(repoRoot: string, label = 'wt', ref = 'HEAD'): string | null {
  if (!isGitRepo(repoRoot)) return null
  let parent: string
  try {
    parent = mkdtempSync(join(tmpdir(), 'verstak-wt-'))
  } catch {
    return null
  }
  // git создаёт сам подпапку dir (её не должно существовать). Санитизируем label.
  const safe = label.replace(/[^a-zA-Z0-9_-]/g, '') || 'wt'
  const dir = join(parent, safe)
  const out = git(repoRoot, ['worktree', 'add', '--detach', dir, ref])
  if (out == null) {
    try { rmDirRobust(parent) } catch { /* best-effort */ }
    return null
  }
  return dir
}

export type WorktreeSnapshotKind = 'stash' | 'head'

export interface WorktreeSnapshotResult {
  ok: boolean
  snapshotRef: string | null
  snapshotKind: WorktreeSnapshotKind | null
  baseRef: string | null
  error?: string
}

function snapshotId(worktreePath: string): string {
  const hash = createHash('sha1').update(worktreePath).update(String(Date.now())).digest('hex').slice(0, 12)
  return `${Date.now()}-${hash}`
}

export function snapshotWorktree(repoRoot: string, worktreePath: string, options: { preserveHead?: boolean } = {}): WorktreeSnapshotResult {
  if (!isGitRepo(repoRoot) || !isGitRepo(worktreePath)) {
    return { ok: false, snapshotRef: null, snapshotKind: null, baseRef: null, error: 'not a git worktree' }
  }

  const baseRef = (git(worktreePath, ['rev-parse', 'HEAD']) ?? '').trim()
  if (!baseRef) return { ok: false, snapshotRef: null, snapshotKind: null, baseRef: null, error: 'cannot resolve worktree HEAD' }

  git(worktreePath, ['add', '-A'])
  const stashCommit = (git(worktreePath, ['stash', 'create', `verstak snapshot ${new Date().toISOString()}`]) ?? '').trim()
  if (stashCommit) {
    const ref = `refs/verstak/worktree-snapshots/stash/${snapshotId(worktreePath)}`
    if (git(repoRoot, ['update-ref', ref, stashCommit]) == null) {
      return { ok: false, snapshotRef: null, snapshotKind: null, baseRef, error: 'cannot store worktree snapshot ref' }
    }
    return { ok: true, snapshotRef: ref, snapshotKind: 'stash', baseRef }
  }

  if (options.preserveHead) {
    const ref = `refs/verstak/worktree-snapshots/head/${snapshotId(worktreePath)}`
    if (git(repoRoot, ['update-ref', ref, baseRef]) == null) {
      return { ok: false, snapshotRef: null, snapshotKind: null, baseRef, error: 'cannot store worktree HEAD ref' }
    }
    return { ok: true, snapshotRef: ref, snapshotKind: 'head', baseRef }
  }

  return { ok: true, snapshotRef: null, snapshotKind: null, baseRef }
}

export function restoreWorktreeSnapshot(repoRoot: string, snapshotRef: string, baseRef: string | null, label = 'restored'): { ok: boolean; worktreePath?: string; error?: string } {
  if (!snapshotRef) return { ok: false, error: 'missing snapshot ref' }

  const restoreRef = snapshotRef.includes('/head/') ? snapshotRef : (baseRef || 'HEAD')
  const worktreePath = addWorktree(repoRoot, label, restoreRef)
  if (!worktreePath) return { ok: false, error: 'cannot create restore worktree' }

  if (snapshotRef.includes('/stash/')) {
    const withIndex = git(worktreePath, ['stash', 'apply', '--index', snapshotRef])
    if (withIndex == null && git(worktreePath, ['stash', 'apply', snapshotRef]) == null) {
      removeWorktree(repoRoot, worktreePath)
      return { ok: false, error: 'cannot apply worktree snapshot' }
    }
  }

  return { ok: true, worktreePath }
}

/** Tri-state регистрации пути как worktree репозитория (canon-сравнение).
 *  'absent' — отсутствие ПОДТВЕРЖДЕНО успешным `git worktree list`;
 *  'unknown' — сама git-проверка упала: это НЕ «отсутствует» (защита от ложного успеха). */
function worktreeRegistration(repoRoot: string, worktreePath: string): 'registered' | 'absent' | 'unknown' {
  const list = listWorktreesRaw(repoRoot)
  if (list == null) return 'unknown'
  const target = canonPath(worktreePath)
  return list.some(wt => canonPath(wt) === target) ? 'registered' : 'absent'
}

/**
 * Удалить worktree (--force: даже с незакоммиченными правками) + prune + почистить
 * tmp-родителя. true — git remove прошёл ЛИБО worktree уже исчез (идемпотентно).
 *
 * Раньше был ОДИН заход git worktree remove: под внешней git-нагрузкой (Codex/антивирус держат
 * хендл файла в дереве) команда транзиентно падала → false, хотя повтор проходит. Теперь
 * retryTransient повторяет подкоманду (как rmDirRobust для каталога), а isGone() ловит случай,
 * когда worktree уже снят (повторный вызов / частичный успех) — тогда тоже true. «Уже снят»
 * засчитывается ТОЛЬКО при доказанном успешным git list отсутствии регистрации: упавший
 * `git worktree list` ('unknown') не равен «worktree нет».
 */
export function removeWorktree(repoRoot: string, worktreePath: string): boolean {
  const ok = retryTransient(
    () => {
      const out = git(repoRoot, ['worktree', 'remove', '--force', worktreePath])
      if (out == null) git(repoRoot, ['worktree', 'prune']) // частично снятую регистрацию — чистим перед проверкой isGone
      return out != null
    },
    { isGone: () => worktreeRegistration(repoRoot, worktreePath) === 'absent' && !existsSync(worktreePath) },
  )
  git(repoRoot, ['worktree', 'prune'])
  // АТОМАРНЫЙ cleanup tmp-родителя — только при выполнении ВСЕХ условий (защита от сноса
  // чужого пути, если worktreePath не из addWorktree):
  //  (1) remove удался (ok) — при ПРОВАЛЕ сносить родителя тем более нельзя;
  //  (2) parent по lstat — НАСТОЯЩИЙ каталог, не symlink/junction (по ссылке не переходим:
  //      junction verstak-wt-* → внешний каталог не трогаем ни по цели, ни по самой ссылке);
  //  (3) канонический parent — НЕПОСРЕДСТВЕННЫЙ ребёнок канонического tmpdir() и его basename
  //      соответствует verstak-wt-* (строковый startsWith — не доказательство containment);
  //  (4) удаление — ТОЛЬКО атомарный rmdirSync (без recursive): между проверкой и удалением
  //      нет окна TOCTOU — непустой/чужой каталог rmdir не тронет, ошибка = оставляем
  //      temp-хвост (лучше хвост, чем удалить чужое содержимое). rmDirRobust здесь не нужен.
  if (ok) {
    try {
      const parent = dirname(worktreePath)
      const st = lstatSync(parent)
      const canon = canonPath(parent)
      const isTmpContainer =
        st.isDirectory() && !st.isSymbolicLink() &&
        canonPath(dirname(canon)) === canonPath(tmpdir()) &&
        /^verstak-wt-[^\\/]*$/.test(basename(canon))
      if (isTmpContainer) rmdirSync(parent)
    } catch { /* best-effort: ENOTEMPTY/EPERM/ENOENT — хвост добьёт teardown-свип */ }
  }
  return ok
}

/** Сырые пути worktree'ов ИЛИ null, если сам `git worktree list` упал (ошибка ≠ пустой список). */
function listWorktreesRaw(repoRoot: string): string[] | null {
  const out = git(repoRoot, ['worktree', 'list', '--porcelain'])
  if (out == null) return null
  const prefix = 'worktree '
  return out.split('\n')
    .filter(l => l.startsWith(prefix))
    .map(l => l.slice(prefix.length).trim())
    .filter(Boolean)
}

/** Список путей worktree'ов репозитория (включая основной). [] — не git / ошибка git. */
export function listWorktrees(repoRoot: string): string[] {
  return listWorktreesRaw(repoRoot) ?? []
}

/**
 * Unified diff всех изменений в worktree относительно HEAD, ВКЛЮЧАЯ новые файлы.
 * Стейджит в локальный индекс worktree (свой, main не трогает) + diff --cached.
 * '' — нет изменений / ошибка.
 */
export function worktreeDiff(worktreePath: string): string {
  git(worktreePath, ['add', '-A'])
  const out = git(worktreePath, ['diff', '--cached'])
  if (out != null) return out
  // diff не получен (ENOBUFS на огромном diff / ошибка git). НЕ выдаём '' — это
  // означало бы «изменений нет» и арбитр молча потерял бы вклад executor'а.
  // Пробуем компактную сводку (--stat крошечный) — чтобы правки были видны.
  const stat = git(worktreePath, ['diff', '--cached', '--stat'])
  return stat && stat.trim() ? `[diff слишком большой для показа целиком — сводка изменений]\n${stat}` : ''
}

/**
 * #5 reconcile: удалить наши (verstak-wt) worktree'ы репозитория, которых НЕТ в
 * keepPaths (активные сессии). Чистит осиротевшие — merged/dismissed, не удалённые
 * из-за file-lock (Windows), или от удалённых чатов. Вызывать перед новой изоляцией.
 */
export function sweepStaleWorktrees(repoRoot: string, keepPaths: string[]): number {
  return reconcileOrphanWorktreePaths(repoRoot, keepPaths).length
}

/**
 * Как sweepStaleWorktrees, но возвращает СПИСОК удалённых путей (для reconcile-отчёта
 * WT-05). Удаляем наши (verstak-wt) worktree'ы репозитория, которых НЕТ в keepPaths
 * (активные сессии реестра) — осиротевшие после краша/удалённого чата/ручного вмешательства.
 * canonPath: realpath + без хвостовых слэшей + lower на Windows. Основное дерево не трогаем.
 */
export function reconcileOrphanWorktreePaths(repoRoot: string, keepPaths: string[]): string[] {
  const keep = new Set(keepPaths.map(canonPath))
  const root = canonPath(repoRoot)
  const removed: string[] = []
  for (const wt of listWorktrees(repoRoot)) {
    const w = canonPath(wt)
    if (w === root) continue // основное дерево не трогаем
    if (!/[\\/]verstak-wt-/.test(w)) continue // только свои
    if (keep.has(w)) continue // активный — оставляем
    if (removeWorktree(repoRoot, wt)) removed.push(wt)
  }
  return removed
}

/**
 * #5 локальный merge: применить изменения worktree в ОСНОВНОЕ дерево через git apply
 * (БЕЗ push/PR — осознанный non-goal Verstak). Так главный агент «забирает» выбранный
 * вариант роя в main. git apply атомарен: при конфликте/ошибке возвращает { ok:false }
 * и main НЕ тронут (всё-или-ничего). Не git / пустой diff → корректный исход без правок.
 */
export function mergeWorktreeToMain(repoRoot: string, worktreePath: string): { ok: boolean; error?: string } {
  if (!isGitRepo(repoRoot)) return { ok: false, error: 'не git-репозиторий' }
  const diff = worktreeDiff(worktreePath)
  if (!diff.trim()) return { ok: true } // нечего применять
  if (diff.startsWith('[diff слишком большой')) return { ok: false, error: 'diff слишком большой для применения' }
  try {
    execFileSync('git', ['-C', repoRoot, 'apply', '--whitespace=nowarn', '-'], {
      input: diff,
      encoding: 'utf8',
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
      env: gitEnv(),
      maxBuffer: 16 * 1024 * 1024,
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
