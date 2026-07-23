// extension-adapter.test.ts — adapter через BrowserController (EXT-B1, observe only).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../../electron/storage/db'
import { createBrowserTasks } from '../../../electron/storage/browser-tasks'
import { createBrowserController } from '../../../electron/ai/browser/controller'
import type { BrowserController } from '../../../electron/ai/browser/controller'
import { defaultCapability } from '../../../electron/ai/browser/capability'
import { DEFAULT_DATA_POLICY } from '../../../electron/ai/browser/data-policy'
import {
  createExtensionAdapter,
  createExtensionAdapterWithTransport,
} from '../../../electron/ai/browser/adapters/extension'
import type { BrowserAdapter } from '../../../electron/ai/browser/types'

let dir: string
let db: Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verstak-ext-ad-'))
  db = openDb(join(dir, 't.db'))
})

afterEach(() => {
  try { db.close() } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('extension adapter — observe only', () => {
  it('available when bridge attached', () => {
    const ad = createExtensionAdapterWithTransport({
      connected: true,
      attachedTabRef: 'tab-1',
      sessionId: 'bs-1',
      requestObserve: async () => ({
        text: 'hello',
        tables: [],
        source: { url: 'https://example.com/', title: 't', origin: 'https://example.com' },
      }),
    })
    expect(ad.available()).toBe(true)
    expect(ad.id).toBe('chrome-extension')
  })

  it('unavailable offline / without attach', () => {
    const offline = createExtensionAdapterWithTransport({
      connected: false,
      requestObserve: async () => {
        throw new Error('no')
      },
    })
    expect(offline.available()).toBe(false)
    expect(offline.unavailableReason()).toMatch(/offline|bridge/i)

    const paired = createExtensionAdapterWithTransport({
      connected: true,
      sessionId: 'bs-1',
      attachedTabRef: null,
      requestObserve: async () => {
        throw new Error('no')
      },
    })
    expect(paired.available()).toBe(false)
    expect(paired.unavailableReason()).toMatch(/не прикреп|attach/i)
  })

  it('click without prior observe map fails; navigate/type still out of C1', async () => {
    const ad = createExtensionAdapterWithTransport({
      connected: true,
      attachedTabRef: 'tab-1',
      sessionId: 'bs-1',
      requestObserve: async () => ({
        text: 'x',
        tables: [],
        source: { url: 'https://example.com/', title: 't' },
      }),
      requestClick: async () => ({ ok: true, finalUrl: 'https://example.com/' }),
    })
    // No lastObs controls → click blocked before DOM mutation path.
    await expect(ad.click('button:X:0')).rejects.toThrow(/observation|elementRef|lineage/i)
    const nav = await ad.navigate('https://x.com')
    expect(nav.finalUrl).toBe('https://x.com')
    const u = ad.unsupported('type_text')
    expect(u.ok).toBe(false)
    expect(u.reason).toMatch(/type_text/i)
  })

  it('observe returns lineage + secret-scanned text via adapter', async () => {
    const ad = createExtensionAdapterWithTransport({
      connected: true,
      attachedTabRef: 'tab-7',
      sessionId: 'bs-1',
      requestObserve: async (input) => {
        expect(input.browserTaskId).toBe('bt-99')
        expect(input.runId).toBe('run-99')
        expect(input.tabRef).toBe('tab-7')
        return {
          text: 'token sk-abcdefghijklmnopqrstuvwxyz012345',
          tables: [{ caption: 't', rows: [['a']] }],
          source: { url: 'https://example.com/p', title: 'P', origin: 'https://example.com' },
          omissions: [],
        }
      },
    })
    const obs = await ad.observe({ browserTaskId: 'bt-99', runId: 'run-99', tabRef: 'tab-7' })
    expect(obs.browserTaskId).toBe('bt-99')
    expect(obs.runId).toBe('run-99')
    expect(obs.source.kind).toBe('chrome-extension')
    expect(obs.source.tabRef).toBe('tab-7')
    // secret scanner redacts — not raw key
    expect(obs.text).not.toMatch(/sk-abcdefghijklmnopqrstuvwxyz012345/)
  })
})

describe('extension adapter through BrowserController', () => {
  it('R0 observe dispatches via chrome-extension adapter', async () => {
    const storage = createBrowserTasks(db)
    let observeCalls = 0
    const adapter: BrowserAdapter = createExtensionAdapterWithTransport({
      connected: true,
      attachedTabRef: 'tab-ctrl',
      sessionId: 'bs-ctrl',
      requestObserve: async (input) => {
        observeCalls++
        expect(input.browserTaskId).toBe('bt-ctrl')
        expect(input.runId).toBe('run-ctrl')
        return {
          text: 'controller path works',
          tables: [],
          source: {
            url: 'https://calltouch.com/report',
            title: 'Report',
            origin: 'https://calltouch.com',
          },
        }
      },
    })

    const dataPolicy = {
      ...DEFAULT_DATA_POLICY,
      providerAllow: 'allow' as const,
      allowedProviders: ['kimi'],
      dataClassification: 'internal' as const,
      redactScreenshotsByDefault: false,
    }

    const controller: BrowserController = createBrowserController({
      storage,
      resolveAdapter: () => adapter,
      getBrowserMode: () => 'watch',
      getAgentMode: () => 'auto',
      getCapability: () => defaultCapability(),
      getDataPolicy: () => dataPolicy,
      getProviderId: () => 'kimi',
    })

    controller.ensureTask({
      browserTaskId: 'bt-ctrl',
      projectPath: dir,
      runId: 'run-ctrl',
      providerId: 'kimi',
      allowedDomains: ['calltouch.com'],
      browserMode: 'watch',
      caps: defaultCapability(),
      dataPolicy,
    })

    const result = await controller.dispatch({
      browserTaskId: 'bt-ctrl',
      runId: 'run-ctrl',
      actionType: 'observe',
      payload: {},
      scope: {},
    })

    expect(result.ok).toBe(true)
    expect(result.observation || result.result?.postObservation).toBeTruthy()
    const obs = result.observation || result.result?.postObservation
    expect(obs?.source.kind).toBe('chrome-extension')
    expect(obs?.browserTaskId).toBe('bt-ctrl')
    expect(obs?.runId).toBe('run-ctrl')
    expect(obs?.text).toMatch(/controller path works/)
    expect(observeCalls).toBeGreaterThanOrEqual(1)
  })

  it('click blocked at policy/adapter (B1 no hands)', async () => {
    const storage = createBrowserTasks(db)
    const adapter = createExtensionAdapterWithTransport({
      connected: true,
      attachedTabRef: 'tab-1',
      sessionId: 'bs-1',
      requestObserve: async () => ({
        text: 'x',
        tables: [],
        source: { url: 'https://example.com/', title: 't' },
      }),
    })
    const dataPolicy = {
      ...DEFAULT_DATA_POLICY,
      providerAllow: 'allow' as const,
      allowedProviders: ['kimi'],
      dataClassification: 'internal' as const,
      redactScreenshotsByDefault: false,
    }
    const controller = createBrowserController({
      storage,
      resolveAdapter: () => adapter,
      getBrowserMode: () => 'execute',
      getAgentMode: () => 'accept-edits',
      getCapability: () => defaultCapability(),
      getDataPolicy: () => dataPolicy,
      getProviderId: () => 'kimi',
    })
    controller.ensureTask({
      browserTaskId: 'bt-click',
      projectPath: dir,
      runId: 'run-click',
      providerId: 'kimi',
      allowedDomains: ['example.com'],
      caps: defaultCapability(),
      dataPolicy,
    })

    const result = await controller.dispatch({
      browserTaskId: 'bt-click',
      runId: 'run-click',
      actionType: 'click',
      payload: { elementRef: 'btn' },
      scope: {},
    })
    // pendingApproval OR blocked/failed — never silent verified execute
    const blocked =
      !!result.pendingApproval
      || result.ok === false
      || !!result.error
      || result.decision?.kind === 'require-approval'
      || result.decision?.kind === 'block'
      || result.result?.status === 'failed'
    expect(blocked).toBe(true)
  })
})

describe('createExtensionAdapter with null bridge', () => {
  it('not available', () => {
    const ad = createExtensionAdapter({ getBridge: () => null })
    expect(ad.available()).toBe(false)
  })
})
