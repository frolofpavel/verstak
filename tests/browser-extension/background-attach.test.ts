// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NATIVE_HOST_NAME } from '../../electron/ai/browser/bridge/constants'

const HERE = dirname(fileURLToPath(import.meta.url))
const BACKGROUND_URL = pathToFileURL(resolve(HERE, '..', '..', 'browser-extension', 'background.mjs')).href

function bridgeResponseBase(message: Record<string, unknown>): Record<string, unknown> {
  const base = { type: message.type, requestId: message.requestId, ok: true }
  return message.type === 'hello'
    ? {
        ...base,
        hostName: NATIVE_HOST_NAME,
        protocolVersion: 1,
        appVersion: '2.8.2',
        extensionVersion: '0.2.0',
        hostVersion: '2.8.2',
      }
    : base
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('browser extension attach flow', () => {
  it('submit без toolbar attach честно останавливается и не выбирает вкладку эвристикой', async () => {
    const sent: Array<Record<string, unknown>> = []
    let deliver: ((message: Record<string, unknown>) => void) | null = null
    type RuntimeListener = (
      message: Record<string, unknown>,
      sender: unknown,
      respond: (value: Record<string, unknown>) => void,
    ) => boolean
    let runtimeListener: RuntimeListener | null = null
    const executeScript = vi.fn()
    const query = vi.fn(async () => [{ id: 99, url: 'chrome://extensions', title: 'Extensions' }])
    const port = {
      postMessage(message: Record<string, unknown>) {
        sent.push(message)
        queueMicrotask(() => {
          const base = bridgeResponseBase(message)
          if (message.type === 'pair') {
            deliver?.({ ...base, sessionId: 'session-1', pairingToken: 'token-1', state: 'paired' })
          } else if (message.type === 'attach') {
            deliver?.({ ...base, browserTaskId: 'bt-1', state: 'attached' })
          } else if (message.type === 'task_submit') {
            deliver?.({ ...base, sendId: 7, browserTaskId: 'bt-1', chatId: 1 })
          } else if (message.type === 'status') {
            deliver?.({ ...base, state: 'paired', sessionId: 'raw-session-secret' })
          } else {
            deliver?.(base)
          }
        })
      },
      disconnect: vi.fn(),
      onMessage: { addListener: (fn: typeof deliver) => { deliver = fn } },
      onDisconnect: { addListener: vi.fn() },
    }
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'jbhddmgcngdchlgmilphmbbcccfigadb',
        lastError: null,
        connectNative: () => port,
        sendMessage: vi.fn(async () => ({})),
        onMessage: { addListener: (fn: typeof runtimeListener) => { runtimeListener = fn } },
      },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
      sidePanel: { setPanelBehavior: vi.fn((_opts, done) => done?.()), open: vi.fn() },
      action: { onClicked: { addListener: vi.fn() } },
      tabs: {
        // Service worker currentWindow can point at another Chrome window.
        query,
        get: vi.fn(async (tabId: number) => tabId === 42
          ? { id: 42, active: true, url: 'https://my.calltouch.ru/accounts', title: 'Calltouch' }
          : tabId === 43
            ? { id: 43, active: true }
          : null),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      permissions: { contains: vi.fn(), request: vi.fn() },
      scripting: { executeScript },
    })

    await import(BACKGROUND_URL)
    await vi.waitFor(() => expect(runtimeListener).toBeTypeOf('function'))
    await vi.waitFor(() => expect(sent.some((message) => message.type === 'pair')).toBe(true))
    const onRuntimeMessage = runtimeListener as unknown as RuntimeListener
    const response = await new Promise<Record<string, unknown>>((resolveResponse) => {
      onRuntimeMessage({ type: 'bridge.submitTask', prompt: 'Прочитай страницу' }, null, resolveResponse)
    })

    expect(response.ok).toBe(false)
    expect(response.error).toMatch(/значок Verstak|прикреп/i)
    expect(sent.some((message) => message.type === 'attach')).toBe(false)
    expect(sent.some((message) => message.type === 'task_submit')).toBe(false)
    expect(query).not.toHaveBeenCalled()
    expect(executeScript).not.toHaveBeenCalled()

    const status = await new Promise<Record<string, unknown>>((resolveResponse) => {
      onRuntimeMessage({ type: 'bridge.status' }, null, resolveResponse)
    })
    expect(status).toMatchObject({ ok: true, state: { ui: 'paired' } })
    expect(status).not.toHaveProperty('status')
    expect(JSON.stringify(status)).not.toContain('raw-session-secret')

    const noUrl = await new Promise<Record<string, unknown>>((resolveResponse) => {
      onRuntimeMessage({ type: 'bridge.attach', tabId: 43 }, null, resolveResponse)
    })
    expect(noUrl.ok).toBe(false)
    expect(noUrl.error).toMatch(/нет доступа к данным вкладки/i)
    expect(noUrl.error).not.toMatch(/служебн/i)
  })

  it('клик по иконке прикрепляет именно переданную Chrome вкладку', async () => {
    const sent: Array<Record<string, unknown>> = []
    let deliver: ((message: Record<string, unknown>) => void) | null = null
    type ActionListener = (tab: Record<string, unknown>) => void
    let actionListener: ActionListener | null = null
    type RuntimeListener = (
      message: Record<string, unknown>,
      sender: unknown,
      respond: (value: Record<string, unknown>) => void,
    ) => boolean
    let runtimeListener: RuntimeListener | null = null
    const query = vi.fn(async () => [{ id: 99, url: 'chrome://extensions', title: 'Extensions' }])
    const containsPermission = vi.fn(async () => false)
    const requestPermission = vi.fn(async () => false)
    const openSidePanel = vi.fn(async () => {})
    const executeScript = vi.fn(async () => [{
      result: {
        text: 'CALLTOUCH_PAGE_TEXT',
        tables: [],
        source: { url: 'https://my.calltouch.ru/accounts', title: 'Calltouch' },
        omissions: [],
        truncated: {},
        controls: [],
        observationVersion: 'obs-1',
      },
    }])
    const port = {
      postMessage(message: Record<string, unknown>) {
        sent.push(message)
        queueMicrotask(() => {
          const base = bridgeResponseBase(message)
          if (message.type === 'pair') {
            deliver?.({ ...base, sessionId: 'session-1', pairingToken: 'token-1', state: 'paired' })
          } else if (message.type === 'attach') {
            deliver?.({ ...base, browserTaskId: 'bt-1', state: 'attached' })
          } else {
            deliver?.(base)
          }
        })
      },
      disconnect: vi.fn(),
      onMessage: { addListener: (fn: typeof deliver) => { deliver = fn } },
      onDisconnect: { addListener: vi.fn() },
    }
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'jbhddmgcngdchlgmilphmbbcccfigadb',
        lastError: null,
        connectNative: () => port,
        sendMessage: vi.fn(async () => ({})),
        onMessage: { addListener: (fn: typeof runtimeListener) => { runtimeListener = fn } },
      },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
      sidePanel: { setPanelBehavior: vi.fn((_opts, done) => done?.()), open: openSidePanel },
      action: { onClicked: { addListener: (fn: typeof actionListener) => { actionListener = fn } } },
      tabs: {
        query,
        get: vi.fn(async (tabId: number) => tabId === 42
          ? { id: 42, active: true, url: 'https://my.calltouch.ru/accounts', title: 'Calltouch' }
          : null),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      permissions: { contains: containsPermission, request: requestPermission },
      scripting: { executeScript },
    })

    await import(`${BACKGROUND_URL}?action=${Date.now()}`)
    await vi.waitFor(() => expect(actionListener).toBeTypeOf('function'))
    const onActionClick = actionListener as unknown as ActionListener
    onActionClick({
      id: 42,
      windowId: 7,
      url: 'https://my.calltouch.ru/accounts',
      title: 'Calltouch',
    })
    await vi.waitFor(() => expect(sent.some((message) => message.type === 'attach')).toBe(true))

    const attach = sent.find((message) => message.type === 'attach')
    expect((attach?.tab as { tabRef?: string })?.tabRef).toBe('tab-42')
    expect((attach?.tab as { url?: string })?.url).toBe('https://my.calltouch.ru/accounts')
    expect(openSidePanel).toHaveBeenCalledWith({ tabId: 42 })
    expect(query).not.toHaveBeenCalled()
    expect(containsPermission).not.toHaveBeenCalled()
    expect(requestPermission).toHaveBeenCalledWith({ origins: ['https://my.calltouch.ru/*'] })

    const onRuntimeMessage = runtimeListener as unknown as RuntimeListener
    const submitted = await new Promise<Record<string, unknown>>((resolveResponse) => {
      onRuntimeMessage({ type: 'bridge.submitTask', prompt: 'Прочитай страницу' }, null, resolveResponse)
    })
    expect(submitted.ok).toBe(true)
    expect(sent.some((message) => message.type === 'task_submit')).toBe(true)

    // Отказ от постоянного доступа к домену не должен ломать текущую вкладку:
    // клик по action уже выдал временный activeTab grant.
    const sendNativeMessage = deliver as unknown as (message: Record<string, unknown>) => void
    sendNativeMessage({
      type: 'observe_request',
      requestId: 'observe-exact-1',
      browserTaskId: 'bt-1',
      runId: 'run-1',
      tabRef: 'tab-42',
    })
    await vi.waitFor(() => expect(sent.some((message) => message.type === 'observe')).toBe(true))
    const observe = sent.find((message) => message.type === 'observe')
    expect(observe?.requestId).toBe('observe-exact-1')
    expect((observe?.snapshot as { text?: string })?.text).toBe('CALLTOUCH_PAGE_TEXT')
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 42 } }))
    expect(query).not.toHaveBeenCalled()
  })

  it('после перезапуска desktop заменяет stale native host и доходит до attach', async () => {
    type ActionListener = (tab: Record<string, unknown>) => void
    let actionListener: ActionListener | null = null
    const sentByPort: Array<Array<Record<string, unknown>>> = [[], []]
    const makePort = (index: number, offline: boolean) => {
      let deliver: ((message: Record<string, unknown>) => void) | null = null
      return {
        postMessage(message: Record<string, unknown>) {
          sentByPort[index].push(message)
          queueMicrotask(() => {
            if (offline) {
              deliver?.({
                type: 'error', requestId: message.requestId, ok: false,
                code: 'desktop_offline', message: 'Verstak desktop offline (pipe closed)',
              })
              return
            }
            const base = bridgeResponseBase(message)
            if (message.type === 'pair') {
              deliver?.({ ...base, sessionId: 'session-2', pairingToken: 'token-2', state: 'paired' })
            } else if (message.type === 'attach') {
              deliver?.({ ...base, browserTaskId: 'bt-2', state: 'attached' })
            } else {
              deliver?.(base)
            }
          })
        },
        disconnect: vi.fn(),
        onMessage: { addListener: (fn: typeof deliver) => { deliver = fn } },
        onDisconnect: { addListener: vi.fn() },
      }
    }
    const ports = [makePort(0, true), makePort(1, false)]
    const connectNative = vi.fn(() => ports.shift()!)
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'jbhddmgcngdchlgmilphmbbcccfigadb',
        lastError: null,
        connectNative,
        sendMessage: vi.fn(async () => ({})),
        onMessage: { addListener: vi.fn() },
      },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) } },
      sidePanel: { open: vi.fn(async () => {}) },
      action: { onClicked: { addListener: (fn: typeof actionListener) => { actionListener = fn } } },
      tabs: {
        query: vi.fn(), get: vi.fn(),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      permissions: { contains: vi.fn(async () => false), request: vi.fn(async () => true) },
      scripting: { executeScript: vi.fn() },
    })

    await import(`${BACKGROUND_URL}?restart=${Date.now()}`)
    await vi.waitFor(() => expect(sentByPort[0].some((message) => message.type === 'hello')).toBe(true))
    await vi.waitFor(() => expect(actionListener).toBeTypeOf('function'))
    const onActionClick = actionListener as unknown as ActionListener
    onActionClick({ id: 42, url: 'https://my.calltouch.ru/accounts', title: 'Calltouch' })

    await vi.waitFor(() => expect(connectNative).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(sentByPort[1].some((message) => message.type === 'attach')).toBe(true))
  })

  it('Settings auth window повторяет pair на уже подключённом worker без второго toolbar click', async () => {
    let deliver: ((message: Record<string, unknown>) => void) | null = null
    const sent: Array<Record<string, unknown>> = []
    const actionListener = vi.fn()
    let pairAttempts = 0
    const port = {
      postMessage(message: Record<string, unknown>) {
        sent.push(message)
        queueMicrotask(() => {
          if (message.type === 'hello') {
            deliver?.(bridgeResponseBase(message))
            return
          }
          if (message.type === 'pair') {
            pairAttempts += 1
            if (pairAttempts <= 2) {
              deliver?.({
                type: 'error',
                requestId: message.requestId,
                ok: false,
                code: 'pair_rejected',
                message: 'Settings auth window is closed',
              })
              return
            }
            deliver?.({
              type: 'pair',
              requestId: message.requestId,
              ok: true,
              sessionId: 'session-settings',
              pairingToken: 'token-settings',
              state: 'paired',
            })
          }
        })
      },
      disconnect: vi.fn(),
      onMessage: { addListener: (fn: typeof deliver) => { deliver = fn } },
      onDisconnect: { addListener: vi.fn() },
    }
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'jbhddmgcngdchlgmilphmbbcccfigadb',
        lastError: null,
        connectNative: vi.fn(() => port),
        sendMessage: vi.fn(async () => ({})),
        onMessage: { addListener: vi.fn() },
      },
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
        },
      },
      sidePanel: { open: vi.fn(async () => {}) },
      action: { onClicked: { addListener: actionListener } },
      tabs: { query: vi.fn(), get: vi.fn(), onUpdated: { addListener: vi.fn(), removeListener: vi.fn() } },
      permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
      scripting: { executeScript: vi.fn() },
    })

    await import(`${BACKGROUND_URL}?settings-auth=${Date.now()}`)
    await vi.waitFor(() => expect(pairAttempts).toBe(2))
    expect(deliver).toBeTypeOf('function')

    const sendNativeMessage = deliver as unknown as (message: Record<string, unknown>) => void
    sendNativeMessage({
      v: 1,
      type: 'auth_available',
      requestId: 'settings-auth-1',
      expiresAt: Date.now() + 60_000,
    })

    await vi.waitFor(() => expect(pairAttempts).toBe(3))
    expect(sent.filter((message) => message.type === 'hello')).toHaveLength(2)
    expect(actionListener).toHaveBeenCalledTimes(1)
  })

  it('после неожиданного disconnect сам восстанавливает сохранённую пару без нового Pair', async () => {
    vi.useFakeTimers()
    const sentByPort: Array<Array<Record<string, unknown>>> = [[], []]
    let firstDisconnect: (() => void) | null = null
    const makePort = (index: number) => {
      let deliver: ((message: Record<string, unknown>) => void) | null = null
      return {
        postMessage(message: Record<string, unknown>) {
          sentByPort[index].push(message)
          queueMicrotask(() => {
            const base = bridgeResponseBase(message)
            if (message.type === 'pair') {
              deliver?.({ ...base, sessionId: 'session-1', pairingToken: 'token-1', state: 'paired' })
            } else {
              deliver?.(base)
            }
          })
        },
        disconnect: vi.fn(),
        onMessage: { addListener: (fn: typeof deliver) => { deliver = fn } },
        onDisconnect: {
          addListener: (fn: () => void) => {
            if (index === 0) firstDisconnect = fn
          },
        },
      }
    }
    const ports = [makePort(0), makePort(1)]
    const connectNative = vi.fn(() => ports.shift()!)
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'jbhddmgcngdchlgmilphmbbcccfigadb',
        lastError: null,
        connectNative,
        sendMessage: vi.fn(async () => ({})),
        onMessage: { addListener: vi.fn() },
      },
      storage: {
        local: {
          get: vi.fn(async () => ({ verstakSessionId: 'session-1', verstakPairingToken: 'token-1' })),
          set: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
        },
      },
      sidePanel: { open: vi.fn(async () => {}) },
      action: { onClicked: { addListener: vi.fn() } },
      tabs: { query: vi.fn(), get: vi.fn(), onUpdated: { addListener: vi.fn(), removeListener: vi.fn() } },
      permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
      scripting: { executeScript: vi.fn() },
    })

    await import(`${BACKGROUND_URL}?auto-reconnect=${Date.now()}`)
    await vi.waitFor(() => expect(sentByPort[0].some((message) => message.type === 'pair')).toBe(true))
    expect(firstDisconnect).toBeTypeOf('function')

    const disconnect = firstDisconnect as unknown as () => void
    disconnect()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(connectNative).toHaveBeenCalledTimes(2)
    expect(sentByPort[1].some((message) => message.type === 'pair')).toBe(true)
  })

  it('reconnect на той же tabRef не исполняет старый elementRef до fresh observe', async () => {
    vi.useFakeTimers()
    type ActionListener = (tab: Record<string, unknown>) => void
    let actionListener: ActionListener | null = null
    let firstDisconnect: (() => void) | null = null
    const sentByPort: Array<Array<Record<string, unknown>>> = [[], []]
    const deliverByPort: Array<((message: Record<string, unknown>) => void) | null> = [null, null]

    const makePort = (index: number) => {
      let deliver: ((message: Record<string, unknown>) => void) | null = null
      return {
        postMessage(message: Record<string, unknown>) {
          sentByPort[index].push(message)
          queueMicrotask(() => {
            const base = bridgeResponseBase(message)
            if (message.type === 'pair') {
              deliver?.({
                ...base,
                sessionId: 'session-1',
                pairingToken: 'token-1',
                browserTaskId: 'bt-1',
                runId: 'run-1',
                state: 'paired',
              })
            } else if (message.type === 'attach') {
              deliver?.({ ...base, browserTaskId: 'bt-1', runId: 'run-1', state: 'attached' })
            } else {
              deliver?.(base)
            }
          })
        },
        disconnect: vi.fn(),
        onMessage: {
          addListener: (fn: typeof deliver) => {
            deliver = fn
            deliverByPort[index] = fn
          },
        },
        onDisconnect: {
          addListener: (fn: () => void) => {
            if (index === 0) firstDisconnect = fn
          },
        },
      }
    }

    const ports = [makePort(0), makePort(1)]
    const connectNative = vi.fn(() => ports.shift()!)
    let observationVersion = 100
    const executeScript = vi.fn(async (input: { args?: unknown[] }) => {
      if (input.args?.length === 1 && typeof input.args[0] === 'object') {
        return [{
          result: {
            text: `snapshot-${observationVersion}`,
            tables: [],
            source: { url: 'https://my.calltouch.ru/accounts', title: 'Calltouch' },
            controls: [{
              elementRef: 'button:Сохранить:0',
              role: 'button',
              label: 'Сохранить',
              observationVersion,
            }],
            observationVersion,
          },
        }]
      }
      return [{ result: { ok: true, finalUrl: 'https://my.calltouch.ru/accounts' } }]
    })

    vi.stubGlobal('chrome', {
      runtime: {
        id: 'jbhddmgcngdchlgmilphmbbcccfigadb',
        lastError: null,
        connectNative,
        sendMessage: vi.fn(async () => ({})),
        onMessage: { addListener: vi.fn() },
      },
      storage: {
        local: {
          get: vi.fn(async () => ({ verstakSessionId: 'session-1', verstakPairingToken: 'token-1' })),
          set: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
        },
      },
      sidePanel: { open: vi.fn(async () => {}) },
      action: { onClicked: { addListener: (fn: typeof actionListener) => { actionListener = fn } } },
      tabs: {
        query: vi.fn(),
        get: vi.fn(async () => ({
          id: 42,
          active: true,
          url: 'https://my.calltouch.ru/accounts',
          title: 'Calltouch',
        })),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
      scripting: { executeScript },
    })

    await import(`${BACKGROUND_URL}?same-tab-reconnect=${Date.now()}`)
    await vi.waitFor(() => expect(sentByPort[0].some((message) => message.type === 'pair')).toBe(true))
    await vi.waitFor(() => expect(actionListener).toBeTypeOf('function'))
    const clickToolbar = actionListener as unknown as ActionListener
    clickToolbar({ id: 42, url: 'https://my.calltouch.ru/accounts', title: 'Calltouch' })
    await vi.waitFor(() => expect(sentByPort[0].some((message) => message.type === 'attach')).toBe(true))

    const deliverFirst = deliverByPort[0] as unknown as (message: Record<string, unknown>) => void
    deliverFirst({
      type: 'observe_request',
      requestId: 'observe-old',
      browserTaskId: 'bt-1',
      runId: 'run-1',
      tabRef: 'tab-42',
    })
    await vi.waitFor(() => expect(sentByPort[0].some((message) => (
      message.type === 'observe' && message.requestId === 'observe-old'
    ))).toBe(true))

    expect(firstDisconnect).toBeTypeOf('function')
    ;(firstDisconnect as unknown as () => void)()
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.waitFor(() => expect(sentByPort[1].some((message) => message.type === 'pair')).toBe(true))
    clickToolbar({ id: 42, url: 'https://my.calltouch.ru/accounts', title: 'Calltouch' })
    await vi.waitFor(() => expect(sentByPort[1].some((message) => message.type === 'attach')).toBe(true))

    const deliverSecond = deliverByPort[1] as unknown as (message: Record<string, unknown>) => void
    deliverSecond({
      type: 'click_request',
      requestId: 'click-stale',
      browserTaskId: 'bt-1',
      runId: 'run-1',
      tabRef: 'tab-42',
      elementRef: 'button:Сохранить:0',
      observationVersion: 100,
      origin: 'https://my.calltouch.ru',
    })
    await vi.waitFor(() => expect(sentByPort[1].find((message) => (
      message.type === 'click' && message.requestId === 'click-stale'
    ))).toMatchObject({ ok: false }))
    expect(executeScript.mock.calls.filter(([input]) => input.args?.length === 2)).toHaveLength(0)

    observationVersion = 200
    deliverSecond({
      type: 'observe_request',
      requestId: 'observe-fresh',
      browserTaskId: 'bt-1',
      runId: 'run-1',
      tabRef: 'tab-42',
    })
    await vi.waitFor(() => expect(sentByPort[1].some((message) => (
      message.type === 'observe' && message.requestId === 'observe-fresh'
    ))).toBe(true))
    deliverSecond({
      type: 'click_request',
      requestId: 'click-fresh',
      browserTaskId: 'bt-1',
      runId: 'run-1',
      tabRef: 'tab-42',
      elementRef: 'button:Сохранить:0',
      observationVersion: 200,
      origin: 'https://my.calltouch.ru',
    })
    await vi.waitFor(() => expect(sentByPort[1].find((message) => (
      message.type === 'click' && message.requestId === 'click-fresh'
    ))).toMatchObject({ ok: true }))
    expect(executeScript.mock.calls.filter(([input]) => input.args?.length === 2)).toHaveLength(1)
  })

  it('переход на новый origin вне user gesture не запрашивает Chrome permission и останавливается честно', async () => {
    type ActionListener = (tab: Record<string, unknown>) => void
    let actionListener: ActionListener | null = null
    let deliver: ((message: Record<string, unknown>) => void) | null = null
    const sent: Array<Record<string, unknown>> = []
    const requestPermission = vi.fn(async () => true)
    const containsPermission = vi.fn(async () => false)
    let currentUrl = 'https://my.calltouch.ru/accounts'
    const updateTab = vi.fn(async (_tabId: number, update: { url?: string }) => {
      if (update.url) currentUrl = update.url
      return {}
    })
    const port = {
      postMessage(message: Record<string, unknown>) {
        sent.push(message)
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
      onMessage: { addListener: (fn: typeof deliver) => { deliver = fn } },
      onDisconnect: { addListener: vi.fn() },
    }
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'jbhddmgcngdchlgmilphmbbcccfigadb',
        lastError: null,
        connectNative: () => port,
        sendMessage: vi.fn(async () => ({})),
        onMessage: { addListener: vi.fn() },
      },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) } },
      sidePanel: { open: vi.fn(async () => {}) },
      action: { onClicked: { addListener: (fn: typeof actionListener) => { actionListener = fn } } },
      tabs: {
        query: vi.fn(),
        get: vi.fn(async () => ({ id: 42, url: currentUrl, title: 'Calltouch' })),
        update: updateTab,
        onUpdated: {
          addListener: vi.fn((fn) => queueMicrotask(() => fn(42, { status: 'complete' }, {}))),
          removeListener: vi.fn(),
        },
      },
      permissions: { contains: containsPermission, request: requestPermission },
      scripting: { executeScript: vi.fn() },
    })

    await import(`${BACKGROUND_URL}?cross-origin=${Date.now()}`)
    await vi.waitFor(() => expect(actionListener).toBeTypeOf('function'))
    const onActionClick = actionListener as unknown as ActionListener
    onActionClick({ id: 42, url: 'https://my.calltouch.ru/accounts', title: 'Calltouch' })
    await vi.waitFor(() => expect(sent.some((message) => message.type === 'attach')).toBe(true))

    const sendNativeMessage = deliver as unknown as (message: Record<string, unknown>) => void
    sendNativeMessage({
      type: 'navigate_request',
      requestId: 'navigate-1',
      browserTaskId: 'bt-1',
      runId: 'run-1',
      tabRef: 'tab-42',
      url: 'https://example.com/other',
    })

    await vi.waitFor(() => expect(sent.some((message) => message.type === 'navigate')).toBe(true))
    const result = sent.find((message) => message.type === 'navigate')
    expect(result?.requestId).toBe('navigate-1')
    expect(result?.ok).toBe(false)
    expect(result?.error).toMatch(/новый сайт|значок Verstak|доступ/i)
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(containsPermission).toHaveBeenCalledWith({ origins: ['https://example.com/*'] })
    expect(updateTab).not.toHaveBeenCalled()

    sendNativeMessage({
      type: 'navigate_request',
      requestId: 'navigate-2',
      browserTaskId: 'bt-1',
      runId: 'run-1',
      tabRef: 'tab-42',
      url: 'https://my.calltouch.ru/reports',
    })
    await vi.waitFor(() => expect(sent.filter((message) => message.type === 'navigate')).toHaveLength(2))
    const sameOriginResult = sent.filter((message) => message.type === 'navigate').at(-1)
    expect(sameOriginResult?.requestId).toBe('navigate-2')
    expect(sameOriginResult?.ok).toBe(true)
    expect(updateTab).toHaveBeenCalledWith(42, { url: 'https://my.calltouch.ru/reports' })
    expect(requestPermission).toHaveBeenCalledTimes(1)
  })

  it('все desktop action responses сохраняют requestId, а capture failure не маскируется snapshot', async () => {
    type ActionListener = (tab: Record<string, unknown>) => void
    let actionListener: ActionListener | null = null
    let deliver: ((message: Record<string, unknown>) => void) | null = null
    const sent: Array<Record<string, unknown>> = []
    let currentUrl = 'https://example.com/start'
    let failCapture = false
    const executeScript = vi.fn(async () => {
      if (failCapture) throw new Error('capture permission denied')
      return [{
        result: {
          ok: true,
          finalUrl: currentUrl,
          text: 'PAGE_TEXT',
          tables: [],
          source: { url: currentUrl, title: 'Example' },
          omissions: [],
          truncated: {},
          controls: [],
          observationVersion: 1,
        },
      }]
    })
    const port = {
      postMessage(message: Record<string, unknown>) {
        sent.push(message)
        queueMicrotask(() => {
          const base = bridgeResponseBase(message)
          if (message.type === 'pair') {
            deliver?.({ ...base, sessionId: 'session-correlation', pairingToken: 'token-correlation', state: 'paired' })
          } else if (message.type === 'attach') {
            deliver?.({ ...base, browserTaskId: 'bt-correlation', runId: 'run-correlation', state: 'attached' })
          } else {
            deliver?.(base)
          }
        })
      },
      disconnect: vi.fn(),
      onMessage: { addListener: (fn: typeof deliver) => { deliver = fn } },
      onDisconnect: { addListener: vi.fn() },
    }
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'jbhddmgcngdchlgmilphmbbcccfigadb',
        lastError: null,
        connectNative: () => port,
        sendMessage: vi.fn(async () => ({})),
        onMessage: { addListener: vi.fn() },
      },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) } },
      sidePanel: { open: vi.fn(async () => {}) },
      action: { onClicked: { addListener: (fn: typeof actionListener) => { actionListener = fn } } },
      tabs: {
        query: vi.fn(),
        get: vi.fn(async () => ({ id: 42, url: currentUrl, title: 'Example' })),
        update: vi.fn(async (_tabId: number, update: { url?: string }) => {
          if (update.url) currentUrl = update.url
          return {}
        }),
        onUpdated: {
          addListener: vi.fn((fn) => queueMicrotask(() => fn(42, { status: 'complete' }, {}))),
          removeListener: vi.fn(),
        },
      },
      permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
      scripting: { executeScript },
    })

    await import(`${BACKGROUND_URL}?all-correlation=${Date.now()}`)
    await vi.waitFor(() => expect(actionListener).toBeTypeOf('function'))
    const onActionClick = actionListener as unknown as ActionListener
    onActionClick({ id: 42, url: currentUrl, title: 'Example' })
    await vi.waitFor(() => expect(sent.some((message) => message.type === 'attach')).toBe(true))

    const requests: Array<[string, string, Record<string, unknown>]> = [
      ['observe_request', 'observe', {}],
      ['click_request', 'click', { elementRef: 'button:Save:0', observationVersion: 1 }],
      ['navigate_request', 'navigate', { url: 'https://example.com/next' }],
      ['scroll_request', 'scroll', { delta: { y: 100 } }],
      ['focus_request', 'focus', { elementRef: 'input:Name:0', observationVersion: 1 }],
      ['select_option_request', 'select_option', { elementRef: 'select:Role:0', observationVersion: 1, value: 'admin' }],
      ['wait_for_request', 'wait_for', { condition: { text: 'PAGE_TEXT', timeoutMs: 100 } }],
      ['type_text_request', 'type_text', { elementRef: 'input:Name:0', observationVersion: 1, text: 'Pavel' }],
      ['clear_field_request', 'clear_field', { elementRef: 'input:Name:0', observationVersion: 1 }],
      ['toggle_request', 'toggle', { elementRef: 'checkbox:Agree:0', observationVersion: 1 }],
      ['press_key_request', 'press_key', { elementRef: 'input:Name:0', observationVersion: 1, key: 'Enter' }],
    ]
    const sendNativeMessage = deliver as unknown as (message: Record<string, unknown>) => void
    for (const [requestType, resultType, extra] of requests) {
      const requestId = `exact-${resultType}`
      sendNativeMessage({
        type: requestType,
        requestId,
        browserTaskId: 'bt-correlation',
        runId: 'run-correlation',
        tabRef: 'tab-42',
        ...extra,
      })
      await vi.waitFor(() => expect(sent.some((message) => (
        message.type === resultType && message.requestId === requestId
      ))).toBe(true))
    }

    failCapture = true
    sendNativeMessage({
      type: 'observe_request',
      requestId: 'exact-observe-failure',
      browserTaskId: 'bt-correlation',
      runId: 'run-correlation',
      tabRef: 'tab-42',
    })
    await vi.waitFor(() => expect(sent.some((message) => (
      message.type === 'observe' && message.requestId === 'exact-observe-failure'
    ))).toBe(true))
    const failedObserve = sent.find((message) => message.requestId === 'exact-observe-failure')
    expect(failedObserve).toMatchObject({ type: 'observe', ok: false, error: 'capture permission denied' })
    expect(failedObserve?.snapshot).toBeUndefined()
  })
})
