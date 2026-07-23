// local-smoke.test.ts — EXT-B0-R1 SAFE LOCAL SMOKE.
//
// Интеграционный тест: реальный HTML с кнопкой-счётчиком (jsdom DOM), controller
// + adapter, обёрнутый над этим DOM. Проверяем:
//   • observe проходит через controller и создаёт durable task
//   • reject не меняет счётчик
//   • approve меняет счётчик ровно один раз
//   • ledger и Proof показывают тот же actionId
//   • restart не повторяет действие (reconcile → executing→uncertain)
//
// Это безопасный smoke — никаких внешних кабинетов/рекламы. Локальная HTML-страница.

// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../../electron/storage/db'
import { createBrowserTasks } from '../../../electron/storage/browser-tasks'
import { createBrowserController } from '../../../electron/ai/browser/controller'
import type { ControllerDeps } from '../../../electron/ai/browser/controller'
import { defaultCapability, buildCapabilityFromCommand } from '../../../electron/ai/browser/capability'
import { DEFAULT_DATA_POLICY } from '../../../electron/ai/browser/data-policy'
import type { BrowserAdapter, Observation, ElementRef } from '../../../electron/ai/browser/types'

// ── DOM adapter: реальная кнопка-счётчик в jsdom ─────────────────────────────

class DomButtonAdapter implements BrowserAdapter {
  readonly id = 'electron-webview' as const
  observeCount = 0
  clickCount = 0
  private button: HTMLButtonElement
  private counter: HTMLElement

  constructor() {
    // Инициализируем DOM при первом использовании.
    document.documentElement.innerHTML = `
      <body>
        <h1>Test Page</h1>
        <p>Count: <span id="counter">0</span></p>
        <button id="increment" data-testid="increment-btn">Increment</button>
      </body>
    `
    this.button = document.getElementById('increment') as HTMLButtonElement
    this.counter = document.getElementById('counter') as HTMLElement
    this.button.addEventListener('click', () => {
      const n = Number(this.counter.textContent ?? '0')
      this.counter.textContent = String(n + 1)
    })
  }

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
      source: { kind: 'electron-webview', url: 'http://localhost:8080/test', title: 'Test', origin: 'localhost' },
      text: document.body.textContent ?? '',
      tables: [],
      controls: [{ elementRef: 'increment', role: 'button', label: 'Increment', observationVersion: this.observeCount }],
      screenshotDataUrl: null,
      omissions: [],
      truncated: { text: false, selection: false, tables: false },
    }
  }
  async navigate(_url: string) { return { finalUrl: 'http://localhost:8080/test', title: 'Test' } }
  async back(): Promise<void> {}
  async forward(): Promise<void> {}
  async reload(): Promise<void> {}
  async click(elementRef: ElementRef): Promise<{ finalUrl: string }> {
    // Реальный клик по DOM-кнопке.
    const el = document.getElementById(String(elementRef)) as HTMLButtonElement | null
    if (!el) throw new Error(`Element not found: ${elementRef}`)
    el.click() // triggers DOM event handler → counter increments
    this.clickCount++
    return { finalUrl: 'http://localhost:8080/test' }
  }
  async focus(_e: string): Promise<void> {}
  async scroll(): Promise<void> {}
  async screenshot(): Promise<string | null> { return null }
  unsupported(t: string) { return { ok: false as const, reason: t } }

  getCounterValue(): number {
    return Number(this.counter.textContent ?? '0')
  }
}

