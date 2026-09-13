import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../../electron/storage/db'
import { createBrowserTasks, type BrowserTasks } from '../../../electron/storage/browser-tasks'
import { createBrowserController } from '../../../electron/ai/browser/controller'
import { browserHandler, configureBrowserHandler } from '../../../electron/ipc/tool-handlers/browser'
import { getActiveBrowserEnv, setActiveBrowserEnv } from '../../../electron/browser/isolated-session'
import { buildCapabilityFromCommand } from '../../../electron/ai/browser/capability'
import { localWebviewDataPolicy } from '../../../electron/ai/browser/data-policy'
import type { BrowserAdapter, Observation } from '../../../electron/ai/browser/types'
import type { ToolCall } from '../../../electron/ai/types'
import type { ToolContext } from '../../../electron/ipc/tool-handlers/shared'

class TrackingAdapter implements BrowserAdapter {
  observeCount = 0
  clickCount = 0

  constructor(readonly id: BrowserAdapter['id']) {}

  available(): boolean { return true }
  unavailableReason(): string | null { return null }
  async observe(scope: { browserTaskId: string; runId: string; tabRef?: string | null }): Promise<Observation> {
    this.observeCount += 1
    return {
      observationId: `${this.id}-obs-${this.observeCount}`,
      observationVersion: this.observeCount,
      browserTaskId: scope.browserTaskId,
      runId: scope.runId,
      capturedAt: Date.now(),
      source: {
        kind: this.id,
        tabRef: scope.tabRef ?? null,
        documentId: `${this.id}-doc`,
        url: 'https://example.test/account',
        title: this.id,
        origin: 'example.test',
      },
      text: this.id,
      tables: [],
      controls: [{ elementRef: 'button:save:0', role: 'button', label: 'Save', observationVersion: this.observeCount }],
      omissions: [],
      truncated: { text: false, selection: false, tables: false },
    }
  }
  async navigate(url: string) { return { finalUrl: url, title: this.id } }
  async back(): Promise<void> {}
  async forward(): Promise<void> {}
  async reload(): Promise<void> {}
  async click(): Promise<{ finalUrl: string }> {
    this.clickCount += 1
    return { finalUrl: 'https://example.test/account' }
  }
  async focus(): Promise<void> {}
  async scroll(): Promise<void> {}
  async screenshot(): Promise<string | null> { return null }
  unsupported(actionType: string) { return { ok: false as const, reason: actionType } }
}

function context(sendId: number): ToolContext {
  return {
    sender: { send: () => {}, exec: async () => null },
    sendId,
    signal: new AbortController().signal,
    projectPath: '/project',
    agentMode: 'accept-edits',
    autoApprove: false,
    tools: {} as never,
    recordWrite: () => {},
    recordPlan: () => ({ id: 0 }),
    recordJournal: () => {},
    readJournal: () => [],
    saveMemory: () => ({ id: 'memory' }),
    saveDecision: () => ({}) as never,
    searchMemories: () => [],
    searchConversations: () => [],
    connectors: { list: () => [], query: async () => null },
    pendingAttachments: [],
    pendingWrites: new Map(),
    pendingCommands: new Map(),
    scopedKey: (id: number, callId: string) => `${id}::${callId}`,
    browserTaskId: 'bt-selection',
    runId: 'run-selection',
  } as unknown as ToolContext
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `${name}-${Math.random()}`, name, args }
}

