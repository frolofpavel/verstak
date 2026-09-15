import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error Browser extension runtime is shipped as plain ESM JavaScript.
import { createBridgeClient } from '../../browser-extension/bridge-client.mjs'

function bridgeResponseBase(message: Record<string, unknown>): Record<string, unknown> {
  const base = { type: message.type, requestId: message.requestId, ok: true }
  return message.type === 'hello'
    ? {
        ...base,
        protocolVersion: 1,
        hostName: 'ru.verstak.browser_bridge',
        appVersion: '2.8.2',
        extensionVersion: '0.2.0',
        hostVersion: '2.8.2',
      }
    : base
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('browser extension pairing client', () => {
  it('sends its manifest version and rejects a stale desktop/host response', async () => {
    const sent: Array<Record<string, unknown>> = []
    let deliver: ((message: Record<string, unknown>) => void) | null = null
    const port = {
      postMessage(message: Record<string, unknown>) {
        sent.push(message)
        queueMicrotask(() => deliver?.({
           type: 'hello', requestId: message.requestId, ok: true,
          protocolVersion: 1, hostName: 'ru.verstak.browser_bridge',
          appVersion: '2.8.2', extensionVersion: '0.2.0', hostVersion: '2.8.1',
        }))
      },
      disconnect: vi.fn(),
      onMessage: { addListener: (fn: typeof deliver) => { deliver = fn } },
      onDisconnect: { addListener: vi.fn() },
    }
    vi.stubGlobal('chrome', {
      runtime: { id: 'jbhddmgcngdchlgmilphmbbcccfigadb', connectNative: () => port, lastError: null },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    })

    const client = createBridgeClient()
    await expect(client.hello()).rejects.toThrow(
      'Browser Employee несовместим: app=2.8.2, extension=0.2.0, host=2.8.1, protocol=1',
    )
    expect(sent[0]).toMatchObject({ type: 'hello', extensionVersion: '0.2.0' })
  })

  it('rejects a version-compatible response from a foreign Native Host identity', async () => {
    let deliver: ((message: Record<string, unknown>) => void) | null = null
    const port = {
      postMessage(message: Record<string, unknown>) {
        queueMicrotask(() => deliver?.({
          ...bridgeResponseBase(message),
          hostName: 'ru.verstak.foreign_bridge',
        }))
      },
      disconnect: vi.fn(),
      onMessage: { addListener: (fn: typeof deliver) => { deliver = fn } },
      onDisconnect: { addListener: vi.fn() },
    }
    const connectNative = vi.fn(() => port)
    vi.stubGlobal('chrome', {
      runtime: { id: 'jbhddmgcngdchlgmilphmbbcccfigadb', connectNative, lastError: null },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    })

    const client = createBridgeClient()
    await expect(client.hello()).rejects.toThrow(
      'Browser Employee несовместим: native host ru.verstak.foreign_bridge',
    )
    expect(connectNative).toHaveBeenCalledWith('ru.verstak.browser_bridge')
  })

  it('все action-result helpers сохраняют requestId входного desktop request', async () => {
    const sent: Array<Record<string, unknown>> = []
    let deliver: ((message: Record<string, unknown>) => void) | null = null
    const port = {
      postMessage(message: Record<string, unknown>) {
        sent.push(message)
        queueMicrotask(() => deliver?.({ type: message.type, requestId: message.requestId, ok: true }))
      },
      disconnect: vi.fn(),
      onMessage: { addListener: (fn: typeof deliver) => { deliver = fn } },
      onDisconnect: { addListener: vi.fn() },
    }
    vi.stubGlobal('chrome', {
      runtime: { id: 'jbhddmgcngdchlgmilphmbbcccfigadb', connectNative: () => port, lastError: null },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    })

    const client = createBridgeClient()
    expect(client.connect()).toBe(true)
    await client.pair(undefined, undefined, { fresh: true })
    await client.attach({
      tabRef: 'tab-42',
      url: 'https://example.com',
      title: 'Example',
      origin: 'https://example.com',
    })
    const common = { browserTaskId: 'bt-1', runId: 'run-1', tabRef: 'tab-42', ok: true }
    const calls: Array<[string, string, Record<string, unknown>]> = [
      ['sendObserve', 'observe', { ...common, snapshot: { text: '', tables: [], source: { url: 'https://example.com', title: 't' } } }],
      ['sendClickResult', 'click', { ...common, elementRef: 'button:Save:0', observationVersion: 1 }],
      ['sendNavigateResult', 'navigate', { ...common, finalUrl: 'https://example.com/next', title: 'Next' }],
      ['sendScrollResult', 'scroll', common],
      ['sendFocusResult', 'focus', common],
      ['sendSelectOptionResult', 'select_option', common],
      ['sendWaitForResult', 'wait_for', common],
      ['sendTypeTextResult', 'type_text', { ...common, elementRef: 'input:Name:0' }],
      ['sendClearFieldResult', 'clear_field', { ...common, elementRef: 'input:Name:0' }],
      ['sendToggleResult', 'toggle', { ...common, elementRef: 'checkbox:Agree:0' }],
      ['sendPressKeyResult', 'press_key', { ...common, elementRef: 'input:Name:0' }],
    ]

    for (const [method, type, payload] of calls) {
      const requestId = `desktop-${type}`
      await client[method]({ ...payload, requestId })
      expect(sent.at(-1)).toMatchObject({ type, requestId })
    }
  })

  it('только ответ на desktop observe_request открывает fresh action gate', async () => {
    let deliver: ((message: Record<string, unknown>) => void) | null = null
    let attachEpoch = 0
    const port = {
      postMessage: (message: Record<string, unknown>) => queueMicrotask(() => {
        const base = bridgeResponseBase(message)
        if (message.type === 'pair') {
          deliver?.({ ...base, sessionId: 'session-1', pairingToken: 'token-1', state: 'paired', attachEpoch })
        } else if (message.type === 'attach') {
          attachEpoch += 1
          deliver?.({ ...base, browserTaskId: 'bt-1', runId: 'run-1', state: 'attached', attachEpoch })
        } else {
          deliver?.(base)
        }
      }),
      disconnect: vi.fn(),
      onMessage: { addListener: (fn: typeof deliver) => { deliver = fn } },
      onDisconnect: { addListener: vi.fn() },
    }
    vi.stubGlobal('chrome', {
      runtime: { id: 'jbhddmgcngdchlgmilphmbbcccfigadb', connectNative: () => port, lastError: null },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    })

    const client = createBridgeClient()
    await client.hello()
    await client.pair(undefined, undefined, { fresh: true })
    await client.attach({ tabRef: 'tab-42', url: 'https://example.com', origin: 'https://example.com' })
    const observe = {
      browserTaskId: 'bt-1',
      runId: 'run-1',
      tabRef: 'tab-42',
      snapshot: { text: 'fresh', tables: [], source: { url: 'https://example.com', title: 'Example' } },
    }

    await client.sendObserve({ ...observe, requestId: 'manual-push' })
    expect(client.getState()).toMatchObject({ attachEpoch: 1, freshObservation: false })

    await client.sendObserve({
      ...observe,
      requestId: 'desktop-observe:1',
      establishFresh: true,
    })
    expect(client.getState()).toMatchObject({ attachEpoch: 1, freshObservation: true })
  })

  it('явный bootstrap-код не смешивается со старым sessionId', async () => {
    const sent: Array<Record<string, unknown>> = []
    let deliver: ((message: Record<string, unknown>) => void) | null = null
    const port = {
      postMessage: (message: Record<string, unknown>) => {
        sent.push(message)
        queueMicrotask(() => {
          if (message.type === 'hello') {
            deliver?.(bridgeResponseBase(message))
          } else if (message.type === 'pair') {
            deliver?.({
              type: 'pair', requestId: message.requestId, ok: true,
              sessionId: 'fresh-session', pairingToken: 'fresh-durable', state: 'paired',
            })
          }
        })
      },
      disconnect: vi.fn(),
      onMessage: { addListener: (fn: typeof deliver) => { deliver = fn } },
      onDisconnect: { addListener: vi.fn() },
    }
    vi.stubGlobal('chrome', {
      runtime: { id: 'jbhddmgcngdchlgmilphmbbcccfigadb', connectNative: () => port, lastError: null },
      storage: { local: {
        get: async () => ({ verstakSessionId: 'stale-session', verstakPairingToken: 'stale-token' }),
        set: vi.fn(async () => {}),
      } },
    })

    const client = createBridgeClient()
    await client.restoreFromStorage()
    await client.hello()
    await client.pair('FRESH123')

    const pair = sent.find((message) => message.type === 'pair')
    expect(pair?.pairingToken).toBe('FRESH123')
    expect(pair?.sessionId).toBeUndefined()
  })

  it('fresh pair не отправляет сохранённые stale credentials', async () => {
    const sent: Array<Record<string, unknown>> = []
    let deliver: ((message: Record<string, unknown>) => void) | null = null
    const port = {
      postMessage: (message: Record<string, unknown>) => {
        sent.push(message)
        queueMicrotask(() => deliver?.({
          ...bridgeResponseBase(message),
          sessionId: 'recovered-session', pairingToken: 'recovered-token', state: 'paired',
        }))
      },
      disconnect: vi.fn(),
      onMessage: { addListener: (fn: typeof deliver) => { deliver = fn } },
      onDisconnect: { addListener: vi.fn() },
    }
    vi.stubGlobal('chrome', {
      runtime: { id: 'jbhddmgcngdchlgmilphmbbcccfigadb', connectNative: () => port, lastError: null },
      storage: { local: {
        get: async () => ({ verstakSessionId: 'stale-session', verstakPairingToken: 'stale-token' }),
        set: vi.fn(async () => {}),
      } },
    })

    const client = createBridgeClient()
    await client.restoreFromStorage()
    await client.hello()
    await client.pair(undefined, undefined, { fresh: true })

    const pair = sent.find((message) => message.type === 'pair')
    expect(pair?.pairingToken).toBeUndefined()
    expect(pair?.sessionId).toBeUndefined()
  })

  it('status очищает transient attach и lineage, когда desktop их больше не держит', async () => {
    let deliver: ((message: Record<string, unknown>) => void) | null = null
    const port = {
      postMessage: (message: Record<string, unknown>) => queueMicrotask(() => {
        const base = bridgeResponseBase(message)
        if (message.type === 'pair') {
          deliver?.({ ...base, sessionId: 'session-1', pairingToken: 'token-1', state: 'paired' })
        } else if (message.type === 'attach') {
          deliver?.({ ...base, browserTaskId: 'bt-1', runId: 'run-1', state: 'attached' })
        } else if (message.type === 'status') {
          deliver?.({
            ...base,
            state: 'paired',
            sessionId: 'session-1',
            browserTaskId: null,
            runId: null,
            attachedTab: null,
          })
        } else {
          deliver?.(base)
        }
      }),
      disconnect: vi.fn(),
      onMessage: { addListener: (fn: typeof deliver) => { deliver = fn } },
      onDisconnect: { addListener: vi.fn() },
    }
    vi.stubGlobal('chrome', {
      runtime: { id: 'jbhddmgcngdchlgmilphmbbcccfigadb', connectNative: () => port, lastError: null },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    })

    const client = createBridgeClient()
    await client.hello()
    await client.pair(undefined, undefined, { fresh: true })
    await client.attach({ tabRef: 'tab-42', url: 'https://example.com', origin: 'https://example.com' })
    expect(client.getState().attachedTab).not.toBeNull()

    await client.status()
    expect(client.getState()).toMatchObject({
      ui: 'paired',
      browserTaskId: null,
      runId: null,
      attachedTab: null,
    })
  })

  it('disconnect очищает transient state, сохраняет durable пару и старый callback не гасит новый port', async () => {
    const disconnectListeners: Array<() => void> = []
    const messageListeners: Array<(message: Record<string, unknown>) => void> = []
    const makePort = () => ({
      postMessage(message: Record<string, unknown>) {
        const deliver = messageListeners.at(-1)
        queueMicrotask(() => {
          const base = bridgeResponseBase(message)
          if (message.type === 'pair') {
            deliver?.({ ...base, sessionId: 'session-1', pairingToken: 'token-1', state: 'paired' })
          } else if (message.type === 'attach') {
            deliver?.({ ...base, browserTaskId: 'bt-1', runId: 'run-1', state: 'attached' })
          } else {
            deliver?.(base)
          }
        })
      },
      disconnect: vi.fn(),
      onMessage: { addListener: (fn: (message: Record<string, unknown>) => void) => messageListeners.push(fn) },
      onDisconnect: { addListener: (fn: () => void) => disconnectListeners.push(fn) },
    })
    const ports = [makePort(), makePort()]
    const connectNative = vi.fn(() => ports.shift()!)
    vi.stubGlobal('chrome', {
      runtime: { id: 'jbhddmgcngdchlgmilphmbbcccfigadb', connectNative, lastError: null },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    })

    const client = createBridgeClient()
    await client.hello()
    await client.pair(undefined, undefined, { fresh: true })
    await client.attach({ tabRef: 'tab-42', url: 'https://example.com', origin: 'https://example.com' })
    await client.sendObserve({
      requestId: 'observe-before-reconnect',
      browserTaskId: 'bt-1',
      runId: 'run-1',
      tabRef: 'tab-42',
      establishFresh: true,
      snapshot: {
        text: 'fresh',
        tables: [],
        source: { url: 'https://example.com', title: 'Example' },
      },
    })
    expect(client.getState()).toMatchObject({
      connectionGeneration: 1,
      freshObservation: true,
    })
    client.disconnect()
    const disconnectedState = client.getState()
    expect(disconnectedState).toMatchObject({
      connected: false,
      hasPairing: true,
      browserTaskId: null,
      runId: null,
      attachedTab: null,
      connectionGeneration: 1,
      freshObservation: false,
    })
    expect(disconnectedState).not.toHaveProperty('sessionId')
    expect(disconnectedState).not.toHaveProperty('pairingToken')

    expect(client.connect()).toBe(true)
    expect(client.getState()).toMatchObject({
      connectionGeneration: 2,
      freshObservation: false,
    })
    disconnectListeners[0]?.()
    expect(client.getState().connected).toBe(true)
    expect(connectNative).toHaveBeenCalledTimes(2)
  })

  it('обрыв native host очищает live вкладку и lineage, но сохраняет durable пару', async () => {
    let deliver: ((message: Record<string, unknown>) => void) | null = null
    let disconnectListener: (() => void) | null = null
    const port = {
      postMessage: (message: Record<string, unknown>) => queueMicrotask(() => {
        const base = bridgeResponseBase(message)
        if (message.type === 'pair') {
          deliver?.({ ...base, sessionId: 'session-1', pairingToken: 'token-1', state: 'paired' })
        } else if (message.type === 'attach') {
          deliver?.({ ...base, browserTaskId: 'bt-1', runId: 'run-1', state: 'attached' })
        } else {
          deliver?.(base)
        }
      }),
      disconnect: vi.fn(),
      onMessage: { addListener: (fn: typeof deliver) => { deliver = fn } },
      onDisconnect: { addListener: (fn: () => void) => { disconnectListener = fn } },
    }
    vi.stubGlobal('chrome', {
      runtime: { id: 'jbhddmgcngdchlgmilphmbbcccfigadb', connectNative: () => port, lastError: null },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    })

    const client = createBridgeClient()
    await client.hello()
    await client.pair(undefined, undefined, { fresh: true })
    await client.attach({ tabRef: 'tab-42', url: 'https://example.com', origin: 'https://example.com' })
    expect(client.getState().attachedTab).not.toBeNull()

    expect(disconnectListener).toBeTypeOf('function')
    const fireDisconnect = disconnectListener as unknown as () => void
    fireDisconnect()

    const disconnectedState = client.getState()
    expect(disconnectedState).toMatchObject({
      connected: false,
      hasPairing: true,
      browserTaskId: null,
      runId: null,
      attachedTab: null,
    })
    expect(disconnectedState).not.toHaveProperty('sessionId')
    expect(disconnectedState).not.toHaveProperty('pairingToken')
  })
})
