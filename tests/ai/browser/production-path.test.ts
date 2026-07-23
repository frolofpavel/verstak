// production-path.test.ts — EXT-B0-R2-FINAL.
//
// Реальный маршрут как в production bootstrap (main.ts + ai.ts + browser handler):
//   ensureTask(seed policy) → get* читает persisted → handler → controller → adapter
//
// Три пользовательских сценария:
//   1) wrong origin → 0 кликов, block
//   2) no approval UI → 0 кликов, error (не hang)
//   3) reject=0 / approve=1 клик + widget transport (pending emit + resolve)

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../../electron/storage/db'
import { createBrowserTasks } from '../../../electron/storage/browser-tasks'
import type { BrowserTasks } from '../../../electron/storage/browser-tasks'
import { createBrowserController } from '../../../electron/ai/browser/controller'
import type { BrowserController, ControllerDeps } from '../../../electron/ai/browser/controller'
import { webviewB0Capability, parseCapabilityEnvelope } from '../../../electron/ai/browser/capability'
import { localWebviewDataPolicy, parseClientDataPolicy } from '../../../electron/ai/browser/data-policy'
import type { BrowserAdapter, Observation, CapabilityEnvelope, ClientDataPolicy, BrowserMode } from '../../../electron/ai/browser/types'
import { browserHandler, configureBrowserHandler } from '../../../electron/ipc/tool-handlers/browser'
import type { ToolContext } from '../../../electron/ipc/tool-handlers/shared'
import type { ToolCall } from '../../../electron/ai/types'

class CountingAdapter implements BrowserAdapter {
  readonly id = 'electron-webview' as const
  clickCount = 0
  navigateCount = 0
  observeCount = 0
  currentUrl = 'https://calltouch.com/report'
  currentOrigin = 'calltouch.com'
  currentTitle = 'Report'

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
        kind: 'electron-webview',
        url: this.currentUrl,
        title: this.currentTitle,
        origin: this.currentOrigin,
      },
      tenant: null,
      account: null,
      text: 'Count: 0',
      tables: [],
      controls: [{ elementRef: 'btn', role: 'button', label: 'Go', observationVersion: this.observeCount }],
      screenshotDataUrl: null,
      omissions: [],
      truncated: { text: false, selection: false, tables: false },
    }
  }
  async navigate(url: string) {
    this.navigateCount++
    this.currentUrl = url
    this.currentOrigin = new URL(url).host
    return { finalUrl: url, title: 'n' }
  }
  async back(): Promise<void> {}
  async forward(): Promise<void> {}
  async reload(): Promise<void> {}
  async click(_selector: string): Promise<{ finalUrl: string }> {
    this.clickCount++
    return { finalUrl: this.currentUrl }
  }
  async focus(): Promise<void> {}
  async scroll(): Promise<void> {}
  async screenshot(): Promise<string | null> { return null }
  unsupported(t: string) { return { ok: false as const, reason: t } }
}

/** Production-like wiring: get* читают storage (как main.ts), seed через ensureTask (как ai.ts). */
function wireProduction(bt: BrowserTasks, adapter: CountingAdapter) {
  const getCapability = (id: string): CapabilityEnvelope => {
    const t = bt.get(id)
    const parsed = t ? parseCapabilityEnvelope(t.caps) : null
    if (parsed) return parsed
    return webviewB0Capability(t?.allowedDomains ?? [])
  }
  const getDataPolicy = (id: string): ClientDataPolicy => {
    const t = bt.get(id)
    const parsed = t ? parseClientDataPolicy(t.dataPolicy) : null
    if (parsed) return parsed
    return localWebviewDataPolicy()
  }
  const getBrowserMode = (id: string): BrowserMode => bt.get(id)?.browserMode ?? 'watch'
  const deps: ControllerDeps = {
    storage: bt,
    resolveAdapter: () => adapter,
    getBrowserMode,
    getAgentMode: () => 'accept-edits',
    getCapability,
    getDataPolicy,
    getProviderId: () => 'kimi',
    // production: awaitApproval НЕТ — UI path через handler pending emit
  }
  const controller = createBrowserController(deps)
  return { controller, getCapability, getDataPolicy, getBrowserMode }
}

function mockCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    sender: { send: () => {}, exec: async () => null },
    sendId: 42,
    signal: new AbortController().signal,
    projectPath: '/p',
    tools: {} as any,
    recordWrite: () => {},
    recordPlan: () => ({ id: 0 }),
    recordJournal: () => {},
    readJournal: () => [],
    saveMemory: () => ({ id: 'x' }),
    saveDecision: () => ({}) as any,
    searchMemories: () => [],
    searchConversations: () => [],
    connectors: { list: () => [], query: async () => null },
    pendingAttachments: [],
    pendingWrites: new Map(),
    pendingCommands: new Map(),
    scopedKey: (s: number, c: string) => `${s}::${c}`,
    agentMode: 'accept-edits',
    runId: 'run-prod-1',
    parentChatId: 7,
    ...over,
  } as unknown as ToolContext
}

let dir: string
let db: Database
let bt: BrowserTasks
let adapter: CountingAdapter
let controller: BrowserController

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'r2-prod-'))
  db = openDb(join(dir, 'test.db'))
  bt = createBrowserTasks(db)
  adapter = new CountingAdapter()
  const wired = wireProduction(bt, adapter)
  controller = wired.controller
  // Production seed (mirror ai.ts ensureTask)
  controller.ensureTask({
    browserTaskId: 'bt-7',
    projectPath: '/p',
    chatId: 7,
    runId: 'run-prod-1',
    providerId: 'kimi',
    browserMode: 'execute',
    caps: webviewB0Capability(),
    dataPolicy: localWebviewDataPolicy('kimi'),
  })
})

afterEach(() => {
  configureBrowserHandler({})
  try { db?.close() } catch {}
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

describe('EXT-B0-R2 production path — persisted policy', () => {
  it('ensureTask → get* читают durable caps/mode/dataPolicy', () => {
    const task = bt.get('bt-7')
    expect(task).not.toBeNull()
    expect(task!.browserMode).toBe('execute')
    const caps = parseCapabilityEnvelope(task!.caps)
    expect(caps).not.toBeNull()
    expect(caps!.allowedActionTypes).toContain('click')
    expect(caps!.allowedDomains).toEqual([])
    const policy = parseClientDataPolicy(task!.dataPolicy)
    expect(policy).not.toBeNull()
    expect(policy!.providerAllow).toBe('allow')
    // get* через controller deps (wireProduction) = storage
    expect(controller).toBeTruthy()
  })

  it('observe (R0) проходит handler → controller → adapter с persisted policy', async () => {
    configureBrowserHandler({
      controller,
      resolveTaskId: () => 'bt-7',
    })
    const call: ToolCall = { id: 'c-obs', name: 'browser_read_page', args: {} }
    const result = await browserHandler.handle(call, mockCtx())
    expect(result.error).toBeFalsy()
    expect(adapter.observeCount).toBeGreaterThan(0)
    const task = bt.get('bt-7')
    expect(task!.currentRunId).toBe('run-prod-1')
  })
})

describe('EXT-B0-R2 scenario: wrong origin → safe stop', () => {
  it('navigate на чужой origin → block, 0 adapter navigate', async () => {
    configureBrowserHandler({
      controller,
      resolveTaskId: () => 'bt-7',
    })
    const call: ToolCall = {
      id: 'c-nav',
      name: 'browser_navigate',
      args: { url: 'https://evil.example/phish' },
    }
    const result = await browserHandler.handle(call, mockCtx())
    expect(result.error).toBeTruthy()
    expect(result.error).toMatch(/origin|allowedDomains|не разреш/i)
    expect(adapter.navigateCount).toBe(0)
    expect(adapter.clickCount).toBe(0)
  })
})

describe('EXT-B0-R2 scenario: no approval UI → safe stop', () => {
  it('production approval callback без ответа → timeout, 0 кликов, не hang', async () => {
    configureBrowserHandler({
      controller,
      resolveTaskId: () => 'bt-7',
      emitPendingBrowserAction: () => {},
      // Production callback существует, но renderer/widget не отвечает.
      awaitBrowserApproval: async () => await new Promise(() => {}),
      approvalTimeoutMs: 20,
    })
    const call: ToolCall = {
      id: 'c-click',
      name: 'browser_click',
      args: { selector: 'btn', action: 'submit' },
    }
    const result = await Promise.race([
      browserHandler.handle(call, mockCtx()),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('HANG: approval wait >2s')), 2000)),
    ])
    expect(result.error).toBeTruthy()
    expect(result.error).toMatch(/не ответил|отменён/i)
    expect(adapter.clickCount).toBe(0)
  })
})