let dir: string, db: Database, bt: ReturnType<typeof createBrowserTasks>, adapter: DomButtonAdapter

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'r1-smoke-'))
  db = openDb(join(dir, 'test.db'))
  bt = createBrowserTasks(db)
  adapter = new DomButtonAdapter()
})
afterEach(() => {
  try { db?.close() } catch {}
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

function buildController(opts: { awaitApproval?: () => Promise<boolean> } = {}) {
  const caps = buildCapabilityFromCommand({
    command: 'кликни increment',
    allowedDomains: ['localhost'],
  })
  const dataPolicy: typeof DEFAULT_DATA_POLICY = {
    ...DEFAULT_DATA_POLICY,
    providerAllow: 'allow',
    allowedProviders: ['kimi'],
    dataClassification: 'internal',
    redactScreenshotsByDefault: false,
  }
  const deps: ControllerDeps = {
    storage: bt,
    resolveAdapter: () => adapter,
    getBrowserMode: () => 'execute',
    getAgentMode: () => 'accept-edits',
    getCapability: () => caps,
    getDataPolicy: () => dataPolicy,
    getProviderId: () => 'kimi',
    ...(opts.awaitApproval ? { awaitApproval: opts.awaitApproval } : {}),
  }
  const controller = createBrowserController(deps)
  controller.ensureTask({
    browserTaskId: 'bt-smoke', projectPath: '/p', runId: 'r1',
    providerId: 'kimi', allowedDomains: ['localhost'], caps, dataPolicy,
  })
  return { controller, caps, dataPolicy }
}

describe('EXT-B0-R1 SAFE LOCAL SMOKE — кнопка-счётчик', () => {
  it('observe проходит через controller и создаёт durable task', async () => {
    const { controller } = buildController()
    const r = await controller.dispatch({
      browserTaskId: 'bt-smoke', runId: 'r1', actionType: 'observe',
      payload: {}, scope: {},
    })
    expect(r.ok).toBe(true)
    expect(r.risk).toBe('R0')
    // Durable task существует.
    const task = bt.get('bt-smoke')
    expect(task).not.toBeNull()
    expect(task!.browserTaskId).toBe('bt-smoke')
    expect(task!.currentRunId).toBe('r1')
  })

  it('reject не меняет счётчик', async () => {
    const { controller } = buildController({ awaitApproval: async () => false })
    expect(adapter.getCounterValue()).toBe(0)
    const r = await controller.dispatch({
      browserTaskId: 'bt-smoke', runId: 'r1', actionType: 'click',
      payload: { elementRef: 'increment', action: 'submit' }, scope: {},
    })
    expect(r.ok).toBe(false)
    expect(adapter.getCounterValue()).toBe(0) // НЕ изменился
    expect(adapter.clickCount).toBe(0)
  })

  it('approve меняет счётчик ровно один раз', async () => {
    const { controller } = buildController({ awaitApproval: async () => true })
    expect(adapter.getCounterValue()).toBe(0)
    const r = await controller.dispatch({
      browserTaskId: 'bt-smoke', runId: 'r1', actionType: 'click',
      payload: { elementRef: 'increment', action: 'submit' }, scope: {},
      expectedPostcondition: { textAppears: 'Count: 1' },
    })
    expect(r.ok).toBe(true)
    expect(r.result?.status).toBe('verified') // postcondition подтвердил Count: 1
    expect(adapter.getCounterValue()).toBe(1) // ровно один клик
    expect(adapter.clickCount).toBe(1)
  })

  it('ledger и Proof показывают тот же actionId', async () => {
    const { controller } = buildController({ awaitApproval: async () => true })
    const r = await controller.dispatch({
      browserTaskId: 'bt-smoke', runId: 'r1', actionType: 'click',
      payload: { elementRef: 'increment', action: 'submit' }, scope: {},
      expectedPostcondition: { textAppears: 'Count: 1' },
    })
    expect(r.ok).toBe(true)
    const actionId = r.actionId
    // Ledger: ровно один action с этим actionId, verified.
    const allActions = bt.listActions('bt-smoke')
    expect(allActions.length).toBeGreaterThanOrEqual(1)
    const targetAction = allActions.find(a => a.actionId === actionId)
    expect(targetAction).toBeDefined()
    expect(targetAction!.status).toBe('verified')
    // Proof: тот же actionId в proof refs.
    const proofRefs = bt.listProofRefs('bt-smoke')
    expect(proofRefs.some(ref => ref.actionId === actionId)).toBe(true)
  })

  it('restart не повторяет действие (reconcile → executing→uncertain)', async () => {
    const { controller } = buildController()
    // propose click (но НЕ approve — оставим proposed).
    const r = await controller.dispatch({
      browserTaskId: 'bt-smoke', runId: 'r1', actionType: 'click',
      payload: { elementRef: 'increment', action: 'submit' }, scope: {},
    })
    expect(r.pendingApproval).toBeDefined()
    // Симулируем: user approve + start execute, но процесс упал перед finalize.
    bt.approveAction(r.actionId, r.pendingApproval!.approvalDigest)
    bt.consumeApproval(r.actionId, r.pendingApproval!.approvalDigest)
    expect(bt.getAction(r.actionId)!.status).toBe('executing')
    expect(adapter.getCounterValue()).toBe(0) // execute не дошёл до adapter (crash)

    // RESTART: создадим НОВЫЙ adapter (симуляция свежего процесса) + reconcile.
    const adapter2 = new DomButtonAdapter()
    expect(adapter2.getCounterValue()).toBe(0) // новый процесс — счётчик снова 0
    // Передаём adapter2 в новый controller (как будто приложение перезапущено).
    const { controller: controller2 } = buildControllerForAdapter(adapter2)
    const n = controller2.reconcile()
    expect(n).toBe(1)
    // Старый action — uncertain, НЕ repeated.
    expect(bt.getAction(r.actionId)!.status).toBe('uncertain')
    expect(bt.getAction(r.actionId)!.resultStatus).toBe('crashed')
    expect(adapter2.getCounterValue()).toBe(0) // не было автоповтора
  })
})

function buildControllerForAdapter(a: DomButtonAdapter) {
  const caps = buildCapabilityFromCommand({ command: 'кликни', allowedDomains: ['localhost'] })
  const dataPolicy = { ...DEFAULT_DATA_POLICY, providerAllow: 'allow' as const, allowedProviders: ['kimi'], dataClassification: 'internal' as const, redactScreenshotsByDefault: false }
  const deps: ControllerDeps = {
    storage: bt, resolveAdapter: () => a,
    getBrowserMode: () => 'execute', getAgentMode: () => 'accept-edits',
    getCapability: () => caps, getDataPolicy: () => dataPolicy, getProviderId: () => 'kimi',
  }
  const c = createBrowserController(deps)
  return { controller: c }
}
