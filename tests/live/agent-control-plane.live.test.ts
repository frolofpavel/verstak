import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../../electron/storage/db'
import { createAgentJobs } from '../../electron/storage/agent-jobs'
import { createUndoStack } from '../../electron/storage/undo'
import { AgentJobScheduler } from '../../electron/ai/agent-job-scheduler'
import { SubAgentQueue } from '../../electron/ai/sub-queue'
import { createToolsForProject } from '../../electron/ai/tools'
import { applyAgentJobVariant, rejectAgentJobVariant } from '../../electron/ai/job-variant'
import { delegateParallelHandler } from '../../electron/ipc/tool-handlers/delegation'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'

const LIVE = process.env.VERSTAK_LIVE_AGENT_SMOKE === '1'
const roots: string[] = []
const databases: Array<ReturnType<typeof openDb>> = []

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', windowsHide: true })
}

function createRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'verstak-agent-control-live-'))
  roots.push(root)
  git(root, 'init')
  git(root, 'config', 'user.email', 'live-smoke@verstak.local')
  git(root, 'config', 'user.name', 'Verstak Live Smoke')
  git(root, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, 'seed.txt'), 'CONTROL_PLANE_LIVE_SMOKE\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'live smoke baseline')
  return root
}

afterAll(() => {
  for (const db of databases) {
    try { db.close() } catch { /* already closed */ }
  }
  for (const root of roots) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

describe.skipIf(!LIVE)('Durable Agent Control Plane — live production route', () => {
  it('три реальных Codex-субагента проходят handler → scheduler → jobs → worktree → apply/undo', async () => {
    const root = createRepo()
    const dbPath = join(root, '.live-smoke.sqlite')
    const db = openDb(dbPath)
    databases.push(db)
    const jobs = createAgentJobs(db)
    const undo = createUndoStack(db)
    const scheduler = new AgentJobScheduler({ jobs, queue: new SubAgentQueue() })
    const events: unknown[] = []
    const journals: Array<{ title: string; detail?: string | null }> = []
    const ac = new AbortController()
    const ctx = {
      sender: {
        send: (_channel: string, payload: { event: unknown }) => events.push(payload.event),
        exec: async () => null,
      },
      sendId: 1,
      signal: ac.signal,
      projectPath: root,
      tools: createToolsForProject(root, ac.signal),
      recordWrite: () => undefined,
      recordPlan: () => ({ id: 1 }),
      recordJournal: (_projectPath: string, _kind: string, title: string, detail?: string | null) => {
        journals.push({ title, detail })
      },
      readJournal: () => [],
      saveMemory: () => ({ id: 'memory-live' }),
      saveDecision: () => ({ id: 1 }),
      searchMemories: () => [],
      searchConversations: () => [],
      connectors: { list: () => [], query: async () => null },
      pendingAttachments: [],
      pendingWrites: new Map(),
      pendingCommands: new Map(),
      scopedKey: (sendId: number, callId: string) => `${sendId}:${callId}`,
      agentMode: 'auto',
      getSecretForDelegate: () => null,
      currentProviderId: 'codex-cli',
      parentChatId: null,
      agentJobs: jobs,
      agentJobScheduler: scheduler,
    } as unknown as ToolContext

    const result = await delegateParallelHandler.handle({
      id: 'live-control-plane',
      name: 'delegate_parallel',
      args: {
        group: 'live-control-plane',
        cost_cap_usd: 2,
        tasks: [
          {
            id: 'writer-alpha',
            role: 'executor',
            provider_id: 'codex-cli',
            model: 'auto',
            prompt: 'Создай только файл alpha.txt с единственной строкой ALPHA. Не меняй другие файлы. Проверь содержимое файла.',
            read_scope: ['seed.txt'],
            write_scope: ['alpha.txt'],
          },
          {
            id: 'writer-beta',
            role: 'executor',
            provider_id: 'codex-cli',
            model: 'auto',
            prompt: 'Создай только файл beta.txt с единственной строкой BETA. Не меняй другие файлы. Проверь содержимое файла.',
            read_scope: ['seed.txt'],
            write_scope: ['beta.txt'],
          },
          {
            id: 'verifier',
            role: 'verifier',
            provider_id: 'codex-cli',
            model: 'auto',
            prompt: 'Прочитай seed.txt. Ничего не изменяй. В ответе явно укажи найденную строку.',
            read_scope: ['seed.txt'],
            write_scope: [],
          },
        ],
      },
    }, ctx)

    const stored = jobs.listProject(root)
    const writers = stored.filter(job => job.role === 'executor')
    const verifier = stored.find(job => job.role === 'verifier')
    expect(result.error).toBeUndefined()
    expect(stored).toHaveLength(3)
    expect(
      stored.every(job => job.status === 'succeeded'),
      JSON.stringify(stored.map(job => ({
        role: job.role,
        status: job.status,
        interruptionReason: job.interruptionReason,
        summary: job.result?.summary ?? null,
      }))),
    ).toBe(true)
    expect(writers).toHaveLength(2)
    expect(writers.every(job => Boolean(job.worktreePath))).toBe(true)
    expect(verifier?.worktreePath).toBeNull()
    expect(existsSync(join(root, 'alpha.txt'))).toBe(false)
    expect(existsSync(join(root, 'beta.txt'))).toBe(false)
    expect(readFileSync(join(root, 'seed.txt'), 'utf8')).toContain('CONTROL_PLANE_LIVE_SMOKE')
    expect(journals.some(item => item.title.includes('3/3'))).toBe(true)

    const finalEvents = events.filter((event): event is { type: string; status?: string; jobId?: string } =>
      Boolean(event && typeof event === 'object' && 'type' in event)
    )
    expect(finalEvents.filter(event => event.type === 'subagent-run' && event.status === 'done')).toHaveLength(3)
    expect(finalEvents.filter(event => event.type === 'subagent-run' && event.status === 'done')
      .every(event => Boolean(event.jobId))).toBe(true)

    const selected = writers.find(job => job.goal.includes('alpha.txt'))!
    const rejected = writers.find(job => job.id !== selected.id)!
    const applied = await applyAgentJobVariant(selected, undo)
    if (!applied.ok) throw new Error(`live apply failed: ${applied.error}`)
    expect(applied).toMatchObject({ ok: true, files: ['alpha.txt'], cleanupOk: true })
    expect(readFileSync(join(root, 'alpha.txt'), 'utf8').trim()).toBe('ALPHA')
    expect(existsSync(join(root, 'beta.txt'))).toBe(false)
    expect(undo.list(root).some(entry => entry.filePath === 'alpha.txt' && entry.beforeContent == null)).toBe(true)
    const rejectedResult = rejectAgentJobVariant(rejected)
    if (!rejectedResult.ok) throw new Error(`live reject failed: ${rejectedResult.error ?? 'unknown'}`)
    expect(rejectedResult).toMatchObject({ ok: true, removed: true })

  }, 600_000)
})
