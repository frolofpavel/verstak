import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../../electron/storage/db'
import { createBrowserTasks } from '../../../electron/storage/browser-tasks'
import { createBrowserController } from '../../../electron/ai/browser/controller'
import { webviewB0Capability } from '../../../electron/ai/browser/capability'
import { connectedBrowserDataPolicy } from '../../../electron/ai/browser/data-policy'
import type { BrowserAdapter, ClientDataPolicy, Observation } from '../../../electron/ai/browser/types'

const IMAGE_DATA_URL = `data:image/png;base64,${Buffer.from('pixels').toString('base64')}`

class ScreenshotAdapter implements BrowserAdapter {
  readonly id = 'chrome-extension' as const
  observeCount = 0
  screenshotCount = 0

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
        tabRef: 'tab-1',
        documentId: 'doc-1',
        url: 'https://example.com/report',
        title: 'Report',
        origin: 'example.com',
      },
      text: 'report text',
      tables: [],
      controls: [],
      screenshotDataUrl: IMAGE_DATA_URL,
      omissions: [],
      truncated: { text: false, selection: false, tables: false },
    }
  }
  async navigate(url: string): Promise<{ finalUrl: string; title: string }> { return { finalUrl: url, title: 'Report' } }
  async back(): Promise<void> {}
  async forward(): Promise<void> {}
  async reload(): Promise<void> {}
  async click(): Promise<{ finalUrl: string }> { return { finalUrl: 'https://example.com/report' } }
  async focus(): Promise<void> {}
  async scroll(): Promise<void> {}
  async screenshot(): Promise<string | null> {
    this.screenshotCount++
    return IMAGE_DATA_URL
  }
  unsupported(actionType: string) { return { ok: false as const, reason: actionType } }
}

let dir: string
let db: Database
let adapter: ScreenshotAdapter
let policy: ClientDataPolicy
let controller: ReturnType<typeof createBrowserController>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verstak-screenshot-policy-'))
  db = openDb(join(dir, 'test.db'))
  const storage = createBrowserTasks(db)
  adapter = new ScreenshotAdapter()
  policy = connectedBrowserDataPolicy('claude')
  const caps = webviewB0Capability(['example.com'])
  controller = createBrowserController({
    storage,
    resolveAdapter: () => adapter,
    getBrowserMode: () => 'execute',
    getAgentMode: () => 'auto',
    getCapability: () => caps,
    getDataPolicy: () => policy,
    getProviderId: () => 'claude',
  })
  controller.ensureTask({
    browserTaskId: 'bt-shot-policy',
    projectPath: dir,
    runId: 'run-shot-policy',
    providerId: 'claude',
    browserMode: 'execute',
    caps,
    dataPolicy: policy,
    allowedDomains: ['example.com'],
  })
})

afterEach(() => {
  try { db.close() } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('provider browser screenshot policy', () => {
  it('redact-screenshot-only блокирует явный screenshot до adapter', async () => {
    const result = await controller.dispatch({
      browserTaskId: 'bt-shot-policy',
      runId: 'run-shot-policy',
      providerId: 'claude',
      actionType: 'screenshot',
      preferredAdapter: 'chrome-extension',
      scope: { tabRef: 'tab-1', url: 'https://example.com/report' },
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/screenshot.*(policy|redact|запрещ)/i)
    expect(adapter.screenshotCount).toBe(0)
  })

  it('redact-screenshot-only оставляет DOM, но снимает неявный screenshot из observation', async () => {
    const result = await controller.dispatch({
      browserTaskId: 'bt-shot-policy',
      runId: 'run-shot-policy',
      providerId: 'claude',
      actionType: 'observe',
      preferredAdapter: 'chrome-extension',
      scope: { tabRef: 'tab-1' },
    })

    expect(result.ok).toBe(true)
    expect(result.observationForModel?.text).toContain('report text')
    expect(result.result?.postObservation?.screenshotDataUrl).toBeNull()
    expect(result.result?.postObservation?.omissions.join(' ')).toMatch(/screenshot.*policy/i)
  })

  it('policy с разрешённым screenshot сохраняет изображение', async () => {
    policy = { ...connectedBrowserDataPolicy('claude'), redactScreenshotsByDefault: false }

    const result = await controller.dispatch({
      browserTaskId: 'bt-shot-policy',
      runId: 'run-shot-policy',
      providerId: 'claude',
      actionType: 'screenshot',
      preferredAdapter: 'chrome-extension',
      scope: { tabRef: 'tab-1', url: 'https://example.com/report' },
    })

    expect(result.ok).toBe(true)
    expect(adapter.screenshotCount).toBe(1)
    expect(result.result?.postObservation?.screenshotDataUrl).toBe(IMAGE_DATA_URL)
  })
})
