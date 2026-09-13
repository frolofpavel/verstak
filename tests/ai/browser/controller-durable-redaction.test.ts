import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'

import { createBrowserController } from '../../../electron/ai/browser/controller'
import type { BrowserController, ControllerDeps } from '../../../electron/ai/browser/controller'
import { buildCapabilityFromCommand } from '../../../electron/ai/browser/capability'
import { DEFAULT_DATA_POLICY } from '../../../electron/ai/browser/data-policy'
import type { BrowserAdapter, BrowserActionScope, Observation } from '../../../electron/ai/browser/types'
import { createBrowserTasks } from '../../../electron/storage/browser-tasks'
import type { BrowserTasks } from '../../../electron/storage/browser-tasks'
import { openDb } from '../../../electron/storage/db'

const TASK_ID = 'bt-durable-privacy'
const RUN_ID = 'run-safe-42'
const TAB_REF = 'tab-safe-17'
const ELEMENT_REF = 'el-0123456789abcdef'
const QUERY_SECRET = 'queryOpaque12'
const FRAGMENT_SECRET = 'fragmentX12'
const USERINFO_SECRET = 'shortPass12'
const TENANT_SECRET = 'tenantSession12'
const ACCOUNT_SECRET = `ghp_${'a'.repeat(36)}`

const LIVE_URL = `https://viewer:${USERINFO_SECRET}@app.example/callback?access_token=${QUERY_SECRET}#token=${FRAGMENT_SECRET}`
const TENANT = `https://tenant.example/context?session_id=${TENANT_SECRET}`

class DurablePrivacyAdapter implements BrowserAdapter {
  readonly id = 'chrome-extension' as const
  currentUrl = LIVE_URL
  currentText = 'Ready'
  clickCount = 0
  navigateCount = 0
  observeCount = 0

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
        tabRef: scope.tabRef ?? TAB_REF,
        documentId: 'doc-safe-9',
        url: this.currentUrl,
        title: 'Private report',
        origin: 'app.example',
      },
      tenant: TENANT,
      account: ACCOUNT_SECRET,
      text: this.currentText,
      tables: [],
      controls: [{
        elementRef: ELEMENT_REF,
        role: 'button',
        label: 'Confirm',
        state: 'enabled',
        observationVersion: this.observeCount,
      }],
      screenshotDataUrl: null,
      omissions: [],
      truncated: { text: false, selection: false, tables: false },
    }
  }

  async navigate(url: string): Promise<{ finalUrl: string; title: string }> {
    this.navigateCount++
    this.currentUrl = url
    this.currentText = 'Done'
    return { finalUrl: url, title: 'Done' }
  }

  async back(): Promise<void> {}
  async forward(): Promise<void> {}
  async reload(): Promise<void> {}

  async click(_elementRef: string, _scope: BrowserActionScope): Promise<{ finalUrl: string }> {
    this.clickCount++
    this.currentText = 'Done'
    return { finalUrl: this.currentUrl }
  }

  async focus(): Promise<void> {}
  async scroll(): Promise<void> {}
  async screenshot(): Promise<string | null> { return null }
  unsupported(actionType: string): { ok: false; reason: string } {
    return { ok: false, reason: `unsupported: ${actionType}` }
  }
}

let dir: string
let db: Database
let storage: BrowserTasks
let adapter: DurablePrivacyAdapter
let controller: BrowserController

function rawActionRow(actionId: string): Record<string, unknown> {
  return db.prepare(
    `SELECT browser_task_id, run_id, scope_json, payload_json,
            preconditions_json, expected_postcondition_json, result_detail
       FROM browser_actions WHERE action_id = ?`,
  ).get(actionId) as Record<string, unknown>
}

