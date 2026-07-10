/**
 * Control Envelope (срез 4) — честный контур контроля вокруг CLI-прогона.
 *
 * ПОЧЕМУ не undo-стек. Undo-стек Verstak ловит ТОЛЬКО правки, прошедшие через
 * его write_file/apply_patch. CLI-провайдеры (claude/codex/…) пишут файлы ВНУТРИ
 * бинаря, мимо этих инструментов — их правки в undo-стек НЕ попадают. Поэтому
 * «checkpoint над undo-стеком» перед CLI-прогоном был бы полой фичей (ровно то,
 * от чего предостерегал Павел). Честный якорь отката внешних правок — git:
 * HEAD до прогона + недеструктивный `git stash create` снапшот грязных
 * отслеживаемых изменений.
 *
 * Всё graceful: не-git / ошибка git → null, НИКОГДА не кидает. Provenance не
 * несёт секретов — только id провайдера, модель, transport и git-sha.
 */
import { execFileSync } from 'child_process'

// Унаследованные GIT_*-переменные (напр. под pre-commit хуком) переопределяют
// `-C <dir>` → git адресует ЧУЖОЙ репозиторий. Снимаем их (как в git-worktree.ts).
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

export type RuntimeTransport = 'API' | 'CLI'

// Зеркало src/lib/runtime-capability.ts CLI_WITH_TIMELINE (renderer и main не
// делят модуль — контекст-изоляция). Держать синхронно; тест сверяет набор.
export const CLI_WITH_TIMELINE: ReadonlySet<string> = new Set(['claude-cli', 'codex-cli'])

export interface ControlCheckpoint {
  /** Проект под git. */
  isGit: boolean
  /** sha HEAD до прогона — якорь отката (`git diff <sha>` / `git checkout <sha> -- .`). null = не-git / пустой репо. */
  gitHead: string | null
  /** sha `git stash create` — недеструктивный снапшот грязных tracked-правок. null если чисто. */
  stashRef: string | null
  capturedAt: number
}

/**
 * Снять контрольную точку ДО прогона. Недеструктивно: `git stash create`
 * создаёт stash-commit БЕЗ изменения рабочего дерева/индекса/stash-списка.
 * Untracked-файлы в снапшот НЕ входят (inherent-лимит stash create) — нота
 * об этом в buildRunProvenance честно предупреждает.
 */
export function captureControlCheckpoint(repoRoot: string | null, now: number): ControlCheckpoint {
  const base: ControlCheckpoint = { isGit: false, gitHead: null, stashRef: null, capturedAt: now }
  if (!repoRoot) return base
  const inside = git(repoRoot, ['rev-parse', '--is-inside-work-tree'])
  if (!inside || inside.trim() !== 'true') return base
  const head = git(repoRoot, ['rev-parse', 'HEAD'])
  const gitHead = head && head.trim() ? head.trim() : null // null если нет коммитов
  const stash = git(repoRoot, ['stash', 'create'])
  const stashRef = stash && stash.trim() ? stash.trim() : null
  return { isGit: true, gitHead, stashRef, capturedAt: now }
}

export interface RunProvenance {
  providerId: string
  model: string | null
  transport: RuntimeTransport
  /** CLI с реализованной проекцией tool-таймлайна (виден, но исполняется вне Verstak). */
  observed: boolean
  checkpoint: ControlCheckpoint
  /** Человекочитаемая честная нота: уровень контроля + якорь отката. Без секретов. */
  note: string
}

function anchorNote(cp: ControlCheckpoint): string {
  if (cp.gitHead) {
    const snap = cp.stashRef ? ` (+снапшот грязных правок ${cp.stashRef.slice(0, 7)})` : ''
    return `Точка отката: git ${cp.gitHead.slice(0, 7)}${snap}.`
  }
  if (cp.isGit) return 'Git-репо без коммитов — якоря отката нет.'
  return 'Проект вне git — автоматической точки отката нет.'
}

export function buildRunProvenance(input: {
  providerId: string
  model: string | null
  transport: RuntimeTransport
  checkpoint: ControlCheckpoint
}): RunProvenance {
  const { providerId, model, transport, checkpoint } = input
  const observed = transport === 'CLI' && CLI_WITH_TIMELINE.has(providerId)
  const anchor = anchorNote(checkpoint)
  const note = transport === 'API'
    ? `Полный контроль: правки идут через инструменты Verstak (per-file undo). ${anchor}`
    : `Правки сделаны внутри CLI — per-file undo Verstak их не покрывает. ${anchor} Untracked-файлы в снапшот не входят.`
  return { providerId, model, transport, observed, checkpoint, note }
}

// ─── Восстановление по контрольной точке (1.9.6 задача #1) ──────────────────
// Ночью (срез 4) якорь только СНИМАЛСЯ; откатить его было нечем. Здесь —
// недеструктивный preview + явный apply, чтобы CLI-прогон можно было откатить
// одной кнопкой, а не руками в терминале.

