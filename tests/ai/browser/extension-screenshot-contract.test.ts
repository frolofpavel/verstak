import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../../electron/storage/db'
import { createBrowserTasks } from '../../../electron/storage/browser-tasks'
import { createBrowserController } from '../../../electron/ai/browser/controller'
import { createExtensionAdapterWithTransport } from '../../../electron/ai/browser/adapters/extension'
import { webviewB0Capability } from '../../../electron/ai/browser/capability'
import { localWebviewDataPolicy } from '../../../electron/ai/browser/data-policy'

describe('extension screenshot contract', () => {
  let dir: string
  let db: Database

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-ext-shot-'))
    db = openDb(join(dir, 't.db'))
  })

  afterEach(() => {
    try { db.close() } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('null screenshot from extension is reported as failed, never verified', async () => {
    const storage = createBrowserTasks(db)
    const adapter = createExtensionAdapterWithTransport({
      connected: true,
      attachedTabRef: 'tab-1',
      attachedOrigin: 'https://example.com',
      requestObserve: async () => ({
        text: 'page text',
        tables: [],
        source: {
          url: 'https://example.com/report',
          title: 'Report',
          origin: 'https://example.com',
        },
      }),
    })
    const caps = webviewB0Capability(['example.com'])
    // Fixture correction: this test owns the adapter-null contract, so data
    // policy must allow the screenshot path to reach the adapter. Redacted
    // policy is covered independently in provider-screenshot-policy.test.ts.
    const screenshotAllowedPolicy = {
      ...localWebviewDataPolicy(),
      redactScreenshotsByDefault: false,
    }
    const controller = createBrowserController({
      storage,
      resolveAdapter: () => adapter,
      getBrowserMode: () => 'execute',
      getAgentMode: () => 'auto',
      getCapability: () => caps,
      getDataPolicy: () => screenshotAllowedPolicy,
      getProviderId: () => 'test',
    })
    controller.ensureTask({
      browserTaskId: 'bt-shot',
      projectPath: dir,
      runId: 'run-shot',
      browserMode: 'execute',
      caps,
      dataPolicy: screenshotAllowedPolicy,
      allowedDomains: ['example.com'],
    })

    const result = await controller.dispatch({
      browserTaskId: 'bt-shot',
      runId: 'run-shot',
      actionType: 'screenshot',
      preferredAdapter: 'chrome-extension',
      scope: { tabRef: 'tab-1', url: 'https://example.com/report' },
    })

    expect(result.ok).toBe(false)
    expect(result.result?.status).toBe('failed')
    expect(result.result?.detail).toMatch(/screenshot.*(недоступен|не поддерживается|пуст)/i)
  })
})
