// c1-click-production-path.test.ts — EXT-C1 production path through controller.
// reject=0 clicks, approve=1 click, replay of same approval=0 extra clicks.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
import type { BridgePageSnapshot } from '../../../electron/ai/browser/bridge/protocol'

describe('C1 production-path click: reject / approve / replay', () => {
  let dir: string
  let db: Database
  let clickCount = 0
  let pageText = 'Счётчик: 0'
  let obsVersion = 100

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verstak-c1-'))
    db = openDb(join(dir, 't.db'))
    clickCount = 0
    pageText = 'Счётчик: 0'
    obsVersion = 100
  })

  afterEach(() => {
    try { db.close() } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  function makeSnap(): BridgePageSnapshot {
    return {
      text: pageText,
      tables: [],
      source: {
        url: 'http://127.0.0.1:8765/browser-click-counter.html',
        title: 'counter',
        origin: 'http://127.0.0.1:8765',
      },
      controls: [
        {
          elementRef: 'button:Увеличить:0',
          role: 'button',
          label: 'Увеличить',
          observationVersion: obsVersion,
        },
      ],
      observationVersion: obsVersion,
    }
  }

  it('reject keeps 0; approve once → 1; second approve of same action blocked', async () => {
    const storage = createBrowserTasks(db)
    const adapter = createExtensionAdapterWithTransport({
      attachedTabRef: 'tab-1',
      attachedOrigin: 'http://127.0.0.1:8765',
      browserTaskId: 'bt-c1',
      runId: 'run-c1',
      requestObserve: async () => makeSnap(),
      requestClick: async () => {
        clickCount += 1
        pageText = `Счётчик: ${clickCount}`
        obsVersion += 1
        return { ok: true, finalUrl: 'http://127.0.0.1:8765/browser-click-counter.html' }
      },
    })

    const approvals: Array<{ actionId: string; digest: string }> = []
    let autoApprove = false

    const controller = createBrowserController({
      storage,
      resolveAdapter: () => adapter,
      getBrowserMode: () => 'execute',
      getAgentMode: () => 'auto',
      getCapability: () => {
        const c = webviewB0Capability(['127.0.0.1:8765'])
        if (!c.allowedActionTypes.includes('click')) c.allowedActionTypes.push('click')
        return c
      },
      getDataPolicy: () => localWebviewDataPolicy(),
      getProviderId: () => 'test',
      awaitApproval: async (actionId, digest) => {
        approvals.push({ actionId, digest })
        return autoApprove
      },
    })

    controller.ensureTask({
      browserTaskId: 'bt-c1',
      projectPath: dir,
      runId: 'run-c1',
      browserMode: 'execute',
      caps: webviewB0Capability(['127.0.0.1:8765']),
      dataPolicy: localWebviewDataPolicy(),
      allowedDomains: ['127.0.0.1:8765'],
    })

    // ── Reject path ──
    autoApprove = false
    const rejected = await controller.dispatch({
      browserTaskId: 'bt-c1',
      runId: 'run-c1',
      actionType: 'click',
      payload: { elementRef: 'button:Увеличить:0' },
    })
    expect(rejected.ok).toBe(false)
    expect(clickCount).toBe(0)
    expect(pageText).toBe('Счётчик: 0')

    // ── Approve path ──
    autoApprove = true
    const approved = await controller.dispatch({
      browserTaskId: 'bt-c1',
      runId: 'run-c1',
      actionType: 'click',
      payload: { elementRef: 'button:Увеличить:0' },
      expectedPostcondition: { textAppears: 'Счётчик: 1' },
    })
    expect(clickCount).toBe(1)
    expect(approved.ok).toBe(true)
    expect(approved.result?.status === 'verified' || approved.result?.status === 'uncertain').toBe(true)
    expect(pageText).toBe('Счётчик: 1')
    expect(approved.result?.postObservation?.text).toContain('Счётчик: 1')

    // ── Replay same actionId approve → blocked, no second click ──
    const actionId = approved.actionId
    const digest = approvals[approvals.length - 1]?.digest || ''
    const replay = await controller.approveAndExecute(actionId, digest)
    expect(replay.ok).toBe(false)
    expect(clickCount).toBe(1)
    expect(pageText).toBe('Счётчик: 1')
  })
})
