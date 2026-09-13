import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import type { ChatEvent, ChatMessage, ChatProvider } from '../../../electron/ai/types'
import type { BrowserAdapter, CapabilityEnvelope, ClientDataPolicy, Observation } from '../../../electron/ai/browser/types'

vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  app: { getPath: () => tmpdir() },
}))

const { runApiConversation } = await import('../../../electron/ai/runner-api')
const { createFileTools } = await import('../../../electron/ai/tools')
const { openDb } = await import('../../../electron/storage/db')
const { createBrowserTasks } = await import('../../../electron/storage/browser-tasks')
const { createBrowserController } = await import('../../../electron/ai/browser/controller')
const { webviewB0Capability, parseCapabilityEnvelope } = await import('../../../electron/ai/browser/capability')
const {
  connectedBrowserDataPolicy,
  decideProviderBrowserContext,
  parseClientDataPolicy,
} = await import('../../../electron/ai/browser/data-policy')
const { configureBrowserHandler } = await import('../../../electron/ipc/tool-handlers/browser')

const DOM_SENTINEL = 'AUTHORISED CALLTOUCH DOM: revenue=42000'
const SCREENSHOT_SENTINEL = Buffer.from('AUTHORISED CALLTOUCH SCREENSHOT').toString('base64')
const TASK_ID = 'bt-fallback-policy'
const RUN_ID = 'run-fallback-policy'

class ConnectedAdapter implements BrowserAdapter {
  readonly id = 'chrome-extension' as const
  observeCount = 0
  screenshotDataUrl: string | null = null

  available(): boolean { return true }
  unavailableReason(): string | null { return null }
  async observe(scope: { browserTaskId: string; runId: string; tabRef?: string | null }): Promise<Observation> {
    this.observeCount++
    return {
      observationId: `obs-${this.observeCount}`,
      observationVersion: this.observeCount,
      browserTaskId: scope.browserTaskId,
      runId: scope.runId,
      capturedAt: Date.now(),
      source: {
        kind: 'chrome-extension',
        tabRef: scope.tabRef ?? 'tab-calltouch',
        documentId: 'doc-calltouch',
        url: 'https://my.calltouch.ru/accounts',
        title: 'Calltouch',
        origin: 'my.calltouch.ru',
      },
      text: DOM_SENTINEL,
      tables: [],
      controls: [],
      screenshotDataUrl: this.screenshotDataUrl,
      omissions: [],
      truncated: { text: false, selection: false, tables: false },
    }
  }
  async navigate(url: string): Promise<{ finalUrl: string; title: string }> { return { finalUrl: url, title: 'Calltouch' } }
  async back(): Promise<void> {}
  async forward(): Promise<void> {}
  async reload(): Promise<void> {}
  async click(): Promise<{ finalUrl: string }> { return { finalUrl: 'https://my.calltouch.ru/accounts' } }
  async focus(): Promise<void> {}
  async scroll(): Promise<void> {}
  async screenshot(): Promise<string | null> { return this.screenshotDataUrl }
  unsupported(actionType: string) { return { ok: false as const, reason: actionType } }
}

function provider(
  id: string,
  script: (turn: number, messages: ChatMessage[]) => ChatEvent[],
  inputs: ChatMessage[][],
): ChatProvider {
  let turn = 0
  return {
    id,
    name: id,
    models: [id],
    async *send(messages): AsyncGenerator<ChatEvent> {
      turn++
      inputs.push(JSON.parse(JSON.stringify(messages)) as ChatMessage[])
      for (const event of script(turn, messages)) yield event
    },
  }
}

function throwingProvider(id: string, inputs: ChatMessage[][]): ChatProvider {
  return {
    id,
    name: id,
    models: [id],
    async *send(messages): AsyncGenerator<ChatEvent> {
      inputs.push(JSON.parse(JSON.stringify(messages)) as ChatMessage[])
      throw Object.assign(new Error('401 Unauthorized'), { status: 401 })
    },
  }
}

function serialised(messages: ChatMessage[][]): string {
  return JSON.stringify(messages)
}

let dir: string
let db: Database
let adapter: ConnectedAdapter
let storage: ReturnType<typeof createBrowserTasks>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verstak-browser-fallback-policy-'))
  db = openDb(join(dir, 'test.db'))
  storage = createBrowserTasks(db)
  adapter = new ConnectedAdapter()

  const getCaps = (): CapabilityEnvelope => {
    const parsed = parseCapabilityEnvelope(storage.get(TASK_ID)?.caps)
    if (!parsed) throw new Error('missing test capability')
    return parsed
  }
  const getPolicy = (): ClientDataPolicy => {
    const parsed = parseClientDataPolicy(storage.get(TASK_ID)?.dataPolicy)
    if (!parsed) throw new Error('missing test data policy')
    return parsed
  }
  const controller = createBrowserController({
    storage,
    resolveAdapter: () => adapter,
    getBrowserMode: () => 'execute',
    getAgentMode: () => 'auto',
    getCapability: getCaps,
    getDataPolicy: getPolicy,
    // Production-shaped stale lineage: smart fallback changes the runner frame,
    // while the durable task run still names the original provider.
    getProviderId: browserTaskId => storage.currentRun(browserTaskId)?.providerId ?? null,
  })
  const caps = webviewB0Capability(['my.calltouch.ru'])
  controller.ensureTask({
    browserTaskId: TASK_ID,
    projectPath: dir,
    runId: RUN_ID,
    providerId: 'claude',
    model: 'claude-opus',
    browserMode: 'execute',
    caps,
    dataPolicy: connectedBrowserDataPolicy('claude'),
    allowedDomains: ['my.calltouch.ru'],
  })
  configureBrowserHandler({
    controller,
    resolveTaskId: () => TASK_ID,
    resolveAdapterId: () => 'chrome-extension',
  })
})