/** Сериализовать якорь для queryable-хранения (agent_run_events.ref). Без секретов. */
export function serializeEnvelope(cp: ControlCheckpoint): string {
  return JSON.stringify({ gitHead: cp.gitHead, stashRef: cp.stashRef, isGit: cp.isGit })
}

/** Разобрать сохранённый якорь. null при битом/пустом JSON. */
export function parseEnvelope(raw: string | null | undefined): { gitHead: string | null; stashRef: string | null } | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw)
    if (o && typeof o === 'object' && ('gitHead' in o)) {
      return { gitHead: typeof o.gitHead === 'string' ? o.gitHead : null, stashRef: typeof o.stashRef === 'string' ? o.stashRef : null }
    }
  } catch { /* битый */ }
  return null
}

export interface RestorePreview {
  ok: boolean
  /** Причина отказа: не-git / нет якоря / репозиторий ушёл вперёд / ошибка git. */
  reason?: 'not-git' | 'no-anchor' | 'moved-on' | 'error'
  currentHead?: string | null
  gitHead?: string | null
  hasStash?: boolean
  /** Отслеживаемые файлы, которые изменятся при откате (git diff vs якорь). */
  changedFiles?: string[]
  /** Новые untracked-файлы после якоря — откат их НЕ удаляет (честный лимит). */
  untrackedFiles?: string[]
}

type Anchor = { gitHead: string | null; stashRef: string | null }

function isInsideRepo(repoRoot: string): boolean {
  const inside = git(repoRoot, ['rev-parse', '--is-inside-work-tree'])
  return !!inside && inside.trim() === 'true'
}

/**
 * Недеструктивный анализ: можно ли откатиться и что изменится. Только чтение git.
 * Отказ moved-on, если HEAD сдвинулся с момента якоря (пользователь закоммитил
 * поверх) — не трогаем ушедшую вперёд историю без явного решения.
 */
export function previewControlRestore(repoRoot: string | null, cp: Anchor): RestorePreview {
  if (!repoRoot || !isInsideRepo(repoRoot)) return { ok: false, reason: 'not-git' }
  if (!cp.gitHead) return { ok: false, reason: 'no-anchor' }
  const head = git(repoRoot, ['rev-parse', 'HEAD'])
  const currentHead = head ? head.trim() : null
  if (!currentHead) return { ok: false, reason: 'error' }
  if (currentHead !== cp.gitHead) return { ok: false, reason: 'moved-on', currentHead, gitHead: cp.gitHead }
  const diff = git(repoRoot, ['diff', '--name-only', cp.gitHead]) ?? ''
  const changedFiles = diff.split('\n').map(s => s.trim()).filter(Boolean)
  const untracked = git(repoRoot, ['ls-files', '--others', '--exclude-standard']) ?? ''
  const untrackedFiles = untracked.split('\n').map(s => s.trim()).filter(Boolean)
  return { ok: true, currentHead, gitHead: cp.gitHead, hasStash: !!cp.stashRef, changedFiles, untrackedFiles }
}

export interface RestoreResult {
  ok: boolean
  reason?: 'not-git' | 'no-anchor' | 'moved-on' | 'error'
  /** Отслеживаемые файлы, возвращённые к состоянию якоря. */
  restoredFiles?: string[]
  /** Применён ли snapshot грязных pre-run правок (git stash apply). */
  stashApplied?: boolean
  /** Новые untracked-файлы, которые откат НЕ удалил (пользователь чистит сам). */
  untrackedKept?: string[]
}

/**
 * Выполнить откат: отслеживаемые файлы → состояние якоря (`git checkout <sha> -- .`),
 * затем, если был snapshot грязных pre-run правок — применить его. Деструктивно
 * к правкам ПОСЛЕ якоря (это и есть цель отката CLI-прогона), но НЕ трогает
 * untracked-файлы (git clean не зовём) и НЕ двигает HEAD (moved-on → отказ).
 */
export function applyControlRestore(repoRoot: string | null, cp: Anchor): RestoreResult {
  const pre = previewControlRestore(repoRoot, cp)
  if (!pre.ok) return { ok: false, reason: pre.reason }
  const root = repoRoot as string
  const changed = pre.changedFiles ?? []
  // Откат отслеживаемых файлов к якорю. `-- .` восстанавливает всё рабочее дерево
  // из дерева якоря; HEAD не двигается (мы уже проверили currentHead === gitHead).
  const co = git(root, ['checkout', cp.gitHead as string, '--', '.'])
  if (co === null) return { ok: false, reason: 'error' }
  let stashApplied = false
  if (cp.stashRef) {
    // Вернуть грязные pre-run правки. Конфликт/ошибка не валит откат tracked —
    // stash best-effort (правки уже восстановлены к чистому якорю).
    const ap = git(root, ['stash', 'apply', cp.stashRef])
    stashApplied = ap !== null
  }
  return { ok: true, restoredFiles: changed, stashApplied, untrackedKept: pre.untrackedFiles ?? [] }
}
