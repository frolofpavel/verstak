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
