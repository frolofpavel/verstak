// controller.test.ts — integration test для единого dispatch chokepoint.
//
// Энд-ту-энд через mock verstakBrowser + in-memory storage + валидные adapters.
// Главные проверки:
//   • R0 observe идёт через dispatch (единый chokepoint)
//   • R3 click без approval → pendingApproval
//   • R3 click с approval → consume → execute → verified
//   • crash во время executing → reconcile → uncertain → повторное consume отказ
//   • cross-scope approval отклоняется
//   • plan-mode блокирует R1+
//   • R4 (password) блокируется

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../../electron/storage/db'
import { createBrowserTasks } from '../../../electron/storage/browser-tasks'
import type { BrowserTasks } from '../../../electron/storage/browser-tasks'
import { createBrowserController } from '../../../electron/ai/browser/controller'
import type { BrowserController, ControllerDeps, AgentMode } from '../../../electron/ai/browser/controller'
import { defaultCapability, buildCapabilityFromCommand } from '../../../electron/ai/browser/capability'
import { DEFAULT_DATA_POLICY } from '../../../electron/ai/browser/data-policy'
import type { BrowserAdapter, Observation, CapabilityEnvelope, ClientDataPolicy, BrowserMode } from '../../../electron/ai/browser/types'

// ── Mock adapter — контролируем наблюдения и действия ────────────────────────

class MockAdapter implements BrowserAdapter {
  readonly id = 'electron-webview' as const
  available(): boolean { return true }
  unavailableReason(): string | null { return null }

  currentUrl = 'https://calltouch.com/report'
  currentTitle = 'Отчёт Calltouch'
  currentText = 'Сумма: 100 000. Конверсия: 5%.'
  // throwOnClick — если выставить, click бросает ошибку (для теста circuit breaker).
  throwOnClick?: (selector: string) => Error | null
  // observeCount — сколько раз позвали observe.
  observeCount = 0

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
        tabRef: scope.tabRef ?? null,
        documentId: null,
        url: this.currentUrl,
        title: this.currentTitle,
        origin: 'calltouch.com',
      },
      tenant: 'client-a',
      account: 'pavel@x',
      text: this.currentText,
      tables: [],
      controls: [{ elementRef: 'btn-submit', role: 'button', label: 'Сохранить', state: 'enabled', observationVersion: this.observeCount }],
      screenshotDataUrl: null,
      omissions: [],
      truncated: { text: false, selection: false, tables: false },
    }
  }
  async navigate(url: string) {
    this.currentUrl = url
    this.currentTitle = 'Navigated'
    return { finalUrl: url, title: 'Navigated' }
  }
  async back(): Promise<void> { throw new Error('unsupported in mock') }
  async forward(): Promise<void> { throw new Error('unsupported in mock') }
  async reload(): Promise<void> { throw new Error('unsupported in mock') }
  async click(selector: string): Promise<{ finalUrl: string }> {
    if (this.throwOnClick) {
      const e = this.throwOnClick(selector)
      if (e) throw e
    }
    return { finalUrl: this.currentUrl }
  }
  async focus(_e: string): Promise<void> {}
  async scroll(_e: string | null, _d: { x?: number; y?: number }): Promise<void> {}
  async screenshot(): Promise<string | null> { return null }
  unsupported(actionType: string): { ok: false; reason: string } {
    return { ok: false, reason: `mock unsupported: ${actionType}` }
  }
}

// ── Test harness ─────────────────────────────────────────────────────────────

let dir: string
let db: Database
let bt: BrowserTasks
let adapter: MockAdapter
let controller: BrowserController
let caps: CapabilityEnvelope
let dataPolicy: ClientDataPolicy
let browserMode: BrowserMode
let agentMode: AgentMode
let providerId: string | null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'v54-ctrl-'))
  db = openDb(join(dir, 'test.db'))
  bt = createBrowserTasks(db)
  adapter = new MockAdapter()
  caps = defaultCapability()
  // R1: allowedDomains — calltouch.com (для mutation-тестов). click/type добавлены.
  caps = buildCapabilityFromCommand({ command: 'кликни submit', allowedDomains: ['calltouch.com'] })
  dataPolicy = { ...DEFAULT_DATA_POLICY, providerAllow: 'allow', allowedProviders: ['kimi'], dataClassification: 'internal', redactScreenshotsByDefault: false }
  browserMode = 'execute'
  agentMode = 'accept-edits'
  providerId = 'kimi'

  const deps: ControllerDeps = {
    storage: bt,
    resolveAdapter: () => adapter,
    getBrowserMode: (_id) => browserMode,
    getAgentMode: () => agentMode,
    getCapability: (_id) => caps,
    getDataPolicy: (_id) => dataPolicy,
    getProviderId: () => providerId,
  }
  controller = createBrowserController(deps)
  // Создаём задачу.
  controller.ensureTask({
    browserTaskId: 'bt-1',
    projectPath: '/p',
    runId: 'r1',
    providerId: 'kimi',
    allowedDomains: ['calltouch.com'],
    caps,
    dataPolicy,
  })
})

