import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../../electron/storage/db'
import { createBrowserTasks } from '../../../electron/storage/browser-tasks'
import { createBrowserController } from '../../../electron/ai/browser/controller'
import { createExtensionAdapter } from '../../../electron/ai/browser/adapters/extension'
import { webviewB0Capability } from '../../../electron/ai/browser/capability'
import { localWebviewDataPolicy } from '../../../electron/ai/browser/data-policy'
import type { BridgeServer } from '../../../electron/ai/browser/bridge/server'
import type { BridgePageSnapshot } from '../../../electron/ai/browser/bridge/protocol'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function snapshot(): BridgePageSnapshot {
  return {
    text: 'Кнопка доступна',
    tables: [],
    source: {
      url: 'https://example.com/report',
      title: 'Report',
      origin: 'https://example.com',
    },
    controls: [{
      elementRef: 'button:Открыть:0',
      role: 'button',
      label: 'Открыть',
      observationVersion: 7,
    }],
    observationVersion: 7,
  }
}

describe('extension adapter lineage under concurrent chats', () => {
  let dir: string
  let db: Database

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-ext-lineage-'))
    db = openDb(join(dir, 't.db'))
  })

  afterEach(() => {
    try { db.close() } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('observe A -> concurrent observe B -> approved click A keeps A task/run lineage', async () => {
    const storage = createBrowserTasks(db)
    const freshObserveA = deferred<BridgePageSnapshot>()
    const freshObserveAStarted = deferred<void>()
    let observesA = 0
    let bridgeLineage = { browserTaskId: 'bt-none', runId: 'run-none' }
    const clicks: Array<{ browserTaskId: string; runId: string; tabRef: string }> = []

    const bridge = {
      isExtensionConnected: () => true,
      getPublicState: () => ({
        ui: 'attached' as const,
        sessionId: 'session-1',
        pairingToken: null,
        browserTaskId: bridgeLineage.browserTaskId,
        runId: bridgeLineage.runId,
        attachedTab: {
          tabRef: 'tab-1',
          url: 'https://example.com/report',
          title: 'Report',
          origin: 'https://example.com',
        },
        lastError: null,
        connected: true,
        desktopOnline: true,
      }),
      requestObserve: async (input: { browserTaskId: string; runId: string; tabRef: string }) => {
        bridgeLineage = { browserTaskId: input.browserTaskId, runId: input.runId }
        if (input.browserTaskId === 'bt-a') {
          observesA += 1
          if (observesA === 3) {
            freshObserveAStarted.resolve()
            return freshObserveA.promise
          }
        }
        return snapshot()
      },
      requestClick: async (input: {
        browserTaskId: string
        runId: string
        tabRef: string
      }) => {
        clicks.push({
          browserTaskId: input.browserTaskId,
          runId: input.runId,
          tabRef: input.tabRef,
        })
        return { ok: true as const, finalUrl: 'https://example.com/report' }
      },
    } as unknown as BridgeServer

    const adapter = createExtensionAdapter({ getBridge: () => bridge })
    const caps = webviewB0Capability(['example.com'])
    caps.allowedActionTypes = [...caps.allowedActionTypes, 'click']
    const controller = createBrowserController({
      storage,
      resolveAdapter: () => adapter,
      getBrowserMode: () => 'execute',
      getAgentMode: () => 'auto',
      getCapability: () => caps,
      getDataPolicy: () => localWebviewDataPolicy(),
      getProviderId: () => 'test',
      awaitApproval: async () => true,
    })

    for (const [browserTaskId, runId] of [['bt-a', 'run-a'], ['bt-b', 'run-b']] as const) {
      controller.ensureTask({
        browserTaskId,
        projectPath: dir,
        runId,
        browserMode: 'execute',
        caps,
        dataPolicy: localWebviewDataPolicy(),
        allowedDomains: ['example.com'],
      })
    }

    await controller.dispatch({
      browserTaskId: 'bt-a',
      runId: 'run-a',
      actionType: 'observe',
      preferredAdapter: 'chrome-extension',
      scope: { tabRef: 'tab-1' },
    })

    const clickA = controller.dispatch({
      browserTaskId: 'bt-a',
      runId: 'run-a',
      actionType: 'click',
      preferredAdapter: 'chrome-extension',
      payload: { elementRef: 'button:Открыть:0' },
      scope: { tabRef: 'tab-1' },
      expectedPostcondition: { textAppears: 'Кнопка доступна' },
    })

    await freshObserveAStarted.promise
    await controller.dispatch({
      browserTaskId: 'bt-b',
      runId: 'run-b',
      actionType: 'observe',
      preferredAdapter: 'chrome-extension',
      scope: { tabRef: 'tab-1' },
    })
    freshObserveA.resolve(snapshot())

    const result = await clickA
    expect(result.ok).toBe(true)
    expect(clicks).toEqual([{ browserTaskId: 'bt-a', runId: 'run-a', tabRef: 'tab-1' }])
  })
})
