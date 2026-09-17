import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ChatEvent, ChatMessage } from '../../electron/ai/types'
import { decideProviderBrowserContext } from '../../electron/ai/browser/data-policy'
import type { BrowserAdapter, ClientDataPolicy } from '../../electron/ai/browser/types'
import { conversationSearchHandler } from '../../electron/ipc/tool-handlers/diagnostics'
import type { ToolContext } from '../../electron/ipc/tool-handlers'
import { configureComputerHandler } from '../../electron/ipc/tool-handlers/computer'
import { COMPUTER_CONTEXT_OMITTED } from '../../electron/ai/tool-telemetry'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const syncHandlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
    on: (channel: string, handler: (...args: unknown[]) => unknown) => syncHandlers.set(channel, handler),
  },
  app: { getPath: () => tmpdir() },
  BrowserWindow: { fromWebContents: () => null },
}))

const runContexts: Array<Record<string, unknown>> = []
vi.mock('../../electron/ai/runner-api', () => ({
  runApiConversation: vi.fn(async (ctx: Record<string, unknown>) => { runContexts.push(ctx) }),
}))
const plainRunContexts: Array<Record<string, unknown>> = []
vi.mock('../../electron/ai/runner-plain', () => ({
  runPlainConversation: vi.fn(async (ctx: Record<string, unknown>) => { plainRunContexts.push(ctx) }),
}))

vi.mock('../../electron/ai/registry', async importOriginal => {
  const actual = await importOriginal<typeof import('../../electron/ai/registry')>()
  return {
    ...actual,
    createProvider: () => ({
      id: 'claude', name: 'claude', models: ['m'],
      async *send(): AsyncGenerator<ChatEvent> { yield { type: 'done' } },
    }),
  }
})

const { registerAiIpc: registerAiIpcBase } = await import('../../electron/ipc/ai')
const registerAiIpc = (deps: Parameters<typeof registerAiIpcBase>[0]) => registerAiIpcBase({
  ...deps,
  consumeComputerUseComposerActivation: () => true,
})
const projectPath = mkdtempSync(join(tmpdir(), 'vst-browser-wiring-'))
const messages: ChatMessage[] = [{ role: 'user', content: 'Прочитай открытую вкладку' }]

function sender(id = 201): Electron.WebContents {
  return {
    id,
    isDestroyed: () => false,
    send: () => {},
  } as unknown as Electron.WebContents
}