afterEach(() => {
  try { db?.close() } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('EXT-B0 controller — R0 observe через единый chokepoint', () => {
  it('observe → R0 → auto → verified', async () => {
    const r = await controller.dispatch({
      browserTaskId: 'bt-1', runId: 'r1', actionType: 'observe', payload: {}, scope: {},
    })
    expect(r.ok).toBe(true)
    expect(r.risk).toBe('R0')
    expect(r.decision.kind).toBe('auto')
    expect(r.result?.status).toBe('verified')
    expect(r.result?.postObservation?.source.url).toBe('https://calltouch.com/report')
  })
})

describe('EXT-B0 controller — R1 navigate в watch', () => {
  it('navigate в watch → R1 → auto → verified', async () => {
    browserMode = 'watch'
    const r = await controller.dispatch({
      browserTaskId: 'bt-1', runId: 'r1', actionType: 'navigate',
      payload: { url: 'https://calltouch.com/report2' }, scope: {},
    })
    expect(r.ok).toBe(true)
    expect(r.risk).toBe('R1')
    expect(r.decision.kind).toBe('auto')
    expect(r.result?.status).toBe('verified')
    expect(r.result?.finalUrl).toBe('https://calltouch.com/report2')
  })
})

describe('EXT-B0 controller — R3 click требует approval', () => {
  it('click без approval → pendingApproval (caller-mode)', async () => {
    const r = await controller.dispatch({
      browserTaskId: 'bt-1', runId: 'r1', actionType: 'click',
      payload: { elementRef: 'btn-submit', action: 'submit' }, scope: {},
    })
    expect(r.ok).toBe(false)
    expect(r.risk).toBe('R3')
    expect(r.decision.kind).toBe('require-approval')
    expect(r.pendingApproval).toBeDefined()
    expect(r.pendingApproval?.approvalDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('click с approval (inline) → consume → execute → verified (с postcondition)', async () => {
    // Inline-mode: deps.awaitApproval одобряет автоматически.
    const deps2: ControllerDeps = {
      storage: bt,
      resolveAdapter: () => adapter,
      getBrowserMode: () => browserMode,
      getAgentMode: () => agentMode,
      getCapability: () => caps,
      getDataPolicy: () => dataPolicy,
      getProviderId: () => providerId,
      awaitApproval: async (_id, _digest, _snap, _expires) => true,
    }
    controller = createBrowserController(deps2)
    const r = await controller.dispatch({
      browserTaskId: 'bt-1', runId: 'r1', actionType: 'click',
      payload: { elementRef: 'btn-submit', action: 'submit' }, scope: {},
      // R1 Block 7: R3 без postcondition → uncertain. Задаём postcondition
      // чтобы click стал verified (mock adapter возвращает URL с '/report').
      expectedPostcondition: { urlContains: '/report' },
    })
    expect(r.ok).toBe(true)
    expect(r.risk).toBe('R3')
    expect(r.result?.status).toBe('verified')
    // Action в storage: verified, finalizedAt заполнен.
    const a = bt.listActions('bt-1', { status: 'verified' })
    expect(a.length).toBe(1)
  })

  it('R1 Block 7: R3 click без postcondition → uncertain (не verified)', async () => {
    const deps2: ControllerDeps = {
      storage: bt,
      resolveAdapter: () => adapter,
      getBrowserMode: () => browserMode,
      getAgentMode: () => agentMode,
      getCapability: () => caps,
      getDataPolicy: () => dataPolicy,
      getProviderId: () => providerId,
      awaitApproval: async () => true,
    }
    controller = createBrowserController(deps2)
    const r = await controller.dispatch({
      browserTaskId: 'bt-1', runId: 'r1', actionType: 'click',
      payload: { elementRef: 'btn-submit', action: 'submit' }, scope: {},
      // БЕЗ expectedPostcondition — должен стать uncertain (недоказанная мутация).
    })
    expect(r.result?.status).toBe('uncertain')
    expect(r.result?.detail).toContain('postcondition')
  })

  it('click с rejected approval → reject action', async () => {
    const deps2: ControllerDeps = {
      storage: bt,
      resolveAdapter: () => adapter,
      getBrowserMode: () => browserMode,
      getAgentMode: () => agentMode,
      getCapability: () => caps,
      getDataPolicy: () => dataPolicy,
      getProviderId: () => providerId,
      awaitApproval: async () => false,
    }
    controller = createBrowserController(deps2)
    const r = await controller.dispatch({
      browserTaskId: 'bt-1', runId: 'r1', actionType: 'click',
      payload: { elementRef: 'btn-submit', action: 'submit' }, scope: {},
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('отклонил')
    const a = bt.listActions('bt-1', { status: 'rejected' })
    expect(a.length).toBe(1)
  })

  it('двойной approveAndExecute по одному actionId → второй отказ', async () => {
    // Сначала dispatch без awaitApproval → pendingApproval
    const r1 = await controller.dispatch({
      browserTaskId: 'bt-1', runId: 'r1', actionType: 'click',
      payload: { elementRef: 'btn-submit', action: 'submit' }, scope: {},
    })
    expect(r1.pendingApproval).toBeDefined()
    const actionId = r1.actionId
    const digest = r1.pendingApproval!.approvalDigest
    // Первый approveAndExecute — ok
    const r2 = await controller.approveAndExecute(actionId, digest)
    expect(r2.ok).toBe(true)
    // Второй approveAndExecute — отказ (consumed)
    const r3 = await controller.approveAndExecute(actionId, digest)
    expect(r3.ok).toBe(false)
  })

  it('approveAndExecute с неверным digest → отказ', async () => {
    const r1 = await controller.dispatch({
      browserTaskId: 'bt-1', runId: 'r1', actionType: 'click',
      payload: { elementRef: 'btn-submit', action: 'submit' }, scope: {},
    })
    const r2 = await controller.approveAndExecute(r1.actionId, 'sha256:wrong')
    expect(r2.ok).toBe(false)
    expect(r2.error).toContain('digest')
  })

  it('R1 Block 3: подмена payload через caller input — невозможно (digest от ledger)', async () => {
    // approveAndExecute(actionId, digest) не принимает payload от caller.
    // Controller пересчитывает digest ОТ LEDGER ROW и сверяет с переданным.
    const r1 = await controller.dispatch({
      browserTaskId: 'bt-1', runId: 'r1', actionType: 'click',
      payload: { elementRef: 'btn-A' }, scope: {},
    })
    // Даже если caller попытается подсунуть «B» — API не позволяет: только actionId.
    // Подменим actionId на несуществующий — получим not-found.
    const r2 = await controller.approveAndExecute('nonexistent-action', r1.pendingApproval!.approvalDigest)
    expect(r2.ok).toBe(false)
    expect(r2.error).toContain('не найден')
  })
})

describe('EXT-B0 controller — plan блокирует R1+', () => {
  it('agent_mode=plan блокирует navigate (R1)', async () => {
    agentMode = 'plan'
    browserMode = 'watch'
    const r = await controller.dispatch({
      browserTaskId: 'bt-1', runId: 'r1', actionType: 'navigate',
      payload: { url: 'https://calltouch.com/x' }, scope: {},
    })
    expect(r.ok).toBe(false)
    expect(r.decision.kind).toBe('block')
    expect(r.error).toContain('plan')
  })
  it('agent_mode=plan НЕ блокирует observe (R0)', async () => {
    agentMode = 'plan'
    browserMode = 'watch'
    const r = await controller.dispatch({
      browserTaskId: 'bt-1', runId: 'r1', actionType: 'observe', payload: {}, scope: {},
    })
    expect(r.ok).toBe(true)
    expect(r.risk).toBe('R0')
  })
})

describe('EXT-B0 controller — R4 password блокируется везде', () => {
  it('type_text с payload.password → R4 block', async () => {
    // caps должен разрешать type_text (по умолчанию defaultCapability — нет, добавим)
    caps = buildCapabilityFromCommand({ command: 'введи пароль и отправь' })
    const r = await controller.dispatch({
      browserTaskId: 'bt-1', runId: 'r1', actionType: 'type_text',
      payload: { password: 'user-secret' }, scope: {},
    })
    expect(r.ok).toBe(false)
    expect(r.risk).toBe('R4')
    expect(r.decision.kind).toBe('block')
  })
})

describe('EXT-B0 controller — crash recovery', () => {
  it('executing → reconcile → uncertain → повторный consume отказ', async () => {
    // 1. propose action (R3 click)
    const r1 = await controller.dispatch({
      browserTaskId: 'bt-1', runId: 'r1', actionType: 'click',
      payload: { elementRef: 'btn-submit', action: 'submit' }, scope: {},
    })
    const actionId = r1.actionId
    const digest = r1.pendingApproval!.approvalDigest
    // 2. Симулируем approve (статус → approved), НО НЕ consume — оставим approved
    bt.approveAction(actionId, digest)
    // 3. Симулируем начало execute (но без завершения — crash)
    bt.consumeApproval(actionId, digest)
    expect(bt.getAction(actionId)!.status).toBe('executing')
    // 4. CRASH. Запуска приложения → reconcile
    const n = controller.reconcile()
    expect(n).toBe(1)
    expect(bt.getAction(actionId)!.status).toBe('uncertain')
    // 5. Повторное approveAndExecute по тому же actionId — отказ (uncertain не consumed)
    const r2 = await controller.approveAndExecute(actionId, digest)
    expect(r2.ok).toBe(false)
  })
})

describe('EXT-B0 controller — circuit breaker на 403/429/CAPTCHA', () => {
  it('click throws 403 → action blocked (не failed)', async () => {
    adapter.throwOnClick = () => new Error('403 Forbidden')
    const deps2: ControllerDeps = {
      storage: bt,
      resolveAdapter: () => adapter,
      getBrowserMode: () => browserMode,
      getAgentMode: () => agentMode,
      getCapability: () => caps,
      getDataPolicy: () => dataPolicy,
      getProviderId: () => providerId,
      awaitApproval: async () => true, // авто-approve
    }
    controller = createBrowserController(deps2)
    const r = await controller.dispatch({
      browserTaskId: 'bt-1', runId: 'r1', actionType: 'click',
      payload: { elementRef: 'btn-submit', action: 'submit' }, scope: {},
    })
    expect(r.result?.status).toBe('blocked')
    expect(r.result?.reason).toBe('403')
    // Action в storage — blocked.
    const a = bt.listActions('bt-1', { status: 'blocked' })
    expect(a.length).toBe(1)
  })
  it('click throws CAPTCHA → blocked', async () => {
    adapter.throwOnClick = () => new Error('CAPTCHA required')
    const deps2: ControllerDeps = {
      storage: bt, resolveAdapter: () => adapter,
      getBrowserMode: () => browserMode, getAgentMode: () => agentMode,
      getCapability: () => caps, getDataPolicy: () => dataPolicy, getProviderId: () => providerId,
      awaitApproval: async () => true,
    }
    controller = createBrowserController(deps2)
    const r = await controller.dispatch({
      browserTaskId: 'bt-1', runId: 'r1', actionType: 'click',
      payload: { elementRef: 'btn-submit', action: 'submit' }, scope: {},
    })
    expect(r.result?.status).toBe('blocked')
    expect(r.result?.reason).toBe('CAPTCHA')
  })
})

describe('EXT-B0 controller — capability gate (page не расширяет)', () => {
  it('actionType НЕ в capability → block', async () => {
    caps = defaultCapability() // без click
    const r = await controller.dispatch({
      browserTaskId: 'bt-1', runId: 'r1', actionType: 'click',
      payload: { elementRef: 'btn' }, scope: {},
    })
    expect(r.ok).toBe(false)
    expect(r.decision.kind).toBe('block')
    expect(r.error).toContain('capability')
  })
})

describe('EXT-B0 controller — provider data-policy gate (BR-014)', () => {
  it('forbidden provider → deny до dispatch', async () => {
    providerId = 'glm'
    dataPolicy = { ...DEFAULT_DATA_POLICY, deniedProviders: ['glm'] }
    const r = await controller.dispatch({
      browserTaskId: 'bt-1', runId: 'r1', actionType: 'observe', payload: {}, scope: {},
    })
    expect(r.ok).toBe(false)
    expect(r.decision.kind).toBe('block')
    expect(r.error).toContain('glm')
  })
})
