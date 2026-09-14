import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatEvent } from '../../electron/ai/types'
import type { AgentRun, AgentRunStatus } from '../../electron/storage/agent-runs'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const providerControl = vi.hoisted(() => ({
  releases: [] as Array<() => void>,
  literalSecret: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
  intermediateErrorAttempts: 0,
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
  app: { getPath: () => tmpdir() },
  BrowserWindow: { fromWebContents: () => null },
}))

vi.mock('../../electron/ai/registry', async importOriginal => {
  const actual = await importOriginal<typeof import('../../electron/ai/registry')>()
  return {
    ...actual,
    createProvider: () => ({
      id: 'claude', name: 'claude', models: ['m'],
      async *send(messages: unknown[], _tools: unknown[], _results?: unknown[], signal?: AbortSignal): AsyncGenerator<ChatEvent> {
        const prompt = String((messages as Array<{ content?: unknown }>).at(-1)?.content ?? '')
        if (prompt === '[cache-budget]') {
          for (let i = 0; i < 100; i++) {
            yield {
              type: 'pending-command', callId: `budget-${i}`,
              command: `npm test -- --filter=${'x'.repeat(4_000)}`, toolName: 'run_command',
            }
          }
        } else if (prompt === '[security]') {
          yield {
            type: 'pending-write', callId: 'write-secret', path: '.env',
            before: `OPENAI_API_KEY=${providerControl.literalSecret}`,
            after: `OPENAI_API_KEY=${providerControl.literalSecret}-changed`,
          } as unknown as ChatEvent
          yield {
            type: 'pending-write', callId: 'write-hidden-tail', path: 'src/critical.ts',
            before: 'x'.repeat(4_096) + '\nSAFE_OLD_VALUE',
            after: 'x'.repeat(4_096) + '\nDANGEROUS_EFFECTFUL_TAIL',
          } as unknown as ChatEvent
          yield {
            type: 'pending-command', callId: 'command-secret',
            command: `echo ${'x'.repeat(4_096)} && DANGEROUS_EFFECTFUL_TAIL`,
            toolName: 'execute_code',
          }
          yield {
            type: 'pending-command', callId: 'command-bounded',
            command: `curl --api-key ${providerControl.literalSecret}`,
            toolName: 'run_command',
          }
          yield {
            type: 'pending-browser-action', callId: 'browser-call', actionId: 'action-current',
            browserTaskId: 'bt-7', runId: 'browser-run', risk: 'R2', approvalDigest: 'digest-current',
            snapshot: {
              browserTaskId: 'bt-7', runId: 'browser-run', scope: {}, actionType: 'browser_click',
              payload: { selector: '#confirm', note: providerControl.literalSecret },
              preconditions: {}, risk: 'R2',
            },
            reason: `Ответственное действие ${providerControl.literalSecret}`,
          } as unknown as ChatEvent
          let deep: Record<string, unknown> = { value: providerControl.literalSecret }
          for (let i = 0; i < 10; i++) deep = { nested: deep }
          yield {
            type: 'pending-browser-action', callId: 'browser-deep', actionId: 'action-deep',
            browserTaskId: 'bt-7', runId: 'browser-run', risk: 'R2', approvalDigest: 'digest-deep',
            snapshot: deep, reason: 'deep',
          } as unknown as ChatEvent
          yield {
            type: 'pending-browser-action', callId: 'browser-oversized', actionId: 'action-oversized',
            browserTaskId: 'bt-7', runId: 'browser-run', risk: 'R2', approvalDigest: 'digest-oversized',
            snapshot: { payload: 'x'.repeat(100_000) }, reason: 'oversized',
          } as unknown as ChatEvent
          yield {
            type: 'pending-browser-action', callId: 'browser-reason-tail', actionId: 'action-reason-tail',
            browserTaskId: 'bt-7', runId: 'browser-run', risk: 'R2', approvalDigest: 'digest-reason-tail',
            snapshot: { actionType: 'browser_click', payload: { selector: '#confirm' } },
            reason: 'x'.repeat(4_096) + ' DANGEROUS_EFFECTFUL_TAIL',
          } as unknown as ChatEvent
        } else if (prompt === '[intermediate-error]') {
          if (providerControl.intermediateErrorAttempts++ === 0) {
            yield { type: 'error', message: 'Claude usage limit reached. Try again in 2 hours.' }
          } else {
            yield { type: 'pending-command', callId: 'fallback-call', command: 'npm test', toolName: 'run_command' }
            await new Promise<void>(resolve => {
              providerControl.releases.push(resolve)
              if (signal?.aborted) resolve()
              else signal?.addEventListener('abort', () => resolve(), { once: true })
            })
          }
        } else {
          yield { type: 'pending-command', callId: 'same-call', command: 'npm test', toolName: 'run_command' }
          yield {
            type: 'pending-browser-action', callId: 'browser-call', actionId: 'action-current',
            browserTaskId: 'bt-7', runId: 'browser-run', risk: 'R2', approvalDigest: 'digest-current',
            snapshot: {
              browserTaskId: 'bt-7', runId: 'browser-run', scope: {}, actionType: 'browser_click',
              payload: { selector: '#confirm' }, preconditions: {}, risk: 'R2',
            },
            reason: 'Ответственное действие',
          } as unknown as ChatEvent
        }
        await new Promise<void>(resolve => {
          providerControl.releases.push(resolve)
          if (signal?.aborted) resolve()
          else signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        yield { type: 'done' }
      },
    }),
  }
})

const { registerAiIpc } = await import('../../electron/ipc/ai')
const { pendingWrites, pendingCommands, pendingBrowserActions, scopedKey } = await import('../../electron/ai/runner-shared')

describe('ai:live-state — renderer reload recovery', () => {
  let dir: string
  let rows: AgentRun[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vst-live-state-'))
    rows = []
    handlers.clear()
    providerControl.releases.length = 0
    providerControl.intermediateErrorAttempts = 0
    pendingWrites.clear()
    pendingCommands.clear()
    pendingBrowserActions.clear()
  })

  afterEach(async () => {
    for (const row of rows) {
      await handlers.get('ai:stop')?.({}, row.sendId)
    }
    pendingWrites.clear()
    pendingCommands.clear()
    pendingBrowserActions.clear()
    rmSync(dir, { recursive: true, force: true })
  })

  function makeAgentRuns({ persistTerminal = true } = {}) {
    return {
      create: vi.fn((opts: Record<string, unknown>) => {
        const chatId = Number(opts.chatId)
        const generation = rows.filter(row => row.chatId === chatId && row.owner === opts.owner).length
        const now = Date.now()
        rows.push({
          runId: String(opts.runId), projectPath: String(opts.projectPath), chatId,
          owner: String(opts.owner) as AgentRun['owner'], title: String(opts.title), status: 'running',
          providerId: String(opts.providerId), model: String(opts.model), requestedProviderId: null,
          requestedModel: null, sendId: Number(opts.sendId), generation, agentsCount: 0, toolCount: 0,
          filesCount: 0, costCents: 0, error: null, startedAt: now + generation, endedAt: null,
          turnIndex: 0, lastToolName: null, lastCheckpointId: null, agentMode: 'ask', accountId: null,
          updatedAt: now, lastEventAt: now,
        })
        return generation
      }),
      list: vi.fn((projectPath: string, opts?: { owner?: string }) => rows.filter(row => (
        row.projectPath === projectPath && (!opts?.owner || row.owner === opts.owner)
      ))),
      get: vi.fn((runId: string) => rows.find(row => row.runId === runId) ?? null),
      appendEvent: vi.fn(), tick: vi.fn(), incr: vi.fn(), updateActual: vi.fn(), updateActualAccount: vi.fn(),
      persistUsage: vi.fn(), saveCheckpoint: vi.fn(), clearCheckpoint: vi.fn(),
      finish: vi.fn((runId: string, status: AgentRunStatus) => {
        const row = rows.find(candidate => candidate.runId === runId)
        if (!row || row.endedAt != null) return false
        if (!persistTerminal) return false
        row.status = status
        row.endedAt = Date.now()
        return true
      }),
    }
  }

  it('возвращает только max generation, его owner/approval и после Stop не воскрешает старое поколение', async () => {
    const agentRuns = makeAgentRuns()
    const deps = {
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'test-key' : null,
      getProviderId: () => 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8',
      getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites: () => [], getAgentMode: () => 'ask' as const,
      recordJournal: () => {}, searchMemories: () => [], getContextSnapshot: () => null,
      agentRuns,
    } as unknown as Parameters<typeof registerAiIpc>[0]
    registerAiIpc(deps)

    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, payload: { id: number; event: { type?: string; callId?: string; actionId?: string; approvalDigest?: string } }) => {
        if (payload.event.type === 'pending-write' && payload.event.callId) {
          pendingWrites.set(scopedKey(payload.id, payload.event.callId), { sendId: payload.id, resolve: vi.fn() })
        }
        if (payload.event.type === 'pending-command' && payload.event.callId) {
          pendingCommands.set(scopedKey(payload.id, payload.event.callId), { sendId: payload.id, resolve: vi.fn() })
        }
        if (payload.event.type === 'pending-browser-action' && payload.event.actionId) {
          pendingBrowserActions.set(scopedKey(payload.id, payload.event.actionId), {
            sendId: payload.id, browserTaskId: 'bt-7', runId: 'browser-run',
            expectedDigest: payload.event.approvalDigest ?? '', resolve: vi.fn(),
          })
        }
      },
    }
    const send = (chatId: number) => handlers.get('ai:send')!(
      { sender }, [{ role: 'user', content: 'сделай' }], dir, undefined, { noTools: true }, String(chatId),
    ) as Promise<number>

    const first = await send(7)
    await vi.waitFor(() => expect(pendingCommands.has(scopedKey(first, 'same-call'))).toBe(true))
    const second = await send(7)
    await vi.waitFor(() => {
      expect(pendingCommands.has(scopedKey(second, 'same-call'))).toBe(true)
      expect(pendingBrowserActions.has(scopedKey(second, 'action-current'))).toBe(true)
    })

    const live = await handlers.get('ai:live-state')!({}, dir) as {
      sends: Array<{
        sendId: number; generation: number; chatId: number
        pendingCommand: { callId: string; sendId: number } | null
        pendingBrowserAction: { actionId: string; approvalDigest: string; sendId: number } | null
      }>
    }
    expect(live.sends).toEqual([
      expect.objectContaining({
        sendId: second, generation: 1, chatId: 7,
        pendingCommand: expect.objectContaining({ callId: 'same-call', sendId: second }),
        pendingBrowserAction: expect.objectContaining({
          actionId: 'action-current', approvalDigest: 'digest-current', sendId: second,
        }),
      }),
    ])

    expect(await handlers.get('ai:stop')!({}, second)).toBe(true)
    const afterStop = await handlers.get('ai:live-state')!({}, dir) as { sends: unknown[] }
    expect(afterStop.sends, 'Stop нового поколения не должен воскресить старый send').toEqual([])
  })

  it('lost done: terminal send не воскресает в reload-window при DB=running + activeAbort, следующий send жив', async () => {
    const agentRuns = makeAgentRuns({ persistTerminal: false })
    const deps = {
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'test-key' : null,
      getProviderId: () => 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8', getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites: () => [], getAgentMode: () => 'ask' as const,
      recordJournal: () => {}, searchMemories: () => [], getContextSnapshot: () => null,
      agentRuns,
    } as unknown as Parameters<typeof registerAiIpc>[0]
    registerAiIpc(deps)

    let terminalSnapshot: Promise<{ sends: unknown[] }> | null = null
    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, payload: { id: number; event: { type?: string; callId?: string } }) => {
        if (payload.event.type === 'pending-command' && payload.event.callId) {
          pendingCommands.set(scopedKey(payload.id, payload.event.callId), { sendId: payload.id, resolve: vi.fn() })
        }
        // Production race: renderer теряет done и reload'ится, пока runner
        // ещё unwinding. Persistence в фикстуре намеренно остаётся running.
        if (payload.event.type === 'done' && terminalSnapshot == null) {
          terminalSnapshot = handlers.get('ai:live-state')!({}, dir) as Promise<{ sends: unknown[] }>
        }
      },
    }
    const send = (content: string) => handlers.get('ai:send')!(
      { sender }, [{ role: 'user', content }], dir, undefined, { noTools: true }, '7',
    ) as Promise<number>

    const first = await send('[terminal]')
    await vi.waitFor(() => expect(providerControl.releases.length).toBe(1))
    providerControl.releases.shift()!()
    await vi.waitFor(() => expect(terminalSnapshot).not.toBeNull())
    expect((await terminalSnapshot!).sends, 'terminal watermark обязан быть сильнее stale DB/Abort').toEqual([])

    await vi.waitFor(() => expect(handlers.get('ai:stop')!({}, first)).toBe(false))
    terminalSnapshot = null
    const second = await send('[ordinary-after-terminal]')
    await vi.waitFor(() => expect(pendingCommands.has(scopedKey(second, 'same-call'))).toBe(true))
    const live = await handlers.get('ai:live-state')!({}, dir) as { sends: Array<{ sendId: number }> }
    expect(live.sends.map(run => run.sendId)).toEqual([second])
  })

  it('intermediate error при plain fallback остаётся live до настоящего done', async () => {
    const agentRuns = makeAgentRuns({ persistTerminal: false })
    const deps = {
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'test-key' : null,
      getProviderId: () => 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8', getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites: () => [], getAgentMode: () => 'ask' as const,
      recordJournal: () => {}, searchMemories: () => [], getContextSnapshot: () => null,
      switchSubscriptionAccountOnLimit: () => ({ switched: true, newAccountId: 2 }),
      agentRuns,
    } as unknown as Parameters<typeof registerAiIpc>[0]
    registerAiIpc(deps)

    const seen: string[] = []
    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, payload: { id: number; event: { type?: string; callId?: string } }) => {
        if (payload.event.type) seen.push(payload.event.type)
        if (payload.event.type === 'pending-command' && payload.event.callId) {
          pendingCommands.set(scopedKey(payload.id, payload.event.callId), { sendId: payload.id, resolve: vi.fn() })
        }
      },
    }
    const sendId = await handlers.get('ai:send')!(
      { sender }, [{ role: 'user', content: '[intermediate-error]' }], dir, undefined, { noTools: true }, '7',
    ) as number

    await vi.waitFor(() => expect(pendingCommands.has(scopedKey(sendId, 'fallback-call'))).toBe(true))
    expect(seen).toContain('error')
    const duringFallback = await handlers.get('ai:live-state')!({}, dir) as { sends: Array<{ sendId: number }> }
    expect(duringFallback.sends.map(run => run.sendId), 'error fallback-попытки не terminal').toEqual([sendId])

    // Stop завершает уже fallback-попытку штатным final done. Это соседний
    // positive terminal-control к проверке промежуточного error выше.
    expect(await handlers.get('ai:stop')!({}, sendId)).toBe(true)
    await vi.waitFor(() => expect(seen).toContain('done'))
    expect(seen.filter(type => type === 'done')).toHaveLength(1)
    const afterDone = await handlers.get('ai:live-state')!({}, dir) as { sends: unknown[] }
    expect(afterDone.sends, 'только final done закрывает live send').toEqual([])
  })

  it('approval replay-cache маскирует bounded поля и fail-closed отбрасывает скрытый хвост/deep/oversized payload', async () => {
    const agentRuns = makeAgentRuns()
    const deps = {
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'test-key' : null,
      getProviderId: () => 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8', getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites: () => [], getAgentMode: () => 'ask' as const,
      recordJournal: () => {}, searchMemories: () => [], getContextSnapshot: () => null,
      agentRuns,
    } as unknown as Parameters<typeof registerAiIpc>[0]
    registerAiIpc(deps)

    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, payload: { id: number; event: Record<string, unknown> & { type?: string } }) => {
        const { event } = payload
        if (event.type === 'pending-write' && typeof event.callId === 'string') {
          pendingWrites.set(scopedKey(payload.id, event.callId), { sendId: payload.id, resolve: vi.fn() })
        } else if (event.type === 'pending-command' && typeof event.callId === 'string') {
          pendingCommands.set(scopedKey(payload.id, event.callId), { sendId: payload.id, resolve: vi.fn() })
        } else if (event.type === 'pending-browser-action' && typeof event.actionId === 'string') {
          pendingBrowserActions.set(scopedKey(payload.id, event.actionId), {
            sendId: payload.id, browserTaskId: String(event.browserTaskId), runId: String(event.runId),
            expectedDigest: String(event.approvalDigest), resolve: vi.fn(),
          })
        }
      },
    }
    const sendId = await handlers.get('ai:send')!(
      { sender }, [{ role: 'user', content: '[security]' }], dir, undefined, { noTools: true }, '7',
    ) as number
    await vi.waitFor(() => expect(pendingBrowserActions.has(scopedKey(sendId, 'action-oversized'))).toBe(true))

    const snapshot = async () => handlers.get('ai:live-state')!({}, dir) as Promise<{
      sends: Array<{
        pendingWrites: Array<{ callId: string; before: string; after: string }>
        pendingCommand: { callId: string; command: string } | null
        pendingBrowserAction: { actionId: string; snapshot: Record<string, unknown>; reason: string } | null
      }>
    }>
    const live = await snapshot()
    expect(live.sends).toHaveLength(1)
    expect(JSON.stringify(live)).not.toContain(providerControl.literalSecret)
    expect(live.sends[0].pendingCommand?.callId, 'bounded command обязан replay').toBe('command-bounded')
    expect(live.sends[0].pendingWrites).toHaveLength(1)
    expect(live.sends[0].pendingWrites[0].callId, 'bounded write обязан replay').toBe('write-secret')
    expect(live.sends[0].pendingWrites[0].before).toContain('[SECRET:')
    expect(live.sends[0].pendingWrites[0].after).toContain('[SECRET:')
    expect(live.sends[0].pendingBrowserAction?.actionId, 'oversized reason/snapshot должен fail-closed').toBe('action-current')

    pendingCommands.delete(scopedKey(sendId, 'command-bounded'))
    const withoutBoundedCommand = await snapshot()
    expect(withoutBoundedCommand.sends[0].pendingCommand, 'command со скрытым хвостом нельзя replay').toBeNull()

    pendingBrowserActions.delete(scopedKey(sendId, 'action-oversized'))
    const withoutOversized = await snapshot()
    expect(withoutOversized.sends[0].pendingBrowserAction?.actionId, 'depth > 6 должен fail-closed').toBe('action-current')
  })

  it('approval replay-cache ограничен 256 KiB суммарно, а не только count-cap', async () => {
    const agentRuns = makeAgentRuns()
    const deps = {
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'test-key' : null,
      getProviderId: () => 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8', getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites: () => [], getAgentMode: () => 'ask' as const,
      recordJournal: () => {}, searchMemories: () => [], getContextSnapshot: () => null,
      agentRuns,
    } as unknown as Parameters<typeof registerAiIpc>[0]
    registerAiIpc(deps)

    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, payload: { id: number; event: { type?: string; callId?: string } }) => {
        if (payload.event.type === 'pending-command' && payload.event.callId) {
          pendingCommands.set(scopedKey(payload.id, payload.event.callId), { sendId: payload.id, resolve: vi.fn() })
        }
      },
    }
    const sendId = await handlers.get('ai:send')!(
      { sender }, [{ role: 'user', content: '[cache-budget]' }], dir, undefined, { noTools: true }, '7',
    ) as number
    await vi.waitFor(() => expect(pendingCommands.has(scopedKey(sendId, 'budget-99'))).toBe(true))

    let replayable = 0
    for (let i = 0; i < 100; i++) {
      const live = await handlers.get('ai:live-state')!({}, dir) as {
        sends: Array<{ pendingCommand: { callId: string } | null }>
      }
      const pending = live.sends[0]?.pendingCommand
      if (!pending) break
      replayable++
      pendingCommands.delete(scopedKey(sendId, pending.callId))
    }
    expect(replayable, 'сто по 4 KiB не должны умещаться в 256 KiB').toBeLessThanOrEqual(64)
    expect(replayable).toBeGreaterThan(0)
  })
})