function expectNoRawSecrets(value: unknown): void {
  const serialized = JSON.stringify(value)
  for (const secret of [
    QUERY_SECRET,
    FRAGMENT_SECRET,
    USERINFO_SECRET,
    TENANT_SECRET,
    ACCOUNT_SECRET,
  ]) {
    expect(serialized).not.toContain(secret)
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'browser-durable-redaction-'))
  db = openDb(join(dir, 'test.db'))
  storage = createBrowserTasks(db)
  adapter = new DurablePrivacyAdapter()

  const caps = buildCapabilityFromCommand({
    command: 'открой отчёт и нажми Confirm',
    allowedDomains: ['app.example'],
  })
  const dataPolicy = {
    ...DEFAULT_DATA_POLICY,
    providerAllow: 'allow' as const,
    allowedProviders: ['kimi'],
    dataClassification: 'internal' as const,
    redactScreenshotsByDefault: false,
  }
  const deps: ControllerDeps = {
    storage,
    resolveAdapter: () => adapter,
    getBrowserMode: () => 'execute',
    getAgentMode: () => 'accept-edits',
    getCapability: () => caps,
    getDataPolicy: () => dataPolicy,
    getProviderId: () => 'kimi',
  }
  controller = createBrowserController(deps)
  controller.ensureTask({
    browserTaskId: TASK_ID,
    projectPath: '/safe/project',
    runId: RUN_ID,
    providerId: 'kimi',
    browserMode: 'execute',
    allowedDomains: ['app.example'],
    caps,
    dataPolicy,
  })
})

afterEach(() => {
  try { db?.close() } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('BrowserController durable privacy boundary', () => {
  it('persists a redacted R3 row while preserving lineage and executes its approved click', async () => {
    const proposed = await controller.dispatch({
      browserTaskId: TASK_ID,
      runId: RUN_ID,
      actionType: 'click',
      providerId: 'kimi',
      preferredAdapter: 'chrome-extension',
      payload: {
        elementRef: ELEMENT_REF,
        auditUrl: LIVE_URL,
      },
      scope: {
        tabRef: TAB_REF,
        observationId: 'obs-seed',
        elementRef: ELEMENT_REF,
      },
      preconditions: {
        expectedOrigin: 'app.example',
        expectedTenant: TENANT,
        expectedAccount: ACCOUNT_SECRET,
        expectedUrlPattern: LIVE_URL,
      },
      expectedPostcondition: {
        urlContains: '/callback',
        textAppears: 'Done',
        customCheckId: `verify:${LIVE_URL}`,
      },
    })

    expect(proposed.pendingApproval).toBeDefined()
    const before = rawActionRow(proposed.actionId)
    expectNoRawSecrets(before)
    expect(before.browser_task_id).toBe(TASK_ID)
    expect(before.run_id).toBe(RUN_ID)
    expect(JSON.parse(String(before.scope_json))).toMatchObject({
      browserTaskId: TASK_ID,
      runId: RUN_ID,
      tabRef: TAB_REF,
      origin: 'app.example',
      elementRef: ELEMENT_REF,
    })

    const executed = await controller.approveAndExecute(
      proposed.actionId,
      proposed.pendingApproval!.approvalDigest,
    )

    expect(adapter.clickCount).toBe(1)
    expect(executed.ok).toBe(true)
    expect(executed.result?.status).toBe('verified')
    expectNoRawSecrets(rawActionRow(proposed.actionId))
  })

  it('redacts URL credentials and OAuth params from durable navigate results', async () => {
    const targetUrl = `https://viewer:${USERINFO_SECRET}@app.example/next?access_token=${QUERY_SECRET}#token=${FRAGMENT_SECRET}`
    const result = await controller.dispatch({
      browserTaskId: TASK_ID,
      runId: RUN_ID,
      actionType: 'navigate',
      providerId: 'kimi',
      preferredAdapter: 'chrome-extension',
      payload: { url: targetUrl },
      scope: { tabRef: TAB_REF },
    })

    expect(result.ok).toBe(true)
    expect(adapter.navigateCount).toBe(1)
    const row = rawActionRow(result.actionId)
    expectNoRawSecrets(row)
    expect(String(row.result_detail)).toContain('app.example/next')
    const task = storage.get(TASK_ID)
    expectNoRawSecrets(task?.lastResultDetail)
    expect(task?.lastResultDetail).toContain('app.example/next')
  })
})
