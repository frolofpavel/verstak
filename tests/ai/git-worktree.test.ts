import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { addWorktree, removeWorktree, listWorktrees, worktreeDiff, isGitRepo, mergeWorktreeToMain } from '../../electron/ai/git-worktree'

// Реальные git-субпроцессы (init/commit/worktree add/remove) под полной параллельной
// нагрузкой suite могут превысить дефолтный таймаут 5с → щедрый запас против флака.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

// Под gate-хуком (pre-commit) git выставляет GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE,
// которые наследуются дочерними git и переопределяют `-C <tempdir>` → setup адресует
// главный репо. Снимаем их и здесь (helper делает то же внутри).
const CLEAN_ENV = (() => {
  const e: NodeJS.ProcessEnv = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete e[k]
  return e
})()
const gitRun = (dir: string, args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', env: CLEAN_ENV })

// T1.2 — git-worktree изоляция параллельных агентов. Тесты на РЕАЛЬНОМ git
// (git всегда доступен — проект сам в git, в отличие от ffmpeg/pyright).
function gitInit(dir: string) {
  gitRun(dir, ['init'])
  gitRun(dir, ['config', 'user.email', 't@t.t'])
  gitRun(dir, ['config', 'user.name', 'T'])
  gitRun(dir, ['config', 'commit.gpgsign', 'false'])
}

describe('git-worktree (T1.2)', () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gg-wt-repo-'))
    gitInit(repo)
    writeFileSync(join(repo, 'a.txt'), 'hello\n')
    gitRun(repo, ['add', '-A'])
    gitRun(repo, ['commit', '-m', 'init'])
  })
  afterEach(() => { try { rmSync(repo, { recursive: true, force: true }) } catch { /* */ } })

  it('isGitRepo: true для репо, false для обычной папки', () => {
    expect(isGitRepo(repo)).toBe(true)
    const plain = mkdtempSync(join(tmpdir(), 'gg-plain-'))
    expect(isGitRepo(plain)).toBe(false)
    rmSync(plain, { recursive: true, force: true })
  })

  it('addWorktree создаёт изолированный worktree с копией tracked-файлов', () => {
    const wt = addWorktree(repo, 'solver-1')
    expect(wt).not.toBeNull()
    expect(existsSync(join(wt!, 'a.txt'))).toBe(true)
    // нормализуем CRLF — git на Windows может checkout'ить с autocrlf
    expect(readFileSync(join(wt!, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('hello\n')
    expect(listWorktrees(repo).length).toBe(2) // main + worktree
    removeWorktree(repo, wt!)
  })

  it('правка в worktree изолирована от main; diff показывает её (вкл. новый файл)', () => {
    const wt = addWorktree(repo, 'wt')!
    writeFileSync(join(wt, 'a.txt'), 'changed\n')       // модификация tracked
    writeFileSync(join(wt, 'new.txt'), 'brand new\n')   // новый файл
    const diff = worktreeDiff(wt)
    expect(diff).toContain('changed')
    expect(diff).toContain('new.txt')
    // main НЕ затронут — изоляция работает
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('hello\n')
    expect(existsSync(join(repo, 'new.txt'))).toBe(false)
    removeWorktree(repo, wt)
  })

  it('removeWorktree удаляет worktree из ФС и из списка', () => {
    const wt = addWorktree(repo, 'gone')!
    expect(existsSync(wt)).toBe(true)
    const ok = removeWorktree(repo, wt)
    expect(ok).toBe(true)
    expect(existsSync(wt)).toBe(false)
    expect(listWorktrees(repo).length).toBe(1) // только main
  })

  it('addWorktree на не-git папке → null (graceful)', () => {
    const plain = mkdtempSync(join(tmpdir(), 'gg-plain2-'))
    expect(addWorktree(plain)).toBeNull()
    rmSync(plain, { recursive: true, force: true })
  })

  // Ревью 27.06 (MEDIUM): >16MB diff → ENOBUFS → раньше тихо ''=«нет изменений».
  it('worktreeDiff на огромном (>16MB) изменении не врёт «нет изменений» — даёт сводку', () => {
    const wt = addWorktree(repo, 'big')!
    writeFileSync(join(wt, 'big.txt'), 'x'.repeat(17 * 1024 * 1024)) // >16MB → ENOBUFS на git diff
    const diff = worktreeDiff(wt)
    expect(diff).not.toBe('') // НЕ молчим про реальные правки
    expect(diff).toContain('big.txt')
    expect(diff).toContain('слишком большой')
    removeWorktree(repo, wt)
  })

  // #5 локальный merge worktree → main (git apply, без push).
  it('mergeWorktreeToMain применяет изменения worktree в main (модиф + новый файл)', () => {
    const wt = addWorktree(repo, 'm')!
    writeFileSync(join(wt, 'a.txt'), 'merged\n')      // модификация tracked
    writeFileSync(join(wt, 'new.txt'), 'brand new\n') // новый файл
    const r = mergeWorktreeToMain(repo, wt)
    expect(r.ok).toBe(true)
    expect(readFileSync(join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('merged\n')
    expect(existsSync(join(repo, 'new.txt'))).toBe(true)
    removeWorktree(repo, wt)
  })

  it('mergeWorktreeToMain без изменений → ok', () => {
    const wt = addWorktree(repo, 'm2')!
    expect(mergeWorktreeToMain(repo, wt).ok).toBe(true)
    removeWorktree(repo, wt)
  })

  it('mergeWorktreeToMain конфликт (main разошёлся) → ok:false, main НЕ тронут (атомарно)', () => {
    const wt = addWorktree(repo, 'm3')!
    writeFileSync(join(repo, 'a.txt'), 'main-changed\n') // main разошёлся с HEAD
    writeFileSync(join(wt, 'a.txt'), 'wt-changed\n')     // worktree по-другому
    const r = mergeWorktreeToMain(repo, wt)
    expect(r.ok).toBe(false) // патч не лёг — контекст не совпал
    expect(readFileSync(join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('main-changed\n') // main цел
    removeWorktree(repo, wt)
  })

  // Ревью 27.06 (LOW): removeWorktree не должен рекурсивно сносить чужого родителя.
  it('removeWorktree НЕ удаляет родителя, если путь не verstak-wt- под tmpdir', () => {
    const safe = mkdtempSync(join(tmpdir(), 'gg-safe-'))
    writeFileSync(join(safe, 'sentinel.txt'), 'не трогать')
    // путь, не созданный addWorktree (родитель — gg-safe-, не verstak-wt-)
    removeWorktree(repo, join(safe, 'sub'))
    expect(existsSync(join(safe, 'sentinel.txt'))).toBe(true) // родитель цел
    rmSync(safe, { recursive: true, force: true })
  })
})