function makeDeps(options: {
  adapterId?: BrowserAdapter['id']
  existingPolicy?: ClientDataPolicy
  providerId?: 'claude' | 'claude-cli'
  actionsByTask?: Record<string, string[]>
  parentByChat?: Record<number, number | null>
  snapshot?: { summary: string; throughMessageId: number } | null
  conversationResults?: Array<{ session_id: number; role: string; content: string; created_at: number }>
  latestUser?: { id: number; sessionId: number; role: 'user'; content: string }
} = {}) {
  const ensureTask = vi.fn()
  const attachRun = vi.fn()
  const syncBrowserContext = vi.fn()
  const setDataPolicy = vi.fn()
  const getContextSnapshot = vi.fn(() => options.snapshot ?? null)
  const existing = options.existingPolicy
    ? { allowedDomains: [], caps: {}, dataPolicy: options.existingPolicy }
    : null
  const taskRows = new Map<string, { allowedDomains: string[]; caps: Record<string, unknown>; dataPolicy: ClientDataPolicy | Record<string, unknown> }>()
  return {
    deps: {
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'key' : null,
      getProviderId: () => options.providerId ?? 'claude' as const,
      getProviderModel: () => 'claude-opus-4-8',
      getKnownRoots: () => [projectPath],
      getAgentMode: () => 'ask' as const,
      recordWrite: () => {},
      recentWrites: () => [],
      recordPlan: () => ({ id: 1 }),
      recordJournal: () => {},
      readJournal: () => [],
      saveMemory: () => ({ id: 'm' }),
      saveDecision: (value: unknown) => value,
      searchMemories: () => [],
      searchConversations: () => options.conversationResults ?? [],
      browserController: { ensureTask, attachRun },
      browserTasks: {
        get: (browserTaskId: string) => taskRows.get(browserTaskId) ?? existing,
        create: (input: { browserTaskId: string; allowedDomains?: string[]; caps?: Record<string, unknown>; dataPolicy?: Record<string, unknown> }) => {
          taskRows.set(input.browserTaskId, {
            allowedDomains: input.allowedDomains ?? [],
            caps: input.caps ?? {},
            dataPolicy: input.dataPolicy ?? {},
          })
        },
        setCaps: (browserTaskId: string, caps: Record<string, unknown>) => {
          const previous = taskRows.get(browserTaskId) ?? existing ?? { allowedDomains: [], caps: {}, dataPolicy: {} }
          taskRows.set(browserTaskId, { ...previous, caps })
        },
        setDataPolicy,
        listActions: (browserTaskId: string) => (options.actionsByTask?.[browserTaskId] ?? []).map((actionType, index) => ({
          actionId: `a-${index}`,
          actionType,
          status: 'failed',
        })),
      },
      getChatParentChatId: (chatId: number) => options.parentByChat?.[chatId] ?? null,
      getLatestChatUserMessage: (chatId: number) => options.latestUser?.sessionId === chatId
        ? options.latestUser
        : null,
      getContextSnapshot,
      resolveBrowserAdapterId: () => options.adapterId ?? 'electron-webview',
      syncBrowserContext,
    } as unknown as Parameters<typeof registerAiIpc>[0],
    ensureTask,
    attachRun,
    setDataPolicy,
    syncBrowserContext,
    getContextSnapshot,
  }
}

beforeEach(() => {
  handlers.clear()
  syncHandlers.clear()
  runContexts.length = 0
  plainRunContexts.length = 0
  configureComputerHandler({
    controller: {
      authorizeRun: () => ({ ok: true, bindingGeneration: 1, expiresAt: Date.now() + 60_000 }),
      cancelRun: async () => {},
    } as never,
  })
})

function mintComposerTicket(
  webContents: Electron.WebContents,
  chatId: number,
  canonicalUserContent: string,
): string {
  const assignments: unknown[] = []
  const event = { sender: webContents } as { sender: Electron.WebContents; returnValue: unknown }
  Object.defineProperty(event, 'returnValue', {
    get: () => assignments.at(-1),
    set: value => { assignments.push(value) },
  })
  syncHandlers.get('ai:mint-computer-use-composer-ticket')!(
    event,
      String(chatId),
      canonicalUserContent,
      { kind: 'keyboard', key: 'Enter' },
    )
  expect(assignments).toHaveLength(1)
  expect(event.returnValue).toEqual(expect.any(String))
  return event.returnValue as string
}

