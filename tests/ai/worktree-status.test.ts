import { execFileSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { rmDirRobust } from '../../electron/ai/git-worktree'
import { tmpdir } from 'os'
import { join } from 'path'
import { detectWorktreeState, WorktreeStatusError } from '../../electron/ai/worktree-status'

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

describe('detectWorktreeState', () => {
  let root: string
  let repo: string
  let remote: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'verstak-wt-state-'))
    repo = join(root, 'repo')
    remote = join(root, 'remote.git')
    mkdirSync(repo)

    run(repo, ['init'])
    run(repo, ['checkout', '-b', 'main'])
    run(repo, ['config', 'user.email', 'test@example.com'])
    run(repo, ['config', 'user.name', 'Test User'])
    run(repo, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(repo, 'index.mjs'), 'export const value = 1\n')
    commit(repo, 'init')

    runGlobal(['init', '--bare', remote])
    run(repo, ['remote', 'add', 'origin', remote])
    run(repo, ['push', '-u', 'origin', 'main'])
  })

  afterEach(() => {
    // best-effort: EPERM под антивирусом НЕ ронять тест (среда, не дефект) — teardown-свип добьёт.
    try { rmDirRobust(root) } catch { /* teardown-свип globalSetup уберёт leftover */ }
  })

  it('reports a clean pushed worktree', async () => {
    const state = await detectWorktreeState(repo)
    expect(state).toEqual({
      dirty: false,
      unpushed: false,
      clean: true,
      dirtyFiles: 0,
      unpushedCommits: 0,
    })
  })

  it('reports dirty files without treating them as unpushed commits', async () => {
    writeFileSync(join(repo, 'index.mjs'), 'export const value = 2\n')
    writeFileSync(join(repo, 'extra.txt'), 'new\n')

    const state = await detectWorktreeState(repo)
    expect(state.dirty).toBe(true)
    expect(state.unpushed).toBe(false)
    expect(state.clean).toBe(false)
    expect(state.dirtyFiles).toBe(2)
    expect(state.unpushedCommits).toBe(0)
  })

  it('reports unpushed commits without dirty files', async () => {
    writeFileSync(join(repo, 'index.mjs'), 'export const value = 3\n')
    commit(repo, 'local change')

    const state = await detectWorktreeState(repo)
    expect(state.dirty).toBe(false)
    expect(state.unpushed).toBe(true)
    expect(state.clean).toBe(false)
    expect(state.dirtyFiles).toBe(0)
    expect(state.unpushedCommits).toBe(1)
  })

  it('reports dirty files and unpushed commits together', async () => {
    writeFileSync(join(repo, 'index.mjs'), 'export const value = 4\n')
    commit(repo, 'local change')
    writeFileSync(join(repo, 'extra.txt'), 'dirty after commit\n')

    const state = await detectWorktreeState(repo)
    expect(state.dirty).toBe(true)
    expect(state.unpushed).toBe(true)
    expect(state.clean).toBe(false)
    expect(state.dirtyFiles).toBe(1)
    expect(state.unpushedCommits).toBe(1)
  })

  it('throws a clear error for non-git folders', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    await expect(detectWorktreeState(plain)).rejects.toMatchObject({
      name: 'WorktreeStatusError',
      code: 'not-git',
    } satisfies Partial<WorktreeStatusError>)
  })
})