describe('explicit builtin adapter wiring', () => {
  let dir: string
  let db: Database
  let storage: BrowserTasks
  let webview: TrackingAdapter
  let extension: TrackingAdapter

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vst-adapter-selection-'))
    db = openDb(join(dir, 'test.db'))
    storage = createBrowserTasks(db)
    webview = new TrackingAdapter('electron-webview')
    extension = new TrackingAdapter('chrome-extension')

    const caps = buildCapabilityFromCommand({ command: 'прочитай и нажми кнопку', allowedDomains: ['example.test'] })
    const controller = createBrowserController({
      storage,
      resolveAdapter: preferred => preferred === 'electron-webview' ? webview : extension,
      getBrowserMode: () => 'execute',
      getAgentMode: () => 'accept-edits',
      getCapability: () => caps,
      getDataPolicy: () => localWebviewDataPolicy('kimi'),
      getProviderId: () => 'kimi',
    })
    controller.ensureTask({
      browserTaskId: 'bt-selection',
      projectPath: '/project',
      runId: 'run-selection',
      providerId: 'kimi',
      browserMode: 'execute',
      caps,
      dataPolicy: localWebviewDataPolicy('kimi'),
      allowedDomains: ['example.test'],
    })
    configureBrowserHandler({
      controller,
      resolveTaskId: () => 'bt-selection',
      resolveAdapterId: preferred => preferred === 'electron-webview' ? 'electron-webview' : 'chrome-extension',
    })
  })

  afterEach(() => {
    configureBrowserHandler({})
    for (const sendId of [701, 702, 703, 704, 705, 706, 707]) setActiveBrowserEnv(sendId, 'builtin')
    try { db.close() } catch {}
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  it('env=builtin выбирает webview, а omitted env сохраняет connected-browser default', async () => {
    const explicit = await browserHandler.handle(call('browser_read_page', { env: 'builtin' }), {
      ...context(701),
      browserAdapterState: {},
    } as ToolContext)
    expect(explicit.error).toBeUndefined()
    expect(webview.observeCount).toBe(1)
    expect(extension.observeCount).toBe(0)
    expect((explicit.result as Record<string, unknown>).mode).toBe('builtin')
    expect(getActiveBrowserEnv(701)).toBe('builtin')

    const automatic = await browserHandler.handle(call('browser_read_page', {}), {
      ...context(702),
      browserAdapterState: {},
    } as ToolContext)
    expect(automatic.error).toBeUndefined()
    expect(extension.observeCount).toBe(1)
    expect((automatic.result as Record<string, unknown>).mode).toBe('connected')
    expect(getActiveBrowserEnv(702)).toBe('connected')
  })

  it('navigate env=builtin закрепляет webview для следующего read без env в том же run', async () => {
    const browserAdapterState = { preferred: undefined }
    const navigateCtx = {
      ...context(704),
      browserAdapterState,
    } as ToolContext

    const navigated = await browserHandler.handle(call('browser_navigate', {
      url: 'https://example.test/account',
      env: 'builtin',
    }), navigateCtx)
    expect(navigated.error).toBeUndefined()
    expect(extension.observeCount).toBe(0)

    const webviewReadsBefore = webview.observeCount
    // runner создаёт новый ToolContext на каждом model turn, но передаёт тот же
    // mutable browserAdapterState текущего run.
    const readCtx = { ...context(704), browserAdapterState } as ToolContext
    const read = await browserHandler.handle(call('browser_read_page', {}), readCtx)
    expect(read.error).toBeUndefined()
    expect(webview.observeCount).toBeGreaterThan(webviewReadsBefore)
    expect(extension.observeCount).toBe(0)
  })

  it('successful connected selection становится честным active mode прогона', async () => {
    const browserAdapterState = {}
    const connected = await browserHandler.handle(call('browser_read_page', {}), {
      ...context(707),
      browserAdapterState,
    } as ToolContext)

    expect(connected.error).toBeUndefined()
    expect(extension.observeCount).toBe(1)
    expect(getActiveBrowserEnv(707)).toBe('connected')
  })

  it('connected intent блокирует неподдержанный tool без legacy webview fallback', async () => {
    const connected = await browserHandler.handle(call('browser_snapshot', {}), {
      ...context(705),
      browserAdapterState: {},
    } as ToolContext)
    expect(connected.error).toMatch(/подключ|connected|не поддерж/i)

    const builtin = await browserHandler.handle(call('browser_snapshot', {}), {
      ...context(706),
      browserAdapterState: { preferred: 'electron-webview' as const },
    } as ToolContext)
    expect(builtin.error).toBeUndefined()
  })

  it('env=builtin хранится в approval ledger и остаётся webview при execute', async () => {
    let digest = ''
    let actionId = ''
    configureBrowserHandler({
      controller: createBrowserController({
        storage,
        resolveAdapter: preferred => preferred === 'electron-webview' ? webview : extension,
        getBrowserMode: () => 'execute',
        getAgentMode: () => 'accept-edits',
        getCapability: () => buildCapabilityFromCommand({ command: 'нажми кнопку', allowedDomains: ['example.test'] }),
        getDataPolicy: () => localWebviewDataPolicy('kimi'),
        getProviderId: () => 'kimi',
      }),
      resolveTaskId: () => 'bt-selection',
      resolveAdapterId: preferred => preferred === 'electron-webview' ? 'electron-webview' : 'chrome-extension',
      emitPendingBrowserAction: (_ctx, pending) => {
        digest = pending.approvalDigest
        actionId = pending.actionId
      },
      awaitBrowserApproval: async () => ({ approved: true, approvalDigest: digest }),
    })

    const result = await browserHandler.handle(call('browser_click', {
      env: 'builtin',
      elementRef: 'button:save:0',
    }), context(703))

    expect(result.error).toBeUndefined()
    expect(webview.clickCount).toBe(1)
    expect(extension.clickCount).toBe(0)
    expect(storage.getAction(actionId)?.scope).toMatchObject({ adapterId: 'electron-webview' })
  })
})