describe('EXT-B0-R2 scenario: approval widget reject=0 / approve=1', () => {
  it('reject → 0 кликов', async () => {
    const emitted: Array<Record<string, unknown>> = []
    configureBrowserHandler({
      controller,
      resolveTaskId: () => 'bt-7',
      emitPendingBrowserAction: (_ctx, payload) => { emitted.push(payload as unknown as Record<string, unknown>) },
      awaitBrowserApproval: async () => ({ approved: false, approvalDigest: '' }),
    })
    const call: ToolCall = {
      id: 'c-rej',
      name: 'browser_click',
      args: { selector: 'btn', action: 'submit' },
    }
    const result = await browserHandler.handle(call, mockCtx())
    expect(emitted.length).toBe(1)
    expect(emitted[0].actionId).toBeTruthy()
    expect(emitted[0].approvalDigest).toBeTruthy()
    expect(result.error).toMatch(/отклонил/i)
    expect(adapter.clickCount).toBe(0)
  })

  it('approve → ровно 1 клик + ledger verified/uncertain', async () => {
    let pendingDigest = ''
    let pendingActionId = ''
    configureBrowserHandler({
      controller,
      resolveTaskId: () => 'bt-7',
      emitPendingBrowserAction: (_ctx, payload) => {
        pendingDigest = payload.approvalDigest
        pendingActionId = payload.actionId
      },
      awaitBrowserApproval: async () => {
        // digest из emit (как UI resolveBrowserAction)
        expect(pendingDigest).toBeTruthy()
        return { approved: true, approvalDigest: pendingDigest }
      },
    })
    const call: ToolCall = {
      id: 'c-ok',
      name: 'browser_click',
      args: { selector: 'btn', action: 'submit' },
    }
    const result = await browserHandler.handle(call, mockCtx())
    expect(result.error).toBeFalsy()
    expect(adapter.clickCount).toBe(1)
    expect(pendingActionId).toBeTruthy()
    const action = bt.getAction(pendingActionId)
    expect(action).not.toBeNull()
    // verified если postcondition ок, иначе uncertain — но НЕ proposed/executing
    expect(['verified', 'uncertain']).toContain(action!.status)
    // второй approve того же action — отказ (one-shot)
    const second = await controller.approveAndExecute(pendingActionId, pendingDigest)
    expect(second.ok).toBe(false)
    expect(adapter.clickCount).toBe(1)
  })

  it('origin сменился после показа widget → approve блокируется, 0 кликов', async () => {
    let pendingDigest = ''
    configureBrowserHandler({
      controller,
      resolveTaskId: () => 'bt-7',
      emitPendingBrowserAction: (_ctx, payload) => {
        pendingDigest = payload.approvalDigest
        adapter.currentUrl = 'https://evil.example/phish'
        adapter.currentOrigin = 'evil.example'
      },
      awaitBrowserApproval: async () => ({ approved: true, approvalDigest: pendingDigest }),
    })
    const result = await browserHandler.handle({
      id: 'c-drift',
      name: 'browser_click',
      args: { selector: 'btn', action: 'submit' },
    }, mockCtx())
    expect(result.error).toMatch(/origin|Preconditions/i)
    expect(adapter.clickCount).toBe(0)
  })
})

describe('EXT-B0-R2 scenario: crash → uncertain, no auto-retry', () => {
  it('executing + reconcile → uncertain; повтор approve blocked', async () => {
    // Propose R3 click with UI approve, но подменим startExecute mid-flight через
    // прямой ledger: propose → approve → startExecute → crash → reconcile.
    const r = await controller.dispatch({
      browserTaskId: 'bt-7',
      runId: 'run-prod-1',
      actionType: 'click',
      payload: { elementRef: 'btn', action: 'submit' },
      scope: { origin: 'calltouch.com' },
    })
    // Without awaitApproval, dispatch returns pendingApproval
    expect(r.pendingApproval).toBeTruthy()
    const actionId = r.actionId
    const digest = r.pendingApproval!.approvalDigest
    // Simulate: UI approved, consume started, crash mid-execute
    expect(bt.approveAction(actionId, digest)).toBe(true)
    expect(bt.consumeApproval(actionId, digest)).toBe(true)
    // now status=executing
    const mid = bt.getAction(actionId)
    expect(mid!.status).toBe('executing')
    const n = bt.reconcileStaleActions()
    expect(n).toBeGreaterThanOrEqual(1)
    const after = bt.getAction(actionId)
    expect(after!.status).toBe('uncertain')
    // no auto-retry
    expect(adapter.clickCount).toBe(0)
    const retry = await controller.approveAndExecute(actionId, digest)
    expect(retry.ok).toBe(false)
    expect(adapter.clickCount).toBe(0)
  })
})