describe('ai:send browser context wiring', () => {
  it('Computer Use сохраняет content-free run/debug telemetry, но live model получает исходную команду', async () => {
    const privateCommand = '/computer-use: введи PRIVATE-DESKTOP-TEXT в выбранном окне'
    const { deps } = makeDeps({
      latestUser: { id: 501, sessionId: 70, role: 'user', content: privateCommand },
    })
    const saveRunInput = vi.fn()
    const createRun = vi.fn(() => 1)
    const appendEvent = vi.fn()
    Object.assign(deps, {
      saveRunInput,
      agentRuns: { create: createRun, appendEvent },
    })
    registerAiIpc(deps)
    const emitted: unknown[] = []
    const webContents = {
      id: 270,
      isDestroyed: () => false,
      send: (_channel: string, payload: unknown) => emitted.push(payload),
    } as unknown as Electron.WebContents
    const ticket = mintComposerTicket(webContents, 70, privateCommand)

    await handlers.get('ai:send')!(
      { sender: webContents },
      [{ role: 'user', content: privateCommand, dbId: 501 }],
      projectPath,
      undefined,
      undefined,
      '70',
      { ticket, userMessageId: 501 },
    )

    expect(runContexts.at(-1)?.computerUseAllowedActions).toContain('type')
    expect(JSON.stringify(runContexts.at(-1)?.initialMessages)).toContain(privateCommand)
    expect(saveRunInput).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: COMPUTER_CONTEXT_OMITTED,
      userMessage: COMPUTER_CONTEXT_OMITTED,
    }))
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ title: COMPUTER_CONTEXT_OMITTED }))
    expect(appendEvent).toHaveBeenCalledWith(expect.any(String), 'user_msg', { detail: COMPUTER_CONTEXT_OMITTED })
    expect(JSON.stringify({ save: saveRunInput.mock.calls, create: createRun.mock.calls, events: appendEvent.mock.calls, emitted })).not.toContain(privateCommand)
  })

  it('обычный чат сохраняет прежние title и Debug Packet user_message', async () => {
    const ordinary = 'Обычный запрос без Computer Use'
    const { deps } = makeDeps()
    const saveRunInput = vi.fn()
    const createRun = vi.fn(() => 1)
    const appendEvent = vi.fn()
    Object.assign(deps, {
      saveRunInput,
      agentRuns: { create: createRun, appendEvent },
    })
    const gateway = registerAiIpc(deps)

    await gateway.invokeAiSend(sender(), [{ role: 'user', content: ordinary }], projectPath, undefined, undefined, '71')

    expect(saveRunInput).toHaveBeenCalledWith(expect.objectContaining({ userMessage: ordinary }))
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ title: ordinary }))
    expect(appendEvent).toHaveBeenCalledWith(expect.any(String), 'user_msg', { detail: ordinary })
  })

  it('обычный чат синхронизирует attached singleton с bt-chat/run, но не стартует browser-only', async () => {
    const { deps, ensureTask, syncBrowserContext } = makeDeps()
    const gateway = registerAiIpc(deps)

    await gateway.invokeAiSend(sender(), messages, projectPath, undefined, undefined, '17')

    expect(ensureTask).toHaveBeenCalledWith(expect.objectContaining({ browserTaskId: 'bt-17', chatId: 17 }))
    const runId = ensureTask.mock.calls[0][0].runId as string
    expect(syncBrowserContext).toHaveBeenCalledWith({ browserTaskId: 'bt-17', runId })
    expect(runContexts.at(-1)?.browserRunActive).toBe(false)
  })

  it('задача из toolbar side panel помечается explicit browser run', async () => {
    const { deps } = makeDeps()
    const gateway = registerAiIpc(deps)

    await gateway.sendFromBrowser(sender(), messages, projectPath, '18')

    expect(runContexts.at(-1)?.browserRunActive).toBe(true)
    const resolver = runContexts.at(-1)?.browserTaskIdResolver as ((input: unknown) => string) | undefined
    expect(resolver?.({})).toBe('bt-18')
  })

  it('toolbar side panel Computer Use attempt is tainted and rejected before provider/run without a desktop ticket', async () => {
    const command = '/computer-use: введи SIDE_PANEL_PRIVATE в выбранном окне'
    const { deps } = makeDeps({
      latestUser: { id: 180, sessionId: 18, role: 'user', content: command },
    })
    const gateway = registerAiIpc(deps)

    await expect(gateway.sendFromBrowser(
      sender(),
      [{ role: 'user', content: command, dbId: 180 }],
      projectPath,
      '18',
    )).rejects.toThrow('COMPUTER_USE_FRESH_COMPOSER_REQUIRED')

    expect(runContexts).toEqual([])
    expect(deps.browserTasks?.get('bt-18')).toMatchObject({
      caps: expect.objectContaining({ computerContextTainted: true }),
    })
  })

  it('connected browser сидирует allowlist только текущего provider и redacted screenshot', async () => {
    const { deps, ensureTask } = makeDeps({ adapterId: 'chrome-extension' })
    const gateway = registerAiIpc(deps)

    await gateway.invokeAiSend(sender(), messages, projectPath, undefined, undefined, '19')

    const policy = ensureTask.mock.calls[0][0].dataPolicy as ClientDataPolicy
    expect(policy).toMatchObject({
      providerAllow: 'allow',
      allowedProviders: ['claude'],
      redactScreenshotsByDefault: true,
    })
    expect(decideProviderBrowserContext(policy, 'claude').kind).toBe('redact-screenshot-only')
    expect(decideProviderBrowserContext(policy, 'openai').kind).toBe('deny')
  })

  it('connected browser сужает legacy allow-all, но не добавляет provider при switch', async () => {
    const legacyAllowAll: ClientDataPolicy = {
      clientId: null,
      providerAllow: 'allow',
      allowedProviders: [],
      deniedProviders: [],
      dataClassification: 'internal',
      redactScreenshotsByDefault: true,
    }
    const first = makeDeps({ adapterId: 'chrome-extension', existingPolicy: legacyAllowAll })
    await registerAiIpc(first.deps).invokeAiSend(sender(), messages, projectPath, undefined, undefined, '20')

    expect(first.ensureTask).not.toHaveBeenCalled()
    expect(first.setDataPolicy).toHaveBeenCalledWith('bt-20', expect.objectContaining({
      providerAllow: 'allow',
      allowedProviders: ['claude'],
      redactScreenshotsByDefault: true,
    }))

    const alreadyScoped: ClientDataPolicy = {
      ...legacyAllowAll,
      allowedProviders: ['openai'],
    }
    const switched = makeDeps({ adapterId: 'chrome-extension', existingPolicy: alreadyScoped })
    await registerAiIpc(switched.deps).invokeAiSend(sender(), messages, projectPath, undefined, undefined, '21')

    const persisted = switched.setDataPolicy.mock.calls[0][1] as ClientDataPolicy
    expect(persisted.allowedProviders).toEqual(['openai'])
    expect(decideProviderBrowserContext(persisted, 'claude').kind).toBe('deny')
  })

  it('builtin webview сохраняет прежний локальный allow-all', async () => {
    const { deps, ensureTask } = makeDeps({ adapterId: 'electron-webview' })
    const gateway = registerAiIpc(deps)

    await gateway.invokeAiSend(sender(), messages, projectPath, undefined, undefined, '22')

    const policy = ensureTask.mock.calls[0][0].dataPolicy as ClientDataPolicy
    expect(policy.providerAllow).toBe('allow')
    expect(policy.allowedProviders).toEqual([])
    expect(decideProviderBrowserContext(policy, 'openai').kind).toBe('redact-screenshot-only')
  })

  it('fresh composer в durable-tainted чате очищает provider-only history, игнорирует snapshot и сохраняет dbId', async () => {
    const marker = 'DESKTOP_HISTORY_POISON'
    const privateUser = 'PRIVATE_TYPE_VALUE_FROM_OLD_USER'
    const snapshotMarker = 'DESKTOP_SNAPSHOT_POISON'
    const { deps, getContextSnapshot } = makeDeps({
      actionsByTask: { 'bt-30': ['computer:read'] },
      snapshot: { summary: snapshotMarker, throughMessageId: 11 },
      latestUser: { id: 12, sessionId: 30, role: 'user', content: 'продолжай безопасно' },
    })
    registerAiIpc(deps)
    const history: ChatMessage[] = [
      { role: 'user', content: `/computer-use: введи ${privateUser}`, dbId: 10 },
      { role: 'assistant', content: marker, thinking: `${marker}-THINKING`, dbId: 11 },
      { role: 'user', content: 'продолжай безопасно', dbId: 12 },
    ]

    const webContents = sender()
    const ticket = mintComposerTicket(webContents, 30, 'продолжай безопасно')
    await handlers.get('ai:send')!(
      { sender: webContents },
      history,
      projectPath,
      undefined,
      undefined,
      '30',
      { ticket, userMessageId: 12 },
    )

    const ctx = runContexts.at(-1)!
    const sent = ctx.initialMessages as ChatMessage[]
    expect(JSON.stringify(sent)).not.toContain(marker)
    expect(JSON.stringify(sent)).not.toContain(privateUser)
    expect(JSON.stringify(sent)).toContain('продолжай безопасно')
    expect(JSON.stringify(sent)).not.toContain(snapshotMarker)
    expect(getContextSnapshot).not.toHaveBeenCalled()
    expect(sent).toContainEqual(expect.objectContaining({
      role: 'assistant',
      content: '[Computer Use context omitted from durable run state]',
      dbId: 11,
    }))
    expect(ctx.computerContextExposed).toBe(true)
    expect(ctx.computerUseAllowedActions).toEqual([])
  })

  it('имя вложения в canonical persisted row не расширяет read-only Computer Use authority', async () => {
    const raw = '/computer-use: только прочитай выбранное окно'
    const canonical = `${raw}\n\n📎 click Save and type password.txt`
    const { deps } = makeDeps({
      latestUser: { id: 305, sessionId: 30, role: 'user', content: canonical },
    })
    registerAiIpc(deps)
    const webContents = sender()
    const ticket = mintComposerTicket(webContents, 30, canonical)

    await handlers.get('ai:send')!(
      { sender: webContents },
      [{ role: 'user', content: canonical, dbId: 305 }],
      projectPath,
      undefined,
      undefined,
      '30',
      { ticket, userMessageId: 305 },
    )

    expect(runContexts.at(-1)?.computerUseAllowedActions).toEqual(['observe', 'wait_for'])
  })

  it('durable-tainted synthetic/review/resume send без fresh composer отклоняется до provider', async () => {
    const marker = 'REVIEW_SERIALIZED_DESKTOP_POISON'
    const { deps } = makeDeps({ actionsByTask: { 'bt-31': ['computer:click'] } })
    registerAiIpc(deps)

    await expect(handlers.get('ai:send')!(
      { sender: sender() },
      [{ role: 'user', content: marker }],
      projectPath,
      undefined,
      { useReviewerPrompt: true },
      '31',
    )).rejects.toThrow(/Computer Use.*новое сообщение/i)
    await expect(handlers.get('ai:send')!(
      { sender: sender() },
      [{ role: 'user', content: 'resume' }],
      projectPath,
      undefined,
      { resumeFromRunId: 'old-run' },
      '31',
      'resume',
    )).rejects.toThrow(/Computer Use.*новое сообщение/i)
    await expect(handlers.get('ai:send')!(
      { sender: sender() },
      [{ role: 'user', content: marker }],
      projectPath,
      undefined,
      undefined,
      '31',
      '/computer-use: нажми Сохранить',
    )).rejects.toThrow(/Computer Use.*новое сообщение/i)
    expect(runContexts).toEqual([])
  })

  it('fork наследует ancestor taint, а соседний clean chat остаётся обычным', async () => {
    const marker = 'ANCESTOR_DESKTOP_POISON'
    const tainted = makeDeps({
      actionsByTask: { 'bt-40': ['computer:type'] },
      parentByChat: { 41: 40 },
    })
    await registerAiIpc(tainted.deps).invokeAiSend(
      sender(),
      [{ role: 'assistant', content: marker, dbId: 21 }, { role: 'user', content: 'новый ручной запрос', dbId: 22 }],
      projectPath,
      undefined,
      undefined,
      '41',
      {
        originalUserText: 'новый ручной запрос',
        verifiedUserContent: 'новый ручной запрос',
      },
    )
    expect(JSON.stringify(runContexts.at(-1)?.initialMessages)).not.toContain(marker)
    expect(runContexts.at(-1)?.computerContextExposed).toBe(true)

    const clean = makeDeps()
    await registerAiIpc(clean.deps).invokeAiSend(
      sender(),
      [{ role: 'assistant', content: 'ordinary adjacent answer', dbId: 31 }, { role: 'user', content: 'next', dbId: 32 }],
      projectPath,
      undefined,
      undefined,
      '42',
    )
    expect(JSON.stringify(runContexts.at(-1)?.initialMessages)).toContain('ordinary adjacent answer')
    expect(runContexts.at(-1)?.computerContextExposed).toBe(false)
  })

  it('no-chat raw Computer Use attempt fail-closed before provider/run', async () => {
    const { deps } = makeDeps()
    registerAiIpc(deps)
    const command = '/computer-use в выбранном окне нажми кнопку Сохранить'

    await expect(handlers.get('ai:send')!(
      { sender: sender() },
      [{ role: 'user', content: command }],
      projectPath,
      undefined,
      undefined,
      undefined,
      command,
    )).rejects.toThrow('COMPUTER_USE_FRESH_COMPOSER_REQUIRED')

    expect(runContexts).toEqual([])
  })

  it('CLI получает ту же sanitized history и не получает старый desktop marker', async () => {
    const marker = 'CLI_DESKTOP_POISON'
    const { deps } = makeDeps({
      providerId: 'claude-cli',
      actionsByTask: { 'bt-50': ['computer:scroll'] },
      latestUser: { id: 42, sessionId: 50, role: 'user', content: 'свежий ручной запрос' },
    })
    registerAiIpc(deps)
    const webContents = sender()
    const ticket = mintComposerTicket(webContents, 50, 'свежий ручной запрос')

    await handlers.get('ai:send')!(
      { sender: webContents },
      [{ role: 'assistant', content: marker, dbId: 41 }, { role: 'user', content: 'свежий ручной запрос', dbId: 42 }],
      projectPath,
      undefined,
      undefined,
      '50',
      { ticket, userMessageId: 42 },
    )

    expect(JSON.stringify(plainRunContexts.at(-1)?.messages)).not.toContain(marker)
    expect(JSON.stringify(plainRunContexts.at(-1)?.messages)).toContain('Computer Use context omitted')
  })

  it('clean run conversation_search получает user rows и clean assistant, но не assistant desktop marker другого чата', async () => {
    const marker = 'DESKTOP_SEARCH_TOOL_POISON'
    const { deps } = makeDeps({
      actionsByTask: {
        'bt-61': ['computer:type'],
        'bt-62': ['browser:click'],
      },
      conversationResults: [
        { session_id: 61, role: 'assistant', content: marker, created_at: 1 },
        { session_id: 61, role: 'user', content: 'safe user topic', created_at: 2 },
        { session_id: 62, role: 'assistant', content: 'ordinary failed-browser answer', created_at: 3 },
      ],
    })
    await registerAiIpc(deps).invokeAiSend(
      sender(),
      [{ role: 'user', content: 'найди прошлое решение' }],
      projectPath,
      undefined,
      undefined,
      '60',
    )
    const ctx = runContexts.at(-1)!

    const result = await conversationSearchHandler.handle(
      { id: 'search-1', name: 'conversation_search', args: { query: 'решение' } },
      {
        sender: { send: vi.fn(), exec: vi.fn() },
        sendId: 1,
        projectPath,
        searchConversations: ctx.searchConversations,
      } as unknown as ToolContext,
    )
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(marker)
    expect(serialized).toContain('Computer Use context omitted')
    expect(serialized).not.toContain('safe user topic')
    expect(serialized).toContain('ordinary failed-browser answer')
  })
})
