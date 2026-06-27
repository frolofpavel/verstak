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
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

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
export function addWorktree(repoRoot: string, label = 'wt'): string | null {
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
  const out = git(repoRoot, ['worktree', 'add', '--detach', dir, 'HEAD'])
  if (out == null) {
    try { rmSync(parent, { recursive: true, force: true }) } catch { /* best-effort */ }
    return null
  }
  return dir
}

/**
 * Удалить worktree (--force: даже с незакоммиченными правками) + prune + почистить
 * tmp-родителя. true — git remove прошёл.
 */
export function removeWorktree(repoRoot: string, worktreePath: string): boolean {
  const out = git(repoRoot, ['worktree', 'remove', '--force', worktreePath])
  git(repoRoot, ['worktree', 'prune'])
  // Чистим tmp-родителя ТОЛЬКО если это наш verstak-wt- каталог под tmpdir() —
  // защита от рекурсивного сноса чужого пути, если worktreePath не из addWorktree.
  const parent = dirname(worktreePath)
  if (parent.startsWith(tmpdir()) && /[\\/]verstak-wt-[^\\/]*$/.test(parent)) {
    try { rmSync(parent, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
  return out != null
}

/** Список путей worktree'ов репозитория (включая основной). [] — не git. */
export function listWorktrees(repoRoot: string): string[] {
  const out = git(repoRoot, ['worktree', 'list', '--porcelain'])
  if (out == null) return []
  const prefix = 'worktree '
  return out.split('\n')
    .filter(l => l.startsWith(prefix))
    .map(l => l.slice(prefix.length).trim())
    .filter(Boolean)
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
