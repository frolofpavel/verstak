import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// T1.2 HIGH-фикс (ревью 27.06): swarm isolate должен пере-рутить FileTools на
// worktree executor'а — иначе запись идёт в ГЛАВНОЕ дерево (изоляция инертна).
// Здесь прогоняем swarmHandler сквозь, мокнув sub-agent-loop: фейковый executor
// пишет файл через ПОЛУЧЕННЫЙ ctx.tools и мы проверяем, КУДА он реально записал.

// vi.hoisted — чтобы захват был доступен в hoisted-фабрике мока.
const { calls } = vi.hoisted(() => ({ calls: [] as Array<{ role: string | undefined; messages: { role: string; content: string }[]; toolsRoot: string }> }))

vi.mock('../../electron/ai/sub-agent-loop', () => ({
  runSubAgentLoop: vi.fn(async (opts: { role?: string; messages: { role: string; content: string }[]; ctx: { tools: { execute: (n: string, a: Record<string, unknown>) => Promise<unknown> } } }) => {
    calls.push({ role: opts.role, messages: opts.messages, toolsRoot: '' })
    // executor пишет файл через ПОЛУЧЕННЫЙ ctx.tools (должен быть зарулен на worktree).
    if (opts.role === 'executor') {
      await opts.ctx.tools.execute('write_file', { path: 'solver-out.txt', content: 'isolated write' })
      return { exitReason: 'done', text: 'СДЕЛАЛ: записал solver-out.txt', toolCallCount: 1 }
    }
    return { exitReason: 'done', text: 'ok', toolCallCount: 0 }
  })
}))

import { swarmHandler } from '../../electron/ipc/tool-handlers/delegation'
import { createToolsForProject } from '../../electron/ai/tools'

const CLEAN_ENV = (() => {
  const e: NodeJS.ProcessEnv = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete e[k]
  return e
})()
const gitRun = (dir: string, args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', env: CLEAN_ENV })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeCtx(repo: string, signal: AbortSignal): any {
  return {
    sender: { send: vi.fn() },
    sendId: 1,
    signal,
    projectPath: repo,
    tools: createToolsForProject(repo), // ГЛАВНЫЙ root
    currentProviderId: 'gemini-api',
    getSecretForDelegate: () => 'fake-key',
    recordWrite: vi.fn(),
    recordJournal: vi.fn(),
    agentMode: 'auto',
  }
}

describe('swarm isolate — изоляция executor в worktree (T1.2 HIGH-фикс)', () => {
  let repo: string
  beforeEach(() => {
    calls.length = 0
    repo = mkdtempSync(join(tmpdir(), 'gg-swarm-iso-'))
    gitRun(repo, ['init'])
    gitRun(repo, ['config', 'user.email', 't@t.t'])
    gitRun(repo, ['config', 'user.name', 'T'])
    gitRun(repo, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(repo, 'seed.txt'), 'seed\n')
    gitRun(repo, ['add', '-A'])
    gitRun(repo, ['commit', '-m', 'init'])
  })
  afterEach(() => { try { rmSync(repo, { recursive: true, force: true }) } catch { /* */ } })

  it('isolate=true: запись executor НЕ в главном дереве, diff дошёл до арбитра', async () => {
    const ac = new AbortController()
    await swarmHandler.handle({ id: 'c1', name: 'swarm', args: { goal: 'создай solver-out.txt', isolate: true, size: 3 } } as never, makeCtx(repo, ac.signal))

    // КЛЮЧЕВОЕ: запись executor'а изолирована — в главном дереве файла НЕТ.
    expect(existsSync(join(repo, 'solver-out.txt'))).toBe(false)
    expect(calls.some(c => c.role === 'executor')).toBe(true)
    // diff с файлом дошёл до арбитра (его сообщения содержат solver-out.txt).
    const arbiter = calls.find(c => c.messages?.[0]?.content?.includes('АРБИТР'))
    expect(arbiter).toBeTruthy()
    expect(JSON.stringify(arbiter!.messages)).toContain('solver-out.txt')
  }, 30000)

  it('isolate=false (контроль): запись executor идёт в главное дерево', async () => {
    const ac = new AbortController()
    await swarmHandler.handle({ id: 'c2', name: 'swarm', args: { goal: 'создай solver-out.txt', isolate: false, size: 3 } } as never, makeCtx(repo, ac.signal))
    expect(existsSync(join(repo, 'solver-out.txt'))).toBe(true)
  }, 30000)
})
