import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { addWorktree, removeWorktree } from '../../electron/ai/git-worktree'
import { applyAgentJobVariant, rejectAgentJobVariant } from '../../electron/ai/job-variant'
import type { AgentJobV1 } from '../../shared/contracts/agent-job'
import type { UndoEntry, UndoStack } from '../../electron/storage/undo'

const dirs: string[] = []
const worktrees: Array<{ repo: string; path: string }> = []

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', windowsHide: true })
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'verstak-job-smoke-'))
  dirs.push(root)
  git(root, 'init')
  git(root, 'config', 'user.email', 'smoke@verstak.local')
  git(root, 'config', 'user.name', 'Verstak Smoke')
  writeFileSync(join(root, 'shared.txt'), 'main\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'base')
  return root
}

function job(id: string, root: string, worktreePath: string): AgentJobV1 {
  return {
    schemaVersion: 1, id, projectPath: root, chatId: 1, pipelineId: null, planId: null,
    planStepId: null, parentJobId: null, groupId: 'g', kind: 'parallel-member',
    role: 'executor', goal: id, status: 'succeeded', dependsOn: [], readScope: ['**'],
    writeScope: ['**'], providerId: 'test', model: 'test', accountId: null, attempt: 1,
    maxAttempts: 2, callId: id, subSessionId: null, runId: null, worktreePath,
    costCapCents: null, costUsedCents: 0, interruptionReason: null, waitingReason: null,
    result: null, outcomeRowId: null, createdAt: 1, updatedAt: 1, startedAt: 1, finishedAt: 2,
  }
}

function undoHarness() {
  const entries: UndoEntry[] = []
  const stack = {
    push(_projectPath: string, filePath: string, before: string | null, after: string) {
      const entry = {
        id: entries.length + 1, filePath, beforeContent: before, afterContent: after,
        createdAt: Date.now(), runId: null, chatId: null, messageId: null,
        beforeHash: null, afterHash: null,
      }
      entries.push(entry)
      return entry
    },
    pop(id: number) {
      const index = entries.findIndex(entry => entry.id === id)
      return index >= 0 ? entries.splice(index, 1)[0] : null
    },
  } as unknown as UndoStack
  return { stack, entries }
}

afterEach(() => {
  for (const item of worktrees.splice(0)) {
    try { removeWorktree(item.repo, item.path) } catch { /* best-effort */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Windows dual-writer worktree smoke', () => {
  it('два writer не меняют main; reject не попадает; selected apply создаёт undo', async () => {
    const root = repo()
    const a = addWorktree(root, 'writer-a')!
    const b = addWorktree(root, 'writer-b')!
    worktrees.push({ repo: root, path: a }, { repo: root, path: b })
    writeFileSync(join(a, 'shared.txt'), 'variant-a\n')
    writeFileSync(join(b, 'shared.txt'), 'variant-b\n')

    expect(readFileSync(join(root, 'shared.txt'), 'utf8')).toBe('main\n')
    expect(rejectAgentJobVariant(job('b', root, b))).toMatchObject({ ok: true, removed: true })
    worktrees.splice(worktrees.findIndex(item => item.path === b), 1)
    expect(readFileSync(join(root, 'shared.txt'), 'utf8')).toBe('main\n')

    const undo = undoHarness()
    const applied = await applyAgentJobVariant(job('a', root, a), undo.stack)
    expect(applied).toMatchObject({ ok: true, files: ['shared.txt'], cleanupOk: true })
    worktrees.splice(worktrees.findIndex(item => item.path === a), 1)
    const actual = readFileSync(join(root, 'shared.txt'), 'utf8')
    expect(actual.replace(/\r\n/g, '\n')).toBe('variant-a\n')
    expect(undo.entries[0]).toMatchObject({ filePath: 'shared.txt', beforeContent: 'main\n', afterContent: actual })
  })

  it('cleanup failure виден и не превращается в ложный успех cleanup', async () => {
    const root = repo()
    const path = addWorktree(root, 'writer-cleanup')!
    worktrees.push({ repo: root, path })
    writeFileSync(join(path, 'shared.txt'), 'selected\n')
    const result = await applyAgentJobVariant(job('cleanup', root, path), undoHarness().stack, {
      remove: () => false,
    })
    expect(result).toMatchObject({ ok: true, cleanupOk: false })
    expect(result.ok && result.warning).toContain('cleanup')
  })

  it('сбой undo-записи откатывает уже применённый файл', async () => {
    const root = repo()
    const path = addWorktree(root, 'writer-undo-fail')!
    worktrees.push({ repo: root, path })
    writeFileSync(join(path, 'shared.txt'), 'must-rollback\n')
    const brokenUndo = {
      push: () => { throw new Error('db unavailable') },
      pop: () => null,
    } as unknown as UndoStack
    const result = await applyAgentJobVariant(job('undo-fail', root, path), brokenUndo)
    expect(result).toMatchObject({ ok: false })
    expect(readFileSync(join(root, 'shared.txt'), 'utf8')).toBe('main\n')
  })
})
