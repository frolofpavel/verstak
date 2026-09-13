import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ChatEvent, ChatMessage } from '../../electron/ai/types'
import { decideProviderBrowserContext } from '../../electron/ai/browser/data-policy'
import type { BrowserAdapter, ClientDataPolicy } from '../../electron/ai/browser/types'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
  app: { getPath: () => tmpdir() },
  BrowserWindow: { fromWebContents: () => null },
}))

const runContexts: Array<Record<string, unknown>> = []
vi.mock('../../electron/ai/runner-api', () => ({
  runApiConversation: vi.fn(async (ctx: Record<string, unknown>) => { runContexts.push(ctx) }),
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

const { registerAiIpc } = await import('../../electron/ipc/ai')
const projectPath = mkdtempSync(join(tmpdir(), 'vst-browser-wiring-'))
const messages: ChatMessage[] = [{ role: 'user', content: 'Прочитай открытую вкладку' }]

function sender(): Electron.WebContents {
  return {
    isDestroyed: () => false,
    send: () => {},
  } as unknown as Electron.WebContents
}

function makeDeps(options: {
  adapterId?: BrowserAdapter['id']
  existingPolicy?: ClientDataPolicy
} = {}) {
  const ensureTask = vi.fn()
  const attachRun = vi.fn()
  const syncBrowserContext = vi.fn()
  const setDataPolicy = vi.fn()
  const existing = options.existingPolicy
    ? { allowedDomains: [], dataPolicy: options.existingPolicy }
    : null
  return {
    deps: {
      getSecret: (key: string) => key === 'anthropic_api_key' ? 'key' : null,
      getProviderId: () => 'claude' as const,
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
      searchConversations: () => [],
      browserController: { ensureTask, attachRun },
      browserTasks: { get: () => existing, setDataPolicy },
      resolveBrowserAdapterId: () => options.adapterId ?? 'electron-webview',
      syncBrowserContext,
    } as unknown as Parameters<typeof registerAiIpc>[0],
    ensureTask,
    attachRun,
    setDataPolicy,
    syncBrowserContext,
  }
}

beforeEach(() => {
  handlers.clear()
  runContexts.length = 0
})

describe('ai:send browser context wiring', () => {
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
})
