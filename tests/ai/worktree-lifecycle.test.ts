import { execFileSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import {
  addWorktree,
  listWorktrees,
  removeWorktree,
  restoreWorktreeSnapshot,
  rmDirRobust,
} from '../../electron/ai/git-worktree'
import {
  removeWorktreeLossless,
  gcWorktrees,
  reconcileOrphanWorktrees,
  type WorktreeGcEntry,
} from '../../electron/ai/worktree-lifecycle'

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

const CLEAN_ENV = (() => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_COMMON_DIR',
    'GIT_PREFIX',
    'GIT_NAMESPACE',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ]) delete env[key]
  return env
})()

function run(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    windowsHide: true,
    env: CLEAN_ENV,
  })
}

function runGlobal(args: string[]): void {
  execFileSync('git', args, {
    stdio: 'pipe',
    windowsHide: true,
    env: CLEAN_ENV,
  })
}

function commit(repo: string, message: string): void {
  run(repo, ['add', '-A'])
  run(repo, ['commit', '-m', message])
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a).replace(/\\/g, '/').toLowerCase()
  const right = resolve(b).replace(/\\/g, '/').toLowerCase()
  return left === right
}

describe('worktree lifecycle snapshots', () => {
  let root: string
  let repo: string
  let remote: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'verstak-wt-life-'))
    repo = join(root, 'repo')
    remote = join(root, 'remote.git')
    mkdirSync(repo)

    run(repo, ['init'])
    run(repo, ['checkout', '-b', 'main'])
    run(repo, ['config', 'user.email', 'test@example.com'])
    run(repo, ['config', 'user.name', 'Test User'])
    run(repo, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(repo, 'a.txt'), 'base\n')
    commit(repo, 'init')

    runGlobal(['init', '--bare', remote])
    run(repo, ['remote', 'add', 'origin', remote])
    run(repo, ['push', '-u', 'origin', 'main'])
  })

  afterEach(() => {
    try {
      for (const wt of listWorktrees(repo)) {
        if (!samePath(wt, repo)) removeWorktree(repo, wt)
      }
    } catch {
      // best-effort cleanup
    }
    // best-effort: EPERM под антивирусом (хендл temp-дерева) НЕ должен ронять тест — это среда,
    // не продуктовый дефект. Leftover добьёт teardown-свип globalSetup (temp-sweep.ts, карточка #1).
    try { rmDirRobust(root) } catch { /* teardown-свип уберёт */ }
  })

  it('refuses to remove dirty worktree without force', async () => {
    const wt = addWorktree(repo, 'dirty')!
    writeFileSync(join(wt, 'a.txt'), 'dirty\n')

    const result = await removeWorktreeLossless(repo, wt)
    expect(result.ok).toBe(false)
    expect(result.removed).toBe(false)
    expect(result.error).toContain('unsaved state')
    expect(existsSync(wt)).toBe(true)
  })

  it('snapshots dirty worktree before forced remove and restores it', async () => {
    const wt = addWorktree(repo, 'dirty-snapshot')!
    writeFileSync(join(wt, 'a.txt'), 'dirty restored\n')
    writeFileSync(join(wt, 'new.txt'), 'new restored\n')

    const result = await removeWorktreeLossless(repo, wt, { force: true, snapshot: true })
    expect(result.ok).toBe(true)
    expect(result.removed).toBe(true)
    expect(result.snapshotRef).toContain('/stash/')
    expect(result.baseRef).toBeTruthy()
    expect(existsSync(wt)).toBe(false)

    const restored = restoreWorktreeSnapshot(repo, result.snapshotRef!, result.baseRef!, 'restored-dirty')
    expect(restored.ok).toBe(true)
    expect(readFileSync(join(restored.worktreePath!, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('dirty restored\n')
    expect(readFileSync(join(restored.worktreePath!, 'new.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('new restored\n')
  })

  it('preserves an unpushed detached worktree commit before forced remove', async () => {
    const wt = addWorktree(repo, 'unpushed')!
    writeFileSync(join(wt, 'a.txt'), 'committed in worktree\n')
    commit(wt, 'worktree commit')

    const result = await removeWorktreeLossless(repo, wt, { force: true, snapshot: true })
    expect(result.ok).toBe(true)
    expect(result.snapshotRef).toContain('/head/')
    expect(existsSync(wt)).toBe(false)

    const restored = restoreWorktreeSnapshot(repo, result.snapshotRef!, result.baseRef!, 'restored-head')
    expect(restored.ok).toBe(true)
    expect(readFileSync(join(restored.worktreePath!, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('committed in worktree\n')
  })

  it('removes clean pushed worktree without creating snapshot refs', async () => {
    const wt = addWorktree(repo, 'clean')!
    const result = await removeWorktreeLossless(repo, wt)
    expect(result.ok).toBe(true)
    expect(result.snapshotRef).toBeNull()
    expect(result.baseRef).toBeNull()
    expect(existsSync(wt)).toBe(false)
  })

  it('gcWorktrees removes idle clean ended sessions, keeps active/fresh/dirty (WT-05)', async () => {
    const DAY = 24 * 60 * 60 * 1000
    const T = 1_000_000_000_000

    const wtIdle = addWorktree(repo, 'idle-ended')!       // ended + idle + clean → удаляем
    const wtFresh = addWorktree(repo, 'fresh-ended')!     // ended, но не idle → бережём
    const wtActive = addWorktree(repo, 'active-idle')!    // idle, но активна → не осиротим
    const wtDirty = addWorktree(repo, 'dirty-ended')!     // ended + idle, но грязный → бережём
    writeFileSync(join(wtDirty, 'a.txt'), 'uncommitted\n')

    const sessions: WorktreeGcEntry[] = [
      { chatId: 1, worktreePath: wtIdle, state: 'dismissed', lastActiveAt: T - 10 * DAY, removedAt: null },
      { chatId: 2, worktreePath: wtFresh, state: 'merged', lastActiveAt: T, removedAt: null },
      { chatId: 3, worktreePath: wtActive, state: 'active', lastActiveAt: T - 10 * DAY, removedAt: null },
      { chatId: 4, worktreePath: wtDirty, state: 'dismissed', lastActiveAt: T - 10 * DAY, removedAt: null },
    ]
    const markRemoved = vi.fn()

    const res = await gcWorktrees(repo, {
      now: () => T,
      listSessions: () => sessions,
      markRemoved,
    })

    expect(res.removed).toEqual([wtIdle])
    expect(existsSync(wtIdle)).toBe(false)
    expect(existsSync(wtFresh)).toBe(true)   // не idle
    expect(existsSync(wtActive)).toBe(true)  // активная
    expect(existsSync(wtDirty)).toBe(true)   // грязная — бережём (lossless без force)
    expect(res.skipped).toContain(wtDirty)
    expect(markRemoved).toHaveBeenCalledTimes(1)
    expect(markRemoved).toHaveBeenCalledWith(1, wtIdle, T)
  })

  it('reconcileOrphanWorktrees removes orphans absent from active registry (WT-05)', () => {
    const wtKeep = addWorktree(repo, 'registered')!
    const wtOrphan = addWorktree(repo, 'orphan')!

    const res = reconcileOrphanWorktrees(repo, { activePaths: () => [wtKeep] })

    expect(existsSync(wtOrphan)).toBe(false)
    expect(existsSync(wtKeep)).toBe(true)
    expect(res.removed.some(p => samePath(p, wtOrphan))).toBe(true)
    expect(res.removed.some(p => samePath(p, wtKeep))).toBe(false)
  })

  it('keeps lifecycle helpers push-free', () => {
    const files = [
      readFileSync('electron/ai/git-worktree.ts', 'utf8'),
      readFileSync('electron/ai/worktree-lifecycle.ts', 'utf8'),
      readFileSync('electron/ai/worktree-status.ts', 'utf8'),
    ].join('\n')
    expect(files).not.toMatch(/['"]push['"]/)
  })
})