afterEach(() => {
  configureBrowserHandler({})
  try { db.close() } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

function runContext(primary: ChatProvider, fallback: ChatProvider, sender = { send: vi.fn(), exec: vi.fn(async () => undefined) }) {
  const signal = new AbortController().signal
  return {
    sender,
    sendId: 91,
    provider: primary,
    tools: createFileTools(dir, signal),
    projectPath: dir,
    initialMessages: [{ role: 'user', content: 'Прочитай подключённую вкладку Calltouch' }] as ChatMessage[],
    signal,
    recordWrite: vi.fn(),
    recordPlan: vi.fn(() => ({ id: 1 })),
    recordJournal: vi.fn(),
    readJournal: vi.fn(() => []),
    saveMemory: vi.fn(() => ({ id: 'm' })),
    invalidateMemory: vi.fn(() => true),
    saveDecision: vi.fn(() => ({ id: 1 })),
    searchMemories: vi.fn(() => []),
    searchConversations: vi.fn(() => []),
    connectors: { list: () => [], query: async () => ({}) },
    agentMode: 'auto' as const,
    turnsBudget: 5,
    getSecretForDelegate: () => null,
    providerId: 'claude' as const,
    model: 'claude-opus',
    fallbackOpts: {
      getNextProvider: (id: string) => id === 'gemini-api' ? fallback : null,
      getProviderModel: () => 'gemini-fallback',
      configuredProviders: new Set(['gemini-api']),
      triedProviders: new Set(),
    },
    parentChatId: 7,
    browserTaskIdResolver: () => TASK_ID,
    browserRunActive: true,
    browserAdapterPreference: 'chrome-extension' as const,
    browserContextProviderAllowed: (providerId: string) => {
      const policy = parseClientDataPolicy(storage.get(TASK_ID)?.dataPolicy)
      if (!policy) return false
      const decision = decideProviderBrowserContext(policy, providerId)
      return decision.kind === 'allow' || decision.kind === 'redact-screenshot-only'
    },
    browserScreenshotProviderAllowed: (providerId: string) => {
      const policy = parseClientDataPolicy(storage.get(TASK_ID)?.dataPolicy)
      if (!policy) return false
      return decideProviderBrowserContext(policy, providerId).kind === 'allow'
    },
    runId: RUN_ID,
    toolsAllow: null,
  }
}

describe('connected browser data policy across smart fallback frames', () => {
  it('fallback до первого browser_read_page запускается, но read гейтится по фактическому provider', async () => {
    const primaryInputs: ChatMessage[][] = []
    const fallbackInputs: ChatMessage[][] = []
    const primary = throwingProvider('claude', primaryInputs)
    const fallback = provider('gemini-api', turn => turn === 1
      ? [
          { type: 'tool-call', call: { id: 'read-connected', name: 'browser_read_page', args: {} } },
          { type: 'done' },
        ]
      : [{ type: 'text', text: 'Не могу прочитать вкладку из-за policy.' }, { type: 'done' }], fallbackInputs)

    await runApiConversation(runContext(primary, fallback) as never)

    expect(primaryInputs).toHaveLength(1)
    expect(fallbackInputs.length).toBeGreaterThanOrEqual(2)
    expect(adapter.observeCount).toBe(0)
    expect(serialised(fallbackInputs)).toContain('gemini-api')
    expect(serialised(fallbackInputs)).toMatch(/allowedProviders|Browser context|data policy/i)
    expect(serialised(fallbackInputs)).not.toContain(DOM_SENTINEL)
  })

  it('fallback после успешного browser_read_page не получает уже накопленный DOM', async () => {
    const primaryInputs: ChatMessage[][] = []
    const fallbackInputs: ChatMessage[][] = []
    let primaryTurn = 0
    const primary: ChatProvider = {
      id: 'claude',
      name: 'claude',
      models: ['claude-opus'],
      async *send(messages): AsyncGenerator<ChatEvent> {
        primaryTurn++
        primaryInputs.push(JSON.parse(JSON.stringify(messages)) as ChatMessage[])
        if (primaryTurn === 1) {
          yield { type: 'tool-call', call: { id: 'read-connected', name: 'browser_read_page', args: {} } }
          yield { type: 'done' }
          return
        }
        throw Object.assign(new Error('401 Unauthorized'), { status: 401 })
      },
    }
    const fallback = provider('gemini-api', () => [{ type: 'text', text: 'fallback saw history' }, { type: 'done' }], fallbackInputs)
    const sender = { send: vi.fn(), exec: vi.fn(async () => undefined) }
    const context = runContext(primary, fallback, sender)
    const getNextProvider = vi.fn(context.fallbackOpts.getNextProvider)
    context.fallbackOpts.getNextProvider = getNextProvider

    await runApiConversation(context as never)

    expect(adapter.observeCount).toBe(1)
    expect(primaryInputs).toHaveLength(2)
    expect(serialised([primaryInputs[1]])).toContain(DOM_SENTINEL)
    expect(fallbackInputs).toHaveLength(0)
    expect(getNextProvider).not.toHaveBeenCalled()
    expect(sender.send).toHaveBeenCalledWith('ai:event', expect.objectContaining({
      event: expect.objectContaining({
        type: 'tool-blocked',
        reason: expect.stringMatching(/browser.*context.*gemini-api|gemini-api.*browser.*context/i),
      }),
    }))
  })

  it('redact-screenshot-only fallback не получает screenshot из accumulatedMessages', async () => {
    const primaryInputs: ChatMessage[][] = []
    const fallbackInputs: ChatMessage[][] = []
    adapter.screenshotDataUrl = `data:image/png;base64,${SCREENSHOT_SENTINEL}`
    storage.setDataPolicy(TASK_ID, {
      ...connectedBrowserDataPolicy('claude'),
      redactScreenshotsByDefault: false,
    } as unknown as Record<string, unknown>)

    let primaryTurn = 0
    const primary: ChatProvider = {
      id: 'claude',
      name: 'claude',
      models: ['claude-opus'],
      async *send(messages): AsyncGenerator<ChatEvent> {
        primaryTurn++
        primaryInputs.push(JSON.parse(JSON.stringify(messages)) as ChatMessage[])
        if (primaryTurn === 1) {
          yield { type: 'tool-call', call: { id: 'shot-connected', name: 'browser_read_page', args: {} } }
          yield { type: 'done' }
          return
        }
        // Persisted policy can be tightened between model turns. The candidate
        // may still read DOM, but historical image bytes must not cross routes.
        storage.setDataPolicy(TASK_ID, {
          ...connectedBrowserDataPolicy('claude'),
          allowedProviders: ['claude', 'gemini-api'],
          redactScreenshotsByDefault: true,
        } as unknown as Record<string, unknown>)
        throw Object.assign(new Error('401 Unauthorized'), { status: 401 })
      },
    }
    const fallback = provider('gemini-api', () => [{ type: 'text', text: 'fallback saw screenshot' }, { type: 'done' }], fallbackInputs)
    const sender = { send: vi.fn(), exec: vi.fn(async () => undefined) }
    const context = runContext(primary, fallback, sender)
    const getNextProvider = vi.fn(context.fallbackOpts.getNextProvider)
    context.fallbackOpts.getNextProvider = getNextProvider

    await runApiConversation(context as never)

    expect(primaryInputs).toHaveLength(2)
    expect(serialised([primaryInputs[1]])).toContain(SCREENSHOT_SENTINEL)
    expect(fallbackInputs).toHaveLength(0)
    expect(getNextProvider).not.toHaveBeenCalled()
    expect(sender.send).toHaveBeenCalledWith('ai:event', expect.objectContaining({
      event: expect.objectContaining({
        type: 'tool-blocked',
        reason: expect.stringMatching(/screenshot|browser.*context/i),
      }),
    }))
  })

  it('явно allowlisted redact-screenshot-only fallback получает DOM без screenshot', async () => {
    const primaryInputs: ChatMessage[][] = []
    const fallbackInputs: ChatMessage[][] = []
    storage.setDataPolicy(TASK_ID, {
      ...connectedBrowserDataPolicy('claude'),
      allowedProviders: ['claude', 'gemini-api'],
      redactScreenshotsByDefault: true,
    } as unknown as Record<string, unknown>)

    let primaryTurn = 0
    const primary: ChatProvider = {
      id: 'claude',
      name: 'claude',
      models: ['claude-opus'],
      async *send(messages): AsyncGenerator<ChatEvent> {
        primaryTurn++
        primaryInputs.push(JSON.parse(JSON.stringify(messages)) as ChatMessage[])
        if (primaryTurn === 1) {
          yield { type: 'tool-call', call: { id: 'read-connected', name: 'browser_read_page', args: {} } }
          yield { type: 'done' }
          return
        }
        throw Object.assign(new Error('401 Unauthorized'), { status: 401 })
      },
    }
    const fallback = provider('gemini-api', () => [{ type: 'text', text: 'allowed fallback' }, { type: 'done' }], fallbackInputs)

    await runApiConversation(runContext(primary, fallback) as never)

    expect(adapter.observeCount).toBe(1)
    expect(fallbackInputs).toHaveLength(1)
    expect(serialised(fallbackInputs)).toContain(DOM_SENTINEL)
    expect(serialised(fallbackInputs)).not.toContain(SCREENSHOT_SENTINEL)
  })
})
