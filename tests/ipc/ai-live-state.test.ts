import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatEvent } from '../../electron/ai/types'
import type { AgentRun, AgentRunStatus } from '../../electron/storage/agent-runs'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const syncHandlers = new Map<string, (...args: unknown[]) => unknown>()
const providerControl = vi.hoisted(() => ({
  releases: [] as Array<() => void>,
  literalSecret: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
  intermediateErrorAttempts: 0,
  createProviderCalls: 0,
  providerSendCalls: 0,
  lastMessages: [] as unknown[],
  failBeforeTool: false,
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
    on: (channel: string, handler: (...args: unknown[]) => unknown) => syncHandlers.set(channel, handler),
  },
  app: { getPath: () => tmpdir() },
  BrowserWindow: { fromWebContents: () => null },
}))

vi.mock('../../electron/ai/registry', async importOriginal => {
  const actual = await importOriginal<typeof import('../../electron/ai/registry')>()
  return {
    ...actual,
    createProvider: () => {
      providerControl.createProviderCalls++
      return {
        id: 'claude', name: 'claude', models: ['m'],
        async *send(messages: unknown[], _tools: unknown[], _results?: unknown[], signal?: AbortSignal): AsyncGenerator<ChatEvent> {
          providerControl.providerSendCalls++
          providerControl.lastMessages = messages
          if (providerControl.failBeforeTool) {
            yield { type: 'error', message: 'simulated pre-tool provider failure' }
            yield { type: 'done' }
            return
          }
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
      }
    },
  }
})

const { registerAiIpc: registerAiIpcBase } = await import('../../electron/ipc/ai')
const registerAiIpc = (deps: Parameters<typeof registerAiIpcBase>[0]) => registerAiIpcBase({
  ...deps,
  consumeComputerUseComposerActivation: () => true,
})
const { pendingWrites, pendingCommands, pendingBrowserActions, scopedKey } = await import('../../electron/ai/runner-shared')
const { configureComputerHandler } = await import('../../electron/ipc/tool-handlers/computer')

describe('ai:live-state — renderer reload recovery', () => {
  let dir: string
  let rows: AgentRun[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vst-live-state-'))
    rows = []
    handlers.clear()
    syncHandlers.clear()
    providerControl.releases.length = 0
    providerControl.intermediateErrorAttempts = 0
    providerControl.createProviderCalls = 0
    providerControl.providerSendCalls = 0
    providerControl.lastMessages = []
    providerControl.failBeforeTool = false
    pendingWrites.clear()
    pendingCommands.clear()
    pendingBrowserActions.clear()
    configureComputerHandler({ controller: null })
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

  function makeTaintBrowserTasks() {
    const tasks = new Map<string, { browserTaskId: string; projectPath: string; chatId: number | null; caps: Record<string, unknown> }>()
    return {
      tasks,
      get: vi.fn((browserTaskId: string) => tasks.get(browserTaskId) ?? null),
      listActions: vi.fn(() => []),
      create: vi.fn((input: { browserTaskId: string; projectPath: string; chatId?: number | null; caps?: Record<string, unknown> }) => {
        tasks.set(input.browserTaskId, {
          browserTaskId: input.browserTaskId,
          projectPath: input.projectPath,
          chatId: input.chatId ?? null,
          caps: input.caps ?? {},
        })
      }),
      setCaps: vi.fn((browserTaskId: string, caps: Record<string, unknown>) => {
        const task = tasks.get(browserTaskId)
        if (task) tasks.set(browserTaskId, { ...task, caps })
      }),
    }
  }

  function mintComposerTicket(
    sender: { id: number },
    chatId: number,
    canonicalUserContent: string,
  ): string {
    const event = { sender, returnValue: null as unknown }
    syncHandlers.get('ai:mint-computer-use-composer-ticket')!(
      event,
      String(chatId),
      canonicalUserContent,
      { kind: 'keyboard', key: 'Enter' },
    )
    expect(event.returnValue).toEqual(expect.any(String))
    return event.returnValue as string
  }

  it('coalesces concurrent ai:stop calls for one exact pre-model Computer Use claim', async () => {
    const authorizeRun = vi.fn((_lineage: { browserTaskId: string; runId: string }) => ({
      ok: true,
      bindingGeneration: 2,
      expiresAt: Date.now() + 60_000,
    }))
    let acknowledgeHelper!: () => void
    const helperAck = new Promise<void>(resolve => { acknowledgeHelper = resolve })
    const cancelRun = vi.fn(() => helperAck)
    configureComputerHandler({ controller: { authorizeRun, cancelRun } as never })
    const agentRuns = makeAgentRuns()
    registerAiIpc({
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'test-key' : null,
      getProviderId: () => 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8', getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites: () => [], getAgentMode: () => 'auto' as const,
      recordJournal: () => {}, searchMemories: () => [], getContextSnapshot: () => null,
      getLatestChatUserMessage: (chatId: number) => chatId === 77
        ? { id: 701, sessionId: 77, role: 'user', content: '/computer-use в выбранном окне нажми кнопку Сохранить' }
        : null,
      agentRuns,
    } as unknown as Parameters<typeof registerAiIpc>[0])

    const sender = { id: 101, isDestroyed: () => false, send: vi.fn() }
    const originalUserText = '/computer-use в выбранном окне нажми кнопку Сохранить'
    const ticket = mintComposerTicket(sender, 77, originalUserText)
    const sendId = await handlers.get('ai:send')!(
      { sender },
      [{ role: 'user', content: originalUserText }],
      dir,
      undefined,
      { agentMode: 'auto' },
      '77',
      { ticket, userMessageId: 701 },
    ) as number
    await vi.waitFor(() => expect(authorizeRun).toHaveBeenCalledTimes(1))
    const lineage = authorizeRun.mock.calls[0]![0] as { browserTaskId: string; runId: string }

    let stopSettled = false
    const firstStopCall = handlers.get('ai:stop')!({}, sendId) as Promise<boolean>
    const stopped = firstStopCall.then(value => {
      stopSettled = true
      return value
    })
    await vi.waitFor(() => expect(cancelRun).toHaveBeenCalledWith(lineage.browserTaskId, lineage.runId))
    let duplicateStopSettled = false
    const duplicateStopCall = handlers.get('ai:stop')!({}, sendId) as Promise<boolean>
    const duplicateStopped = duplicateStopCall.then(value => {
      duplicateStopSettled = true
      return value
    })
    let stopAllSettled = false
    const stoppedAll = Promise.resolve(handlers.get('ai:stop')!({}, 0)).then(value => {
      stopAllSettled = true
      return value
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    try {
      expect(duplicateStopCall).toBe(firstStopCall)
      expect(stopSettled).toBe(false)
      expect(duplicateStopSettled).toBe(false)
      expect(stopAllSettled).toBe(false)
      expect(cancelRun).toHaveBeenCalledTimes(1)
    } finally {
      acknowledgeHelper()
    }
    await expect(Promise.all([stopped, duplicateStopped, stoppedAll])).resolves.toEqual([true, true, true])
    await expect(handlers.get('ai:stop')!({}, sendId)).resolves.toBe(false)
    expect(cancelRun).toHaveBeenCalledTimes(1)
    expect(lineage.browserTaskId).toBe('bt-77')
  })

  it('coalesces overlapping ai:stop all calls until every live Computer Use lineage ACK', async () => {
    const authorizeRun = vi.fn(() => ({ ok: true, bindingGeneration: 2, expiresAt: Date.now() + 60_000 }))
    const acknowledgements = new Map<string, () => void>()
    const cancelRun = vi.fn((_browserTaskId: string, runId: string) => new Promise<void>(resolve => {
      acknowledgements.set(runId, resolve)
    }))
    configureComputerHandler({ controller: { authorizeRun, cancelRun } as never })
    registerAiIpc({
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'test-key' : null,
      getProviderId: () => 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8', getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites: () => [], getAgentMode: () => 'auto' as const,
      recordJournal: () => {}, searchMemories: () => [], getContextSnapshot: () => null,
      getLatestChatUserMessage: (chatId: number) => ({
        id: chatId * 10,
        sessionId: chatId,
        role: 'user' as const,
        content: '/computer-use в выбранном окне прочитай заголовок',
      }),
      agentRuns: makeAgentRuns(),
    } as unknown as Parameters<typeof registerAiIpc>[0])
    const sender = { id: 102, isDestroyed: () => false, send: vi.fn() }
    const originalUserText = '/computer-use в выбранном окне прочитай заголовок'
    const send = (chatId: number) => {
      const ticket = mintComposerTicket(sender, chatId, originalUserText)
      return handlers.get('ai:send')!(
        { sender },
        [{ role: 'user', content: originalUserText }],
        dir,
        undefined,
        { agentMode: 'auto' },
        String(chatId),
        { ticket, userMessageId: chatId * 10 },
      ) as Promise<number>
    }

    const [firstSendId] = await Promise.all([send(78), send(79)])
    await vi.waitFor(() => expect(authorizeRun).toHaveBeenCalledTimes(2))
    let stopSettled = false
    const firstStopCall = handlers.get('ai:stop')!({}, 0) as Promise<boolean>
    const stopped = firstStopCall.then(value => {
      stopSettled = true
      return value
    })
    await vi.waitFor(() => expect(cancelRun).toHaveBeenCalledTimes(2))
    let duplicateStopSettled = false
    const duplicateStopCall = handlers.get('ai:stop')!({}, 0) as Promise<boolean>
    const duplicateStopped = duplicateStopCall.then(value => {
      duplicateStopSettled = true
      return value
    })
    let exactStopSettled = false
    const exactStopped = Promise.resolve(handlers.get('ai:stop')!({}, firstSendId)).then(value => {
      exactStopSettled = true
      return value
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    try {
      expect(duplicateStopCall).toBe(firstStopCall)
      expect(stopSettled).toBe(false)
      expect(duplicateStopSettled).toBe(false)
      expect(exactStopSettled).toBe(false)
      expect(cancelRun).toHaveBeenCalledTimes(2)
    } finally {
      for (const acknowledge of acknowledgements.values()) acknowledge()
    }
    await expect(Promise.all([stopped, duplicateStopped, exactStopped])).resolves.toEqual([true, true, true])
  })

  it.each([
    { name: 'CLI without Verstak tools', providerId: 'codex-cli' as const, project: 'known' as const, overrides: { agentMode: 'auto' as const } },
    { name: 'API without a project root', providerId: 'claude' as const, project: 'none' as const, overrides: { agentMode: 'auto' as const } },
  ])('fails fresh Computer Use closed before helper/provider on $name', async ({ providerId, project, overrides }) => {
    const command = '/computer-use в выбранном окне введи PRIVATE и нажми Сохранить'
    const authorizeRun = vi.fn(() => ({ ok: true, bindingGeneration: 2, expiresAt: Date.now() + 60_000 }))
    configureComputerHandler({ controller: { authorizeRun, cancelRun: vi.fn(async () => {}) } as never })
    const agentRuns = makeAgentRuns()
    registerAiIpc({
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'test-key' : null,
      getProviderId: () => providerId,
      getProviderModel: () => providerId === 'codex-cli' ? 'gpt-5' : 'claude-opus-4-8',
      getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites: () => [], getAgentMode: () => 'auto' as const,
      recordJournal: () => {}, searchMemories: () => [], getContextSnapshot: () => null,
      getLatestChatUserMessage: () => ({ id: 870, sessionId: 87, role: 'user', content: command }),
      agentRuns,
    } as unknown as Parameters<typeof registerAiIpc>[0])
    const sender = { id: 107, isDestroyed: () => false, send: vi.fn() }
    const ticket = mintComposerTicket(sender, 87, command)

    const sendId = await handlers.get('ai:send')!(
      { sender },
      [{ role: 'user', content: command }],
      project === 'known' ? dir : null,
      undefined,
      overrides,
      '87',
      { ticket, userMessageId: 870 },
    ) as number

    expect(sendId).toBe(0)
    expect(authorizeRun).not.toHaveBeenCalled()
    expect(providerControl.createProviderCalls).toBe(0)
    expect(providerControl.providerSendCalls).toBe(0)
    expect(agentRuns.create).not.toHaveBeenCalled()
    expect(sender.send).toHaveBeenCalledWith('ai:event', expect.objectContaining({
      id: 0,
      chatId: 87,
      event: expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('COMPUTER_USE_TRANSPORT_UNSUPPORTED'),
      }),
    }))
  })

  it.each([
    { name: 'reviewer', overrides: { useReviewerPrompt: true } },
    { name: 'resume', overrides: { resumeFromRunId: 'old-computer-run' } },
    { name: 'pipeline outcome', overrides: { outcome: { pipelineId: 7, phase: 'refine' as const } } },
  ])('taints and rejects a valid Computer ticket combined with $name before every runtime sink', async ({ overrides }) => {
    const command = '/computer-use в выбранном окне введи PRIVATE-OVERRIDE-BOUNDARY'
    const authorizeRun = vi.fn(() => ({ ok: true, bindingGeneration: 2, expiresAt: Date.now() + 60_000 }))
    configureComputerHandler({ controller: { authorizeRun, cancelRun: vi.fn(async () => {}) } as never })
    const browserTasks = makeTaintBrowserTasks()
    const agentRuns = makeAgentRuns()
    const resolveSubscriptionAccount = vi.fn(() => ({
      accountId: 2, secret: 'account-secret', configDir: null, baseUrl: null, pinned: false, label: 'Account B',
    }))
    registerAiIpc({
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'test-key' : null,
      getProviderId: () => 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8', getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites: () => [], getAgentMode: () => 'auto' as const,
      recordJournal: () => {}, searchMemories: () => [], getContextSnapshot: () => null,
      getLatestChatUserMessage: () => ({ id: 875, sessionId: 875, role: 'user', content: command }),
      resolveSubscriptionAccount,
      pipelineRuns: { get: () => ({ id: 7, projectPath: dir, planId: null }) },
      browserTasks,
      agentRuns,
    } as unknown as Parameters<typeof registerAiIpc>[0])
    const webContents = { id: 875, isDestroyed: () => false, send: vi.fn() }
    const ticket = mintComposerTicket(webContents, 875, command)

    await expect(handlers.get('ai:send')!(
      { sender: webContents }, [{ role: 'user', content: command }], dir, undefined,
      overrides, '875', { ticket, userMessageId: 875 },
    )).rejects.toThrow('COMPUTER_USE_FRESH_COMPOSER_REQUIRED')

    expect(browserTasks.get('bt-875')?.caps.computerContextTainted).toBe(true)
    expect(resolveSubscriptionAccount).not.toHaveBeenCalled()
    expect(authorizeRun).not.toHaveBeenCalled()
    expect(providerControl.createProviderCalls).toBe(0)
    expect(providerControl.providerSendCalls).toBe(0)
    expect(agentRuns.create).not.toHaveBeenCalled()
  })

  it('materializes valid Computer ticket taint before an invalid pipeline outcome preflight can throw', async () => {
    const command = '/computer-use в выбранном окне введи PRIVATE-BEFORE-OUTCOME-PREFLIGHT'
    const browserTasks = makeTaintBrowserTasks()
    const pipelineGet = vi.fn(() => {
      expect(browserTasks.get('bt-876')?.caps.computerContextTainted).toBe(true)
      return null
    })
    const authorizeRun = vi.fn(() => ({ ok: true, bindingGeneration: 2, expiresAt: Date.now() + 60_000 }))
    configureComputerHandler({ controller: { authorizeRun, cancelRun: vi.fn(async () => {}) } as never })
    const agentRuns = makeAgentRuns()
    const resolveSubscriptionAccount = vi.fn()
    registerAiIpc({
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'test-key' : null,
      getProviderId: () => 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8', getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites: () => [], getAgentMode: () => 'auto' as const,
      recordJournal: () => {}, searchMemories: () => [], getContextSnapshot: () => null,
      getLatestChatUserMessage: () => ({ id: 876, sessionId: 876, role: 'user', content: command }),
      resolveSubscriptionAccount,
      pipelineRuns: { get: pipelineGet },
      browserTasks,
      agentRuns,
    } as unknown as Parameters<typeof registerAiIpc>[0])
    const webContents = { id: 876, isDestroyed: () => false, send: vi.fn() }
    const ticket = mintComposerTicket(webContents, 876, command)

    await expect(handlers.get('ai:send')!(
      { sender: webContents }, [{ role: 'user', content: command }], dir, undefined,
      { outcome: { pipelineId: 404, phase: 'refine' } }, '876', { ticket, userMessageId: 876 },
    )).rejects.toThrow('COMPUTER_USE_FRESH_COMPOSER_REQUIRED')

    expect(browserTasks.get('bt-876')?.caps.computerContextTainted).toBe(true)
    expect(pipelineGet).not.toHaveBeenCalled()
    expect(resolveSubscriptionAccount).not.toHaveBeenCalled()
    expect(authorizeRun).not.toHaveBeenCalled()
    expect(providerControl.createProviderCalls).toBe(0)
    expect(agentRuns.create).not.toHaveBeenCalled()
  })

  it('taints and rejects a recognized Computer command with no supported R2 action before every runtime sink', async () => {
    const command = '/computer-use удали файл important.db'
    const authorizeRun = vi.fn(() => ({ ok: true, bindingGeneration: 2, expiresAt: Date.now() + 60_000 }))
    configureComputerHandler({ controller: { authorizeRun, cancelRun: vi.fn(async () => {}) } as never })
    const browserTasks = makeTaintBrowserTasks()
    const agentRuns = makeAgentRuns()
    const resolveSubscriptionAccount = vi.fn()
    const recentWrites = vi.fn(() => [])
    const searchMemories = vi.fn(() => [])
    const getContextSnapshot = vi.fn(() => null)
    const recordJournal = vi.fn()
    registerAiIpc({
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'test-key' : null,
      getProviderId: () => 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8', getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites, getAgentMode: () => 'auto' as const,
      recordJournal, searchMemories, getContextSnapshot,
      getLatestChatUserMessage: () => ({ id: 877, sessionId: 877, role: 'user', content: command }),
      resolveSubscriptionAccount,
      browserTasks,
      agentRuns,
    } as unknown as Parameters<typeof registerAiIpc>[0])
    const webContents = { id: 877, isDestroyed: () => false, send: vi.fn() }
    const ticket = mintComposerTicket(webContents, 877, command)

    await expect(handlers.get('ai:send')!(
      { sender: webContents }, [{ role: 'user', content: command }], dir, undefined,
      { agentMode: 'auto' }, '877', { ticket, userMessageId: 877 },
    )).rejects.toThrow('COMPUTER_USE_ACTION_UNSUPPORTED')

    expect(browserTasks.get('bt-877')?.caps.computerContextTainted).toBe(true)
    expect(resolveSubscriptionAccount).not.toHaveBeenCalled()
    expect(authorizeRun).not.toHaveBeenCalled()
    expect(recentWrites).not.toHaveBeenCalled()
    expect(searchMemories).not.toHaveBeenCalled()
    expect(getContextSnapshot).not.toHaveBeenCalled()
    expect(recordJournal).not.toHaveBeenCalled()
    expect(providerControl.createProviderCalls).toBe(0)
    expect(providerControl.providerSendCalls).toBe(0)
    expect(providerControl.lastMessages).toEqual([])
    expect(agentRuns.create).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith('ai:event', expect.objectContaining({
      event: expect.objectContaining({ type: 'pending-command' }),
    }))
  })

  it('locks fresh Computer Use to the preflight account before helper/provider creation', async () => {
    const command = '/computer-use в выбранном окне введи PRIVATE'
    const authorizeRun = vi.fn(() => ({ ok: true, bindingGeneration: 2, expiresAt: Date.now() + 60_000 }))
    configureComputerHandler({ controller: { authorizeRun, cancelRun: vi.fn(async () => {}) } as never })
    const resolveSubscriptionAccount = vi.fn((
      _providerId: string,
      _chatId?: number,
      opts?: { accountId?: number | null; allowAutoRotation?: boolean },
    ) => opts?.allowAutoRotation === false
      ? { blocked: true as const, reason: 'cooling' as const, resetAt: Date.now() + 60_000, label: 'Остывший A' }
      : { accountId: 2, secret: 'rotated-b', configDir: null, baseUrl: null, pinned: false, label: 'Готовый B' })
    const agentRuns = makeAgentRuns()
    registerAiIpc({
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'test-key' : null,
      getProviderId: () => 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8', getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites: () => [], getAgentMode: () => 'auto' as const,
      recordJournal: () => {}, searchMemories: () => [], getContextSnapshot: () => null,
      getLatestChatUserMessage: () => ({ id: 940, sessionId: 94, role: 'user', content: command }),
      resolveSubscriptionAccount,
      agentRuns,
    } as unknown as Parameters<typeof registerAiIpc>[0])
    const sender = { id: 109, isDestroyed: () => false, send: vi.fn() }
    const ticket = mintComposerTicket(sender, 94, command)

    const sendId = await handlers.get('ai:send')!(
      { sender },
      [{ role: 'user', content: command }],
      dir,
      undefined,
      { agentMode: 'auto' },
      '94',
      { ticket, userMessageId: 940 },
    ) as number

    expect(sendId).toBe(0)
    expect(resolveSubscriptionAccount).toHaveBeenCalledWith('claude', 94, { allowAutoRotation: false })
    expect(authorizeRun).not.toHaveBeenCalled()
    expect(providerControl.createProviderCalls).toBe(0)
    expect(providerControl.providerSendCalls).toBe(0)
    expect(agentRuns.create).not.toHaveBeenCalled()
    expect(sender.send).toHaveBeenCalledWith('ai:event', expect.objectContaining({
      id: 0,
      chatId: 94,
      event: expect.objectContaining({ type: 'error', message: expect.stringContaining('Остывший A') }),
    }))
  })

  it('stops a fresh Computer Use run when the selected-window claim cannot be authorized', async () => {
    const command = '/computer-use в выбранном окне нажми Сохранить'
    const authorizeRun = vi.fn(() => ({ ok: false as const, error: 'no-binding' }))
    configureComputerHandler({ controller: { authorizeRun, cancelRun: vi.fn(async () => {}) } as never })
    const agentRuns = makeAgentRuns()
    registerAiIpc({
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'test-key' : null,
      getProviderId: () => 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8', getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites: () => [], getAgentMode: () => 'auto' as const,
      recordJournal: () => {}, searchMemories: () => [], getContextSnapshot: () => null,
      getLatestChatUserMessage: () => ({ id: 950, sessionId: 95, role: 'user', content: command }),
      agentRuns,
    } as unknown as Parameters<typeof registerAiIpc>[0])
    const sender = { id: 110, isDestroyed: () => false, send: vi.fn() }
    const ticket = mintComposerTicket(sender, 95, command)

    const sendId = await handlers.get('ai:send')!(
      { sender }, [{ role: 'user', content: command }], dir, undefined,
      { agentMode: 'auto' }, '95', { ticket, userMessageId: 950 },
    ) as number

    expect(sendId).toBe(0)
    expect(authorizeRun).toHaveBeenCalledOnce()
    expect(providerControl.createProviderCalls).toBe(0)
    expect(providerControl.providerSendCalls).toBe(0)
    expect(agentRuns.create).not.toHaveBeenCalled()
    expect(sender.send).toHaveBeenCalledWith('ai:event', expect.objectContaining({
      id: 0,
      chatId: 95,
      event: expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('COMPUTER_USE_AUTHORIZATION_FAILED'),
      }),
    }))
  })

  it('materializes intent taint before the first desktop tool and blocks an unticketed retry', async () => {
    const command = '/computer-use в выбранном окне введи PRIVATE-INTENT-TAINT'
    const authorizeRun = vi.fn(() => ({ ok: true as const, bindingGeneration: 2, expiresAt: Date.now() + 60_000 }))
    configureComputerHandler({ controller: { authorizeRun, cancelRun: vi.fn(async () => {}) } as never })
    const browserTasks = makeTaintBrowserTasks()
    const agentRuns = makeAgentRuns()
    providerControl.failBeforeTool = true
    registerAiIpc({
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'test-key' : null,
      getProviderId: () => 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8', getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites: () => [], getAgentMode: () => 'auto' as const,
      recordJournal: () => {}, searchMemories: () => [], getContextSnapshot: () => null,
      getLatestChatUserMessage: () => ({ id: 960, sessionId: 96, role: 'user', content: command }),
      browserTasks,
      agentRuns,
    } as unknown as Parameters<typeof registerAiIpc>[0])
    const sender = { id: 111, isDestroyed: () => false, send: vi.fn() }
    const ticket = mintComposerTicket(sender, 96, command)

    await handlers.get('ai:send')!(
      { sender }, [{ role: 'user', content: command }], dir, undefined,
      { agentMode: 'auto' }, '96', { ticket, userMessageId: 960 },
    )
    await vi.waitFor(() => expect(providerControl.providerSendCalls).toBe(1))

    expect(browserTasks.get('bt-96')?.caps.computerContextTainted).toBe(true)
    await expect(handlers.get('ai:send')!(
      { sender }, [{ role: 'user', content: command }], dir, undefined,
      { resumeFromRunId: 'synthetic-retry' }, '96', undefined,
    )).rejects.toThrow('COMPUTER_USE_FRESH_COMPOSER_REQUIRED')
    expect(providerControl.createProviderCalls).toBe(1)
    expect(providerControl.providerSendCalls).toBe(1)
  })

  it('не принимает raw/поддельный/replayed provenance и потребляет valid ticket ровно один раз', async () => {
    const command = '/computer-use: нажми кнопку Сохранить'
    const authorizeRun = vi.fn(() => ({ ok: true, bindingGeneration: 2, expiresAt: Date.now() + 60_000 }))
    configureComputerHandler({ controller: { authorizeRun, cancelRun: vi.fn(async () => {}) } as never })
    const agentRuns = makeAgentRuns()
    const browserTasks = makeTaintBrowserTasks()
    const latest = { id: 880, sessionId: 88, role: 'user' as const, content: command }
    registerAiIpc({
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'test-key' : null,
      getProviderId: () => 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8', getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites: () => [], getAgentMode: () => 'auto' as const,
      recordJournal: () => {}, searchMemories: () => [], getContextSnapshot: () => null,
      getLatestChatUserMessage: () => latest,
      browserTasks,
      agentRuns,
    } as unknown as Parameters<typeof registerAiIpc>[0])
    const sender = { id: 103, isDestroyed: () => false, send: vi.fn() }

    await expect(handlers.get('ai:send')!({ sender }, [{ role: 'user', content: command }], dir, undefined, { agentMode: 'auto' }, '88', command))
      .rejects.toThrow('COMPUTER_USE_FRESH_COMPOSER_REQUIRED')
    await expect(handlers.get('ai:send')!({ sender }, [{ role: 'user', content: command }], dir, undefined, { agentMode: 'auto' }, '88', { ticket: 'forged', userMessageId: 880 }))
      .rejects.toThrow('COMPUTER_USE_FRESH_COMPOSER_REQUIRED')
    const syntheticTicket = mintComposerTicket(sender, 88, command)
    await expect(handlers.get('ai:send')!({ sender }, [{ role: 'user', content: command }], dir, undefined, { noTools: true }, '88', { ticket: syntheticTicket, userMessageId: 880 }))
      .rejects.toThrow('COMPUTER_USE_FRESH_COMPOSER_REQUIRED')
    expect(authorizeRun).not.toHaveBeenCalled()

    const ticket = mintComposerTicket(sender, 88, command)
    const grant = { ticket, userMessageId: 880 }
    await handlers.get('ai:send')!({ sender }, [{ role: 'user', content: command }], dir, undefined, { agentMode: 'auto' }, '88', grant)
    await vi.waitFor(() => expect(authorizeRun).toHaveBeenCalledTimes(1))
    await expect(handlers.get('ai:send')!({ sender }, [{ role: 'user', content: command }], dir, undefined, { agentMode: 'auto' }, '88', grant))
      .rejects.toThrow('COMPUTER_USE_FRESH_COMPOSER_REQUIRED')
    expect(authorizeRun).toHaveBeenCalledTimes(1)
  })

  it('не связывает forged опасный original text с отдельным benign persisted payload', async () => {
    const benign = 'Обычное сообщение без Computer Use'
    const dangerous = '/computer-use: нажми кнопку Сохранить'
    const authorizeRun = vi.fn(() => ({ ok: true, bindingGeneration: 2, expiresAt: Date.now() + 60_000 }))
    configureComputerHandler({ controller: { authorizeRun, cancelRun: vi.fn(async () => {}) } as never })
    const agentRuns = makeAgentRuns()
    registerAiIpc({
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'test-key' : null,
      getProviderId: () => 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8', getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites: () => [], getAgentMode: () => 'auto' as const,
      recordJournal: () => {}, searchMemories: () => [], getContextSnapshot: () => null,
      getLatestChatUserMessage: () => ({ id: 890, sessionId: 89, role: 'user', content: benign }),
      agentRuns,
    } as unknown as Parameters<typeof registerAiIpc>[0])
    const sender = { id: 108, isDestroyed: () => false, send: vi.fn() }
    const event = { sender, returnValue: null as unknown }
    // Legacy exploit shape: separate dangerous authority text + benign hash text.
    syncHandlers.get('ai:mint-computer-use-composer-ticket')!(event, '89', dangerous, benign)
    expect(event.returnValue).toEqual(expect.any(String))

    await handlers.get('ai:send')!(
      { sender },
      [{ role: 'user', content: benign }],
      dir,
      undefined,
      { agentMode: 'auto' },
      '89',
      { ticket: event.returnValue, userMessageId: 890 },
    )
    expect(authorizeRun).not.toHaveBeenCalled()
  })

  it('сверяет ticket с exact sender/chat/latest persisted user id/session/role/content', async () => {
    const command = '/computer-use: нажми кнопку Сохранить'
    const authorizeRun = vi.fn(() => ({ ok: true, bindingGeneration: 2, expiresAt: Date.now() + 60_000 }))
    configureComputerHandler({ controller: { authorizeRun, cancelRun: vi.fn(async () => {}) } as never })
    const agentRuns = makeAgentRuns()
    const browserTasks = makeTaintBrowserTasks()
    let latest = { id: 900, sessionId: 90, role: 'user', content: command }
    registerAiIpc({
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'test-key' : null,
      getProviderId: () => 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8', getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites: () => [], getAgentMode: () => 'auto' as const,
      recordJournal: () => {}, searchMemories: () => [], getContextSnapshot: () => null,
      getLatestChatUserMessage: () => latest,
      browserTasks,
      agentRuns,
    } as unknown as Parameters<typeof registerAiIpc>[0])
    const sender = { id: 104, isDestroyed: () => false, send: vi.fn() }
    const invoke = (eventSender: typeof sender, chatId: string, ticket: string, userMessageId: number) => handlers.get('ai:send')!(
      { sender: eventSender },
      [{ role: 'user', content: command }],
      dir,
      undefined,
      { agentMode: 'auto' },
      chatId,
      { ticket, userMessageId },
    ) as Promise<number>

    await expect(invoke({ ...sender, id: 999 }, '90', mintComposerTicket(sender, 90, command), 900))
      .rejects.toThrow('COMPUTER_USE_FRESH_COMPOSER_REQUIRED')
    await expect(invoke(sender, '91', mintComposerTicket(sender, 90, command), 900))
      .rejects.toThrow('COMPUTER_USE_FRESH_COMPOSER_REQUIRED')
    await expect(invoke(sender, '90', mintComposerTicket(sender, 90, command), 901))
      .rejects.toThrow('COMPUTER_USE_FRESH_COMPOSER_REQUIRED')
    latest = { ...latest, content: `${command} tampered` }
    await expect(invoke(sender, '90', mintComposerTicket(sender, 90, command), 900))
      .rejects.toThrow('COMPUTER_USE_FRESH_COMPOSER_REQUIRED')

    expect(authorizeRun).not.toHaveBeenCalled()
  })

  it('отклоняет входящий envelope, если valid ticket и persisted user привязаны к другому тексту', async () => {
    const canonical = '/computer-use: нажми кнопку Сохранить'
    const forgedEnvelope = '/computer-use: нажми кнопку Удалить'
    const authorizeRun = vi.fn(() => ({ ok: true, bindingGeneration: 2, expiresAt: Date.now() + 60_000 }))
    configureComputerHandler({ controller: { authorizeRun, cancelRun: vi.fn(async () => {}) } as never })
    const browserTasks = makeTaintBrowserTasks()
    registerAiIpc({
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'test-key' : null,
      getProviderId: () => 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8', getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites: () => [], getAgentMode: () => 'auto' as const,
      recordJournal: () => {}, searchMemories: () => [], getContextSnapshot: () => null,
      getLatestChatUserMessage: () => ({ id: 940, sessionId: 94, role: 'user', content: canonical }),
      browserTasks,
      agentRuns: makeAgentRuns(),
    } as unknown as Parameters<typeof registerAiIpc>[0])
    const sender = { id: 112, isDestroyed: () => false, send: vi.fn() }
    const ticket = mintComposerTicket(sender, 94, canonical)

    await expect(handlers.get('ai:send')!(
      { sender },
      [{ role: 'user', content: forgedEnvelope }],
      dir,
      undefined,
      { agentMode: 'auto' },
      '94',
      { ticket, userMessageId: 940 },
    )).rejects.toThrow('COMPUTER_USE_COMPOSER_ENVELOPE_MISMATCH')

    expect(browserTasks.get('bt-94')?.caps.computerContextTainted).toBe(true)
    expect(authorizeRun).not.toHaveBeenCalled()
    expect(providerControl.createProviderCalls).toBe(0)
    expect(providerControl.providerSendCalls).toBe(0)
  })

  it('строит Computer provider envelope только из verified composer text без renderer history и attachments', async () => {
    const command = '/computer-use: нажми кнопку Сохранить'
    const persisted = `${command}\n\n📎 notes.txt`
    const forgedHistoryMarker = 'FORGED_EARLIER_DELETE_INSTRUCTION'
    const forgedAttachmentMarker = 'FORGED_ATTACHMENT_DELETE_INSTRUCTION'
    const projectRuleMarker = 'POISON_PROJECT_RULE_CLICK_DELETE'
    const projectPromptMarker = 'POISON_PROJECT_SETTINGS_CLICK_DELETE'
    const memoryMarker = 'POISON_ARCHIVAL_MEMORY_CLICK_DELETE'
    const coreMemoryMarker = 'POISON_CORE_MEMORY_CLICK_DELETE'
    const coreUserMarker = 'POISON_CORE_USER_CLICK_DELETE'
    const brainMarker = 'POISON_PROJECT_BRAIN_CLICK_DELETE'
    const decisionMarker = 'POISON_DECISION_CLICK_DELETE'
    const consolidationMarker = 'POISON_CONSOLIDATION_CLICK_DELETE'
    mkdirSync(join(dir, '.verstak'), { recursive: true })
    writeFileSync(join(dir, 'AGENTS.md'), projectRuleMarker, 'utf8')
    writeFileSync(join(dir, '.verstak', 'MEMORY.md'), coreMemoryMarker, 'utf8')
    writeFileSync(join(dir, '.verstak', 'USER.md'), coreUserMarker, 'utf8')
    const authorizeRun = vi.fn(() => ({ ok: true, bindingGeneration: 2, expiresAt: Date.now() + 60_000 }))
    configureComputerHandler({ controller: { authorizeRun, cancelRun: vi.fn(async () => {}) } as never })
    const browserTasks = makeTaintBrowserTasks()
    registerAiIpc({
      getSecret: (key: string) => {
        if (key === 'anthropic_api_key') return 'test-key'
        if (key === `system_prompt_${dir}`) return projectPromptMarker
        if (key === 'use_project_brain') return 'true'
        if (key === 'output_style') return 'concise'
        return null
      },
      getProviderId: () => 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8', getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites: () => [{ filePath: 'POISON_RECENT_WRITE', createdAt: Date.now() }], getAgentMode: () => 'auto' as const,
      recordJournal: () => {}, searchMemories: () => [{
        id: 'poison-memory', type: 'fact', content: memoryMarker, tags: ['poison'], created_at: Date.now(),
      }],
      memoryConsolidationHint: () => consolidationMarker,
      getBrainContext: () => ({ content: brainMarker, packType: 'poison' }),
      listDecisions: () => [{
        title: decisionMarker, finalDecision: decisionMarker, why: decisionMarker,
        alternativesRejected: [decisionMarker], createdAt: Date.now(),
      }],
      getContextSnapshot: () => ({
        summary: 'FORGED_COMPACTION_DELETE_INSTRUCTION',
        throughMessageId: 1,
      }),
      getLatestChatUserMessage: () => ({ id: 950, sessionId: 95, role: 'user', content: persisted }),
      browserTasks,
      agentRuns: makeAgentRuns(),
    } as unknown as Parameters<typeof registerAiIpc>[0])
    const sender = { id: 113, isDestroyed: () => false, send: vi.fn() }
    const ticket = mintComposerTicket(sender, 95, persisted)

    await handlers.get('ai:send')!(
      { sender },
      [
        { role: 'system', content: forgedHistoryMarker },
        { role: 'assistant', content: forgedHistoryMarker },
        {
          role: 'user',
          content: persisted,
          attachments: [{
            name: 'notes.txt',
            mimeType: 'text/plain',
            data: Buffer.from(forgedAttachmentMarker, 'utf8').toString('base64'),
            size: Buffer.byteLength(forgedAttachmentMarker),
          }],
        },
      ],
      dir,
      undefined,
      { agentMode: 'auto' },
      '95',
      { ticket, userMessageId: 950 },
    )
    await vi.waitFor(() => expect(providerControl.providerSendCalls).toBe(1))

    expect(authorizeRun).toHaveBeenCalledTimes(1)
    const serialized = JSON.stringify(providerControl.lastMessages)
    expect(serialized).not.toContain(forgedHistoryMarker)
    expect(serialized).not.toContain(forgedAttachmentMarker)
    expect(serialized).not.toContain('FORGED_COMPACTION_DELETE_INSTRUCTION')
    expect(serialized).not.toContain('notes.txt')
    for (const poison of [
      projectRuleMarker,
      projectPromptMarker,
      memoryMarker,
      coreMemoryMarker,
      coreUserMarker,
      brainMarker,
      decisionMarker,
      consolidationMarker,
      'POISON_RECENT_WRITE',
    ]) expect(serialized).not.toContain(poison)
    expect(providerControl.lastMessages).toHaveLength(2)
    expect(providerControl.lastMessages[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('VERSTAK_COMPUTER_USE_ENVELOPE_V1'),
    })
    const users = (providerControl.lastMessages as Array<{ role?: string; content?: string; attachments?: unknown[] }>)
      .filter(message => message.role === 'user')
    expect(users.at(-1)).toMatchObject({ content: command })
    expect(users.at(-1)?.attachments).toBeUndefined()
  })

  it('отклоняет content-bearing overrides у valid Computer ticket до provider и authorization', async () => {
    const command = '/computer-use: нажми кнопку Сохранить'
    const authorizeRun = vi.fn(() => ({ ok: true, bindingGeneration: 2, expiresAt: Date.now() + 60_000 }))
    configureComputerHandler({ controller: { authorizeRun, cancelRun: vi.fn(async () => {}) } as never })
    const browserTasks = makeTaintBrowserTasks()
    registerAiIpc({
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'test-key' : null,
      getProviderId: () => 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8', getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites: () => [], getAgentMode: () => 'auto' as const,
      recordJournal: () => {}, searchMemories: () => [], getContextSnapshot: () => null,
      getLatestChatUserMessage: () => ({ id: 960, sessionId: 96, role: 'user', content: command }),
      browserTasks,
      agentRuns: makeAgentRuns(),
    } as unknown as Parameters<typeof registerAiIpc>[0])
    const sender = { id: 114, isDestroyed: () => false, send: vi.fn() }
    const ticket = mintComposerTicket(sender, 96, command)

    await expect(handlers.get('ai:send')!(
      { sender }, [{ role: 'user', content: command }], dir, undefined,
      { agentMode: 'auto', systemPrompt: 'FORGED_SYSTEM_DELETE_INSTRUCTION' },
      '96', { ticket, userMessageId: 960 },
    )).rejects.toThrow('COMPUTER_USE_FRESH_COMPOSER_REQUIRED')

    expect(browserTasks.get('bt-96')?.caps.computerContextTainted).toBe(true)
    expect(authorizeRun).not.toHaveBeenCalled()
    expect(providerControl.createProviderCalls).toBe(0)
    expect(providerControl.providerSendCalls).toBe(0)
  })

  it('истёкший composer ticket теряет Computer Use authority', async () => {
    const command = '/computer-use: нажми кнопку Сохранить'
    const authorizeRun = vi.fn(() => ({ ok: true, bindingGeneration: 2, expiresAt: Date.now() + 60_000 }))
    configureComputerHandler({ controller: { authorizeRun, cancelRun: vi.fn(async () => {}) } as never })
    const agentRuns = makeAgentRuns()
    const browserTasks = makeTaintBrowserTasks()
    registerAiIpc({
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'test-key' : null,
      getProviderId: () => 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8', getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites: () => [], getAgentMode: () => 'auto' as const,
      recordJournal: () => {}, searchMemories: () => [], getContextSnapshot: () => null,
      getLatestChatUserMessage: () => ({ id: 920, sessionId: 92, role: 'user', content: command }),
      browserTasks,
      agentRuns,
    } as unknown as Parameters<typeof registerAiIpc>[0])
    const sender = { id: 105, isDestroyed: () => false, send: vi.fn() }
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const ticket = mintComposerTicket(sender, 92, command)
    now.mockReturnValue(62_000)

    await expect(handlers.get('ai:send')!({ sender }, [{ role: 'user', content: command }], dir, undefined, { agentMode: 'auto' }, '92', { ticket, userMessageId: 920 }))
      .rejects.toThrow('COMPUTER_USE_FRESH_COMPOSER_REQUIRED')
    expect(authorizeRun).not.toHaveBeenCalled()
    now.mockRestore()
  })

  it('bounded composer ticket store вытесняет самый старый ticket', async () => {
    const command = '/computer-use: прочитай выбранное окно'
    const authorizeRun = vi.fn(() => ({ ok: true, bindingGeneration: 2, expiresAt: Date.now() + 60_000 }))
    configureComputerHandler({ controller: { authorizeRun, cancelRun: vi.fn(async () => {}) } as never })
    const agentRuns = makeAgentRuns()
    const browserTasks = makeTaintBrowserTasks()
    registerAiIpc({
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'test-key' : null,
      getProviderId: () => 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8', getKnownRoots: () => [dir],
      recordWrite: () => {}, recentWrites: () => [], getAgentMode: () => 'auto' as const,
      recordJournal: () => {}, searchMemories: () => [], getContextSnapshot: () => null,
      getLatestChatUserMessage: () => ({ id: 930, sessionId: 93, role: 'user', content: command }),
      browserTasks,
      agentRuns,
    } as unknown as Parameters<typeof registerAiIpc>[0])
    const sender = { id: 106, isDestroyed: () => false, send: vi.fn() }
    const tickets = Array.from({ length: 129 }, () => mintComposerTicket(sender, 93, command))

    await expect(handlers.get('ai:send')!({ sender }, [{ role: 'user', content: command }], dir, undefined, { agentMode: 'auto' }, '93', { ticket: tickets[0], userMessageId: 930 }))
      .rejects.toThrow('COMPUTER_USE_FRESH_COMPOSER_REQUIRED')
    expect(authorizeRun).not.toHaveBeenCalled()
    await handlers.get('ai:send')!({ sender }, [{ role: 'user', content: command }], dir, undefined, { agentMode: 'auto' }, '93', { ticket: tickets.at(-1), userMessageId: 930 })
    await vi.waitFor(() => expect(authorizeRun).toHaveBeenCalledTimes(1))
  })

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

    await vi.waitFor(async () => {
      expect(await handlers.get('ai:stop')!({}, first)).toBe(false)
    })
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
