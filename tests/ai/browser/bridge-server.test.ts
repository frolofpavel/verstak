// bridge-server.test.ts — fail-closed pair/attach/observe lineage (EXT-B1-R1).
// Socket client emulates Native Messaging host relay.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createConnection, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createBridgeServer,
  encodeNativeFrame,
  NativeFrameDecoder,
  BRIDGE_PROTOCOL_VERSION,
  BROWSER_EXTENSION_VERSION,
  EXTENSION_ID,
  type BridgeServer,
  type BridgeOutbound,
} from '../../../electron/ai/browser/bridge'
import { UnknownBrowserEffectError } from '../../../electron/ai/browser/errors'

let dir: string
let server: BridgeServer
let activeBt = 'bt-lineage-1'
let activeRun = 'run-lineage-1'
const attaches: Array<{ bt: string; tabRef: string }> = []
const taskPrompts: string[] = []
const runtimeLogs: Array<{ event: string; detail?: Record<string, unknown> }> = []
const TEST_APP_VERSION = '2.8.2'

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'verstak-bridge-srv-'))
  attaches.length = 0
  taskPrompts.length = 0
  runtimeLogs.length = 0
  activeBt = 'bt-lineage-1'
  activeRun = 'run-lineage-1'
  server = createBridgeServer({
    stateDir: dir,
    appVersion: TEST_APP_VERSION,
    getActiveBrowserTaskId: () => activeBt,
    getActiveRunId: () => activeRun,
    onAttach: (bt, tab) => attaches.push({ bt, tabRef: tab.tabRef }),
    onTaskSubmit: async (prompt) => {
      taskPrompts.push(prompt)
      return { sendId: 7, browserTaskId: 'bt-chat-1', chatId: 1 }
    },
    log: (event, detail) => runtimeLogs.push({ event, detail }),
    observeTimeoutMs: 3000,
  })
  await server.start()
})

afterEach(async () => {
  try { await server.stop() } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

async function connectClient(): Promise<{
  sock: Socket
  send: (obj: Record<string, unknown>) => void
  next: () => Promise<BridgeOutbound>
  close: () => void
}> {
  const endpoint = server.getEndpointPath()
  expect(endpoint).toBeTruthy()
  const sock = createConnection(endpoint!)
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', () => resolve())
    sock.once('error', reject)
  })
  const dec = new NativeFrameDecoder()
  const queue: BridgeOutbound[] = []
  const waiters: Array<(m: BridgeOutbound) => void> = []
  sock.on('data', (chunk: Buffer) => {
    for (const f of dec.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
      if (!f.ok) continue
      const msg = JSON.parse(f.json) as BridgeOutbound
      if (waiters.length) waiters.shift()!(msg)
      else queue.push(msg)
    }
  })
  return {
    sock,
    send(obj) {
      sock.write(encodeNativeFrame(JSON.stringify(obj)))
    },
    next() {
      if (queue.length) return Promise.resolve(queue.shift()!)
      return new Promise((resolve) => waiters.push(resolve))
    },
    close() {
      try { sock.destroy() } catch { /* ignore */ }
    },
  }
}

async function helloOk(c: Awaited<ReturnType<typeof connectClient>>): Promise<void> {
  c.send({
    v: BRIDGE_PROTOCOL_VERSION,
    type: 'hello',
    requestId: 'h1',
    client: 'chrome-extension',
    extensionId: EXTENSION_ID,
    extensionVersion: BROWSER_EXTENSION_VERSION,
    hostVersion: TEST_APP_VERSION,
  })
  const hello = await c.next()
  expect(hello.type).toBe('hello')
}

/** First pair via bootstrap code issued by desktop. Returns durable credentials. */
async function pairWithBootstrap(
  c: Awaited<ReturnType<typeof connectClient>>,
): Promise<{ sessionId: string; pairingToken: string }> {
  await helloOk(c)
  const boot = server.issuePairingCode()
  c.send({
    v: BRIDGE_PROTOCOL_VERSION,
    type: 'pair',
    requestId: 'p1',
    pairingToken: boot.code,
  })
  const pair = await c.next()
  expect(pair.type).toBe('pair')
  if (pair.type !== 'pair' || !('ok' in pair) || !pair.ok) {
    throw new Error(`pair failed: ${JSON.stringify(pair)}`)
  }
  expect(pair.sessionId).toBeTruthy()
  expect(pair.pairingToken).toBeTruthy()
  const logged = JSON.stringify(runtimeLogs)
  expect(logged).not.toContain(String(pair.sessionId))
  expect(logged).not.toContain(String(pair.pairingToken))
  return {
    sessionId: pair.sessionId as string,
    pairingToken: pair.pairingToken as string,
  }
}

function markFresh(tabRef: string, observationVersion = 1): void {
  const state = server.getSession().getState()
  expect(server.getSession().markFreshObservation({
    connectionGeneration: state.connectionGeneration,
    attachEpoch: state.attachEpoch,
    browserTaskId: activeBt,
    runId: activeRun,
    tabRef,
    observationVersion,
  })).toBe(true)
}

describe('bridge server — security fail-closed', () => {
  it.each(['timeout', 'disconnect', 'reattach'] as const)('read-only wait_for %s is a definite ordinary error', async loss => {
    const c = await connectClient()
    await pairWithBootstrap(c)
    const tab = { tabRef: 'tab-wait-loss', url: 'https://example.com/', title: 'fixture', origin: 'https://example.com' }
    c.send({ v: BRIDGE_PROTOCOL_VERSION, type: 'attach', requestId: 'attach-wait-loss', tab })
    expect(await c.next()).toMatchObject({ type: 'attach', ok: true })
    const common = { browserTaskId: activeBt, runId: activeRun, tabRef: tab.tabRef }
    const observing = server.requestObserve({ ...common, timeoutMs: 2000 })
    const observeRequest = await c.next()
    c.send({
      v: BRIDGE_PROTOCOL_VERSION, type: 'observe', requestId: observeRequest.requestId,
      ...common, ok: true,
      snapshot: { text: 'waiting', tables: [], observationVersion: 1, source: tab },
    })
    await observing
    expect(await c.next()).toMatchObject({ type: 'observe', ok: true })
    const outcome = server.requestWaitFor({
      ...common, condition: { text: 'ready' }, timeoutMs: loss === 'timeout' ? 1 : 3000,
    }).catch((error: unknown) => error)
    expect((await c.next()).type).toBe('wait_for_request')
    if (loss === 'disconnect') c.close()
    if (loss === 'reattach') {
      c.send({ v: BRIDGE_PROTOCOL_VERSION, type: 'attach', requestId: 'reattach-wait-loss', tab })
      expect(await c.next()).toMatchObject({ type: 'attach', ok: true })
    }
    const error = await outcome
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(UnknownBrowserEffectError)
    expect(error).not.toHaveProperty('code', 'BROWSER_EFFECT_UNKNOWN')
    c.close()
  })

  const effectfulActions = ['click', 'navigate', 'scroll', 'focus', 'select_option',
    'type_text', 'clear_field', 'toggle', 'press_key'] as const
  const effectLossCases = effectfulActions.flatMap(action => (
    (['timeout', 'disconnect'] as const).map(loss => ({ action, loss }))
  ))

  it.each(effectLossCases)('$action dispatch followed by $loss retains typed unknown-effect', async ({ action, loss }) => {
    const c = await connectClient()
    await pairWithBootstrap(c)
    const tabRef = 'tab-effect-loss'
    const common = { browserTaskId: activeBt, runId: activeRun, tabRef }
    c.send({
      v: BRIDGE_PROTOCOL_VERSION, type: 'attach', requestId: 'attach-effect-loss',
      tab: { tabRef, url: 'https://example.com/', title: 'fixture', origin: 'https://example.com' },
    })
    expect(await c.next()).toMatchObject({ type: 'attach', ok: true })
    // Freshness comes through the actual request/response protocol, not through
    // a direct mutation of the session store.
    const observing = server.requestObserve({ ...common, timeoutMs: 2000 })
    const observeRequest = await c.next()
    expect(observeRequest.type).toBe('observe_request')
    c.send({
      v: BRIDGE_PROTOCOL_VERSION, type: 'observe', requestId: observeRequest.requestId,
      ...common, ok: true,
      snapshot: {
        text: 'ready', tables: [], observationVersion: 1,
        source: { url: 'https://example.com/', title: 'fixture', origin: 'https://example.com' },
        controls: [
          { elementRef: 'button:Save:0', role: 'button', label: 'Save', observationVersion: 1 },
          { elementRef: 'input:Name:0', role: 'textbox', label: 'Name', observationVersion: 1 },
          { elementRef: 'select:Role:0', role: 'combobox', label: 'Role', observationVersion: 1 },
          { elementRef: 'checkbox:Agree:0', role: 'checkbox', label: 'Agree', observationVersion: 1 },
        ],
      },
    })
    await observing
    expect(await c.next()).toMatchObject({ type: 'observe', ok: true })
    const input = { ...common, timeoutMs: loss === 'timeout' ? 40 : 2000 }
    const element = { ...input, elementRef: 'input:Name:0', observationVersion: 1 }
    const starters: Record<typeof action, () => Promise<unknown>> = {
      click: () => server.requestClick({ ...element, elementRef: 'button:Save:0', origin: 'https://example.com' }),
      navigate: () => server.requestNavigate({ ...input, url: 'https://example.com/next' }),
      scroll: () => server.requestScroll({ ...input, delta: { y: 50 } }),
      focus: () => server.requestFocus(element),
      select_option: () => server.requestSelectOption({ ...element, elementRef: 'select:Role:0', value: 'selected' }),
      type_text: () => server.requestTypeText({ ...element, text: 'fixture' }),
      clear_field: () => server.requestClearField(element),
      toggle: () => server.requestToggle({ ...element, elementRef: 'checkbox:Agree:0' }),
      press_key: () => server.requestPressKey({ ...element, key: 'Enter' }),
    }
    const outcome = starters[action]().catch((error: unknown) => error)
    const request = await c.next()
    expect(request.type).toBe(`${action}_request`)
    if (loss === 'disconnect') c.close()
    const error = await outcome
    expect(error).toBeInstanceOf(UnknownBrowserEffectError)
    expect(error).toMatchObject({ code: 'BROWSER_EFFECT_UNKNOWN', effectReason: loss })
    c.close()
  })

  it('offline action ведёт в Settings без технического bridge-текста', async () => {
    const pending = server.requestObserve({
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-42',
    })

    await expect(pending).rejects.toThrow(/Настройки.*Интеграции.*Браузер/i)
    await expect(pending).rejects.not.toThrow(/chrome-extension|bridge offline/i)
  })

  it('task_submit before pair is rejected and never reaches Verstak', async () => {
    const c = await connectClient()
    await helloOk(c)
    c.send({ v: BRIDGE_PROTOCOL_VERSION, type: 'task_submit', requestId: 't0', prompt: 'нажми кнопку' })
    const res = await c.next()
    expect(res.type).toBe('error')
    expect(taskPrompts).toEqual([])
    c.close()
  })

  it('unauthenticated action ведёт в Settings, а не в удалённый ручной pair/attach flow', async () => {
    const c = await connectClient()
    await helloOk(c)
    const pending = server.requestObserve({
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-42',
    })

    await expect(pending).rejects.toThrow(/Настройки.*Интеграции.*Браузер/i)
    await expect(pending).rejects.not.toThrow(/pair|side panel|attach/i)
    c.close()
  })

  it('без выбранной вкладки просит нажать значок Verstak, а не выполнять ручной Attach', async () => {
    const c = await connectClient()
    await pairWithBootstrap(c)
    const pending = server.requestObserve({
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: '',
    })

    await expect(pending).rejects.toThrow(/значок Verstak/i)
    await expect(pending).rejects.not.toThrow(/attach|side panel/i)
    c.close()
  })

  it('paired task_submit invokes desktop task hook once', async () => {
    const c = await connectClient()
    await pairWithBootstrap(c)
    c.send({ v: BRIDGE_PROTOCOL_VERSION, type: 'task_submit', requestId: 't1', prompt: 'нажми кнопку' })
    const res = await c.next()
    expect(res.type).toBe('task_submit')
    if (res.type === 'task_submit') expect(res.sendId).toBe(7)
    expect(taskPrompts).toEqual(['нажми кнопку'])
    c.close()
  })

  it('disconnect send#1 изолирует поздний response/events от reconnect send#2 и отменяет #1', async () => {
    await server.stop()
    const cancels: number[] = []
    let startFirst!: () => void
    let startSecond!: () => void
    let resolveFirst!: (value: { sendId: number; browserTaskId: string; chatId: number }) => void
    let resolveSecond!: (value: { sendId: number; browserTaskId: string; chatId: number }) => void
    const firstStarted = new Promise<void>((resolve) => { startFirst = resolve })
    const secondStarted = new Promise<void>((resolve) => { startSecond = resolve })
    const firstResult = new Promise<{ sendId: number; browserTaskId: string; chatId: number }>((resolve) => {
      resolveFirst = resolve
    })
    const secondResult = new Promise<{ sendId: number; browserTaskId: string; chatId: number }>((resolve) => {
      resolveSecond = resolve
    })
    server = createBridgeServer({
      stateDir: dir,
      appVersion: TEST_APP_VERSION,
      getActiveBrowserTaskId: () => activeBt,
      getActiveRunId: () => activeRun,
      onTaskSubmit: (prompt) => {
        if (prompt === 'send one') {
          startFirst()
          return firstResult
        }
        startSecond()
        return secondResult
      },
      onTaskCancel: (sendId) => { cancels.push(sendId) },
      observeTimeoutMs: 3000,
    })
    await server.start()

    const c1 = await connectClient()
    const creds = await pairWithBootstrap(c1)
    c1.send({ v: BRIDGE_PROTOCOL_VERSION, type: 'task_submit', requestId: 't-one', prompt: 'send one' })
    await firstStarted
    c1.close()
    await new Promise((resolve) => setTimeout(resolve, 50))

    const c2 = await connectClient()
    await helloOk(c2)
    c2.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'pair',
      requestId: 'p-reconnect',
      sessionId: creds.sessionId,
      pairingToken: creds.pairingToken,
    })
    const paired = await c2.next()
    expect(paired.type).toBe('pair')
    c2.send({ v: BRIDGE_PROTOCOL_VERSION, type: 'task_submit', requestId: 't-two', prompt: 'send two' })
    await secondStarted

    resolveSecond({ sendId: 72, browserTaskId: 'bt-chat-2', chatId: 2 })
    const secondAck = await c2.next()
    expect(secondAck.type).toBe('task_submit')
    if (secondAck.type === 'task_submit') {
      expect(secondAck.requestId).toBe('t-two')
      expect(secondAck.sendId).toBe(72)
    }

    resolveFirst({ sendId: 71, browserTaskId: 'bt-chat-1', chatId: 1 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cancels).toEqual([71])

    server.pushTaskEvent({
      requestId: 'task-71',
      sendId: 71,
      event: { type: 'pending-browser-action', actionId: 'stale-action' },
    })
    server.pushTaskEvent({ requestId: 'task-71', sendId: 71, event: { type: 'done' } })
    server.pushTaskEvent({ requestId: 'task-72', sendId: 72, event: { type: 'text', text: 'fresh' } })
    const fresh = await c2.next()
    expect(fresh.type).toBe('task_event')
    if (fresh.type === 'task_event') {
      expect(fresh.sendId).toBe(72)
      expect(fresh.event).toEqual({ type: 'text', text: 'fresh' })
    }
    c2.close()
  })

  it('hello rejects missing extensionId', async () => {
    const c = await connectClient()
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'hello',
      requestId: 'h1',
      client: 'chrome-extension',
    })
    const res = await c.next()
    expect(res.type).toBe('error')
    if (res.type === 'error') expect(res.code).toBe('forbidden_extension')
    c.close()
  })

  it('hello rejects foreign extension id', async () => {
    const c = await connectClient()
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'hello',
      requestId: 'h1',
      client: 'chrome-extension',
      extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
    const res = await c.next()
    expect(res.type).toBe('error')
    if (res.type === 'error') expect(res.code).toBe('forbidden_extension')
    c.close()
  })

  it('empty first pair after allowlisted hello is rejected while Settings window is closed', async () => {
    const c = await connectClient()
    await helloOk(c)
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'pair',
      requestId: 'p1',
    })
    const res = await c.next()
    expect(res.type).toBe('error')
    if (res.type === 'error') expect(res.code).toBe('pair_rejected')
    expect(server.isExtensionAuthenticated()).toBe(false)
    c.close()
  })

  it('Settings opens one-shot auto-pair window: one blank pair succeeds and the next is rejected', async () => {
    const c1 = await connectClient()
    await helloOk(c1)
    c1.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'pair',
      requestId: 'p-before-window',
    })
    const deniedBeforeSettings = await c1.next()
    expect(deniedBeforeSettings.type).toBe('error')
    expect(server.getPublicState().lastError).toBeNull()

    const { expiresAt } = server.openAutoPairWindow({ ttlMs: 60_000 })
    expect(server.getPublicState().lastError).toBeNull()
    const authAvailable = await Promise.race([
      c1.next(),
      new Promise<'timeout'>((resolveTimeout) => setTimeout(() => resolveTimeout('timeout'), 300)),
    ])
    expect(authAvailable).not.toBe('timeout')
    expect(authAvailable).toMatchObject({
      type: 'auth_available',
      expiresAt,
    })
    c1.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'pair',
      requestId: 'p-window-1',
    })
    const paired = await c1.next()
    expect(paired.type).toBe('pair')
    if (paired.type === 'pair') {
      expect(paired.ok).toBe(true)
      expect(paired.sessionId).toBeTruthy()
      expect(paired.pairingToken).toBeTruthy()
    }
    expect(server.isExtensionAuthenticated()).toBe(true)
    c1.close()
    await new Promise((resolve) => setTimeout(resolve, 50))

    const c2 = await connectClient()
    await helloOk(c2)
    c2.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'pair',
      requestId: 'p-window-2',
    })
    const rejected = await c2.next()
    expect(rejected.type).toBe('error')
    if (rejected.type === 'error') expect(rejected.code).toBe('pair_rejected')
    expect(server.isExtensionAuthenticated()).toBe(false)
    c2.close()
  })

  it('arbitrary first token → reject', async () => {
    const c = await connectClient()
    await helloOk(c)
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'pair',
      requestId: 'p1',
      pairingToken: '0'.repeat(64),
    })
    const res = await c.next()
    expect(res.type).toBe('error')
    if (res.type === 'error') expect(res.code).toBe('pair_rejected')
    expect(server.getPublicState().lastError).toMatch(/bootstrap|pairing|token/i)
    c.close()
  })

  it('attach before pair → reject', async () => {
    const c = await connectClient()
    await helloOk(c)
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'attach',
      requestId: 'a1',
      tab: {
        tabRef: 'tab-1',
        url: 'https://example.com/',
        title: 't',
        origin: 'https://example.com',
      },
    })
    const res = await c.next()
    expect(res.type).toBe('error')
    if (res.type === 'error') expect(res.code).toBe('not_paired')
    c.close()
  })

  it('status before pair does not leak lineage', async () => {
    const c = await connectClient()
    await helloOk(c)
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'status',
      requestId: 's1',
    })
    const res = await c.next()
    expect(res.type).toBe('status')
    if (res.type === 'status') {
      expect(res.sessionId).toBeNull()
      expect(res.browserTaskId).toBeNull()
      expect(res.runId).toBeNull()
      expect(res.attachedTab).toBeNull()
    }
    c.close()
  })

  it('observe before pair → reject', async () => {
    const c = await connectClient()
    await helloOk(c)
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'observe',
      requestId: 'o1',
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-1',
      snapshot: {
        text: 'x',
        tables: [],
        source: { url: 'https://example.com/', title: 't', origin: 'https://example.com' },
        omissions: [],
      },
    })
    const res = await c.next()
    expect(res.type).toBe('error')
    if (res.type === 'error') expect(res.code).toBe('not_paired')
    c.close()
  })

  it('новый socket не наследует auth старого', async () => {
    const c1 = await connectClient()
    await pairWithBootstrap(c1)
    expect(server.isExtensionAuthenticated()).toBe(true)
    c1.close()
    // Wait for server to process close
    await new Promise((r) => setTimeout(r, 50))
    expect(server.isExtensionAuthenticated()).toBe(false)

    const c2 = await connectClient()
    await helloOk(c2)
    // A new socket cannot mint credentials without a Settings authorization window.
    c2.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'pair',
      requestId: 'p2',
    })
    const res = await c2.next()
    expect(res.type).toBe('error')
    if (res.type === 'error') expect(res.code).toBe('pair_rejected')
    expect(server.isExtensionAuthenticated()).toBe(false)
    // Durable re-pair still works with stored token
    const pairing = server.getSession().loadPairing()
    expect(pairing).toBeTruthy()
    c2.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'pair',
      requestId: 'p3',
      pairingToken: pairing!.pairingToken,
      sessionId: pairing!.sessionId,
    })
    const pair2 = await c2.next()
    expect(pair2.type).toBe('pair')
    expect(server.isExtensionAuthenticated()).toBe(true)
    c2.close()
  })

  it('обрыв partial frame старого socket не повреждает протокол нового подключения', async () => {
    const c1 = await connectClient()
    c1.sock.write(Buffer.from([1, 0]))
    c1.close()
    await new Promise(resolve => setTimeout(resolve, 40))

    const c2 = await connectClient()
    c2.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'hello',
      requestId: 'hello-after-partial',
      client: 'chrome-extension',
      extensionId: EXTENSION_ID,
      extensionVersion: BROWSER_EXTENSION_VERSION,
      hostVersion: TEST_APP_VERSION,
    })
    const response = await c2.next()
    expect(response.type).toBe('hello')
    c2.close()
  })

  it('второй клиент не захватывает bridge', async () => {
    const c1 = await connectClient()
    await pairWithBootstrap(c1)
    // Second connection should be destroyed immediately
    const endpoint = server.getEndpointPath()!
    const sock2 = createConnection(endpoint)
    await new Promise<void>((resolve) => {
      sock2.once('connect', () => resolve())
      sock2.once('error', () => resolve())
    })
    await new Promise((r) => setTimeout(r, 80))
    // First client still authenticated
    expect(server.isExtensionAuthenticated()).toBe(true)
    c1.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'status',
      requestId: 's-hold',
    })
    const st = await c1.next()
    expect(st.type).toBe('status')
    if (st.type === 'status') expect(st.sessionId).toBeTruthy()
    try { sock2.destroy() } catch { /* ignore */ }
    c1.close()
  })
})

describe('bridge server — pair attach observe lineage', () => {
  it('pair → attach → observe with same browserTaskId/runId', async () => {
    const c = await connectClient()
    const creds = await pairWithBootstrap(c)
    expect(creds.sessionId).toBeTruthy()

    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'attach',
      requestId: 'a1',
      tab: {
        tabRef: 'tab-42',
        url: 'https://example.com/report',
        title: 'Report',
        origin: 'https://example.com',
      },
      browserTaskId: activeBt,
    })
    const attach = await c.next()
    expect(attach.type).toBe('attach')
    if (attach.type === 'attach' && 'ok' in attach) {
      expect(attach.ok).toBe(true)
      expect(attach.browserTaskId).toBe(activeBt)
      expect(attach.tabRef).toBe('tab-42')
      expect(attach.state).toBe('attached')
    }
    expect(attaches).toEqual([{ bt: activeBt, tabRef: 'tab-42' }])
    expect(server.getPublicState().ui).toBe('attached')

    const observePromise = server.requestObserve({
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-42',
      timeoutMs: 2000,
    })
    const req = await c.next()
    expect(req.type).toBe('observe_request')
    if (req.type === 'observe_request') {
      expect(req.browserTaskId).toBe(activeBt)
      expect(req.runId).toBe(activeRun)
      expect(req.tabRef).toBe('tab-42')
      c.send({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'observe',
        requestId: req.requestId,
        browserTaskId: activeBt,
        runId: activeRun,
        tabRef: 'tab-42',
        snapshot: {
          text: 'sum 100',
          tables: [],
          source: { url: 'https://example.com/report', title: 'Report', origin: 'https://example.com' },
          omissions: [],
        },
      })
    }
    const snap = await observePromise
    expect(snap.text).toBe('sum 100')
    expect(snap.source.url).toContain('example.com')

    const ack = await c.next()
    expect(ack.type).toBe('observe')
    if (ack.type === 'observe' && 'ok' in ack) {
      expect(ack.browserTaskId).toBe(activeBt)
      expect(ack.runId).toBe(activeRun)
    }
    c.close()
  })

  it('mismatch browserTaskId/runId/tabRef → snapshot not accepted', async () => {
    const c = await connectClient()
    await pairWithBootstrap(c)
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'attach',
      requestId: 'a1',
      tab: {
        tabRef: 'tab-42',
        url: 'https://example.com/',
        title: 't',
        origin: 'https://example.com',
      },
    })
    await c.next()

    const observePromise = server.requestObserve({
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-42',
      timeoutMs: 1500,
    })
    const req = await c.next()
    expect(req.type).toBe('observe_request')
    if (req.type === 'observe_request') {
      // Wrong lineage on purpose
      c.send({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'observe',
        requestId: req.requestId,
        browserTaskId: 'bt-FOREIGN',
        runId: activeRun,
        tabRef: 'tab-42',
        snapshot: {
          text: 'evil',
          tables: [],
          source: { url: 'https://evil.example/', title: 'x', origin: 'https://evil.example' },
          omissions: [],
        },
      })
    }
    const err = await c.next()
    expect(err.type).toBe('error')
    if (err.type === 'error') expect(err.code).toBe('lineage_mismatch')

    // Pending still open — send correct lineage
    if (req.type === 'observe_request') {
      c.send({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'observe',
        requestId: req.requestId,
        browserTaskId: activeBt,
        runId: activeRun,
        tabRef: 'tab-42',
        snapshot: {
          text: 'good',
          tables: [],
          source: { url: 'https://example.com/', title: 't', origin: 'https://example.com' },
          omissions: [],
        },
      })
    }
    const snap = await observePromise
    expect(snap.text).toBe('good')
    c.close()
  })

  it('late solicited observe reply after timeout never becomes an unsolicited fresh snapshot', async () => {
    const c = await connectClient()
    await pairWithBootstrap(c)
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'attach',
      requestId: 'a-late-observe',
      tab: {
        tabRef: 'tab-late-observe',
        url: 'https://example.com/',
        title: 't',
        origin: 'https://example.com',
      },
      browserTaskId: activeBt,
    })
    await c.next()

    const pending = server.requestObserve({
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-late-observe',
      timeoutMs: 20,
    })
    const request = await c.next()
    expect(request.type).toBe('observe_request')
    await expect(pending).rejects.toThrow(/observe timeout/i)

    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'observe',
      requestId: request.requestId,
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-late-observe',
      snapshot: {
        text: 'too late',
        tables: [],
        source: { url: 'https://example.com/', title: 't', origin: 'https://example.com' },
        omissions: [],
      },
    })

    const lateAck = await c.next()
    expect(lateAck.type).toBe('error')
    expect(server.getSession().getState().freshObservation).toBeNull()
    c.close()
  })

  it('same-tab detach and reattach rejects an observe reply from the prior attach epoch', async () => {
    const c = await connectClient()
    await pairWithBootstrap(c)
    const tab = {
      tabRef: 'tab-same-reattach',
      url: 'https://example.com/',
      title: 't',
      origin: 'https://example.com',
    }
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'attach',
      requestId: 'a-epoch-1',
      tab,
      browserTaskId: activeBt,
    })
    await c.next()

    const pending = server.requestObserve({
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: tab.tabRef,
      timeoutMs: 2000,
    })
    const oldRequest = await c.next()

    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'detach',
      requestId: 'd-epoch-1',
      browserTaskId: activeBt,
    })
    await c.next()
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'attach',
      requestId: 'a-epoch-2',
      tab,
      browserTaskId: activeBt,
    })
    await c.next()

    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'observe',
      requestId: oldRequest.requestId,
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: tab.tabRef,
      snapshot: {
        text: 'old attach epoch',
        tables: [],
        source: { url: tab.url, title: tab.title, origin: tab.origin },
        omissions: [],
      },
    })

    await expect(pending).rejects.toThrow(/attach|устарел/i)
    const staleAck = await c.next()
    expect(staleAck.type).toBe('error')
    expect(server.getSession().getState().freshObservation).toBeNull()
    c.close()
  })

  it('an unsolicited capture crossing same-tab reattach never establishes action freshness', async () => {
    const c = await connectClient()
    await pairWithBootstrap(c)
    const tab = {
      tabRef: 'tab-push-reattach',
      url: 'https://example.com/',
      title: 't',
      origin: 'https://example.com',
    }
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'attach',
      requestId: 'a-push-1',
      tab,
      browserTaskId: activeBt,
    })
    await c.next()
    // The extension-side capture begins here, before the attach identity changes.
    c.send({ v: BRIDGE_PROTOCOL_VERSION, type: 'detach', requestId: 'd-push-1', browserTaskId: activeBt })
    await c.next()
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'attach',
      requestId: 'a-push-2',
      tab,
      browserTaskId: activeBt,
    })
    await c.next()

    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'observe',
      requestId: 'extension-push-started-before-reattach',
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: tab.tabRef,
      snapshot: {
        text: 'old unsolicited capture',
        tables: [],
        source: { url: tab.url, title: tab.title, origin: tab.origin },
        omissions: [],
      },
    })

    const ack = await c.next()
    expect(ack.type).toBe('observe')
    expect(server.getSession().getState().freshObservation).toBeNull()
    c.close()
  })

  it('disconnect fails pending observe, no auto-continue', async () => {
    const c = await connectClient()
    await pairWithBootstrap(c)
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'attach',
      requestId: 'a1',
      tab: {
        tabRef: 'tab-9',
        url: 'https://example.com/',
        title: 't',
        origin: 'https://example.com',
      },
    })
    await c.next()

    const pending = server.requestObserve({
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-9',
      timeoutMs: 2000,
    })
    await c.next() // observe_request
    c.close()
    await expect(pending).rejects.toThrow(/disconnected|offline/i)

    expect(server.getSession().loadPairing()).toBeTruthy()
    expect(server.isExtensionConnected()).toBe(false)

    await server.stop()
    expect(server.getPublicState().desktopOnline).toBe(false)
  })

  it('action fail-closed без fresh observe, а новый snapshot текущей lineage открывает ровно один click', async () => {
    const c = await connectClient()
    await pairWithBootstrap(c)
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'attach',
      requestId: 'a-fresh-gate',
      tab: {
        tabRef: 'tab-fresh-gate',
        url: 'https://example.com/',
        title: 't',
        origin: 'https://example.com',
      },
    })
    await c.next()

    const clickInput = {
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-fresh-gate',
      elementRef: 'button:Save:0',
      observationVersion: 1,
      origin: 'https://example.com',
      timeoutMs: 2000,
    }
    await expect(server.requestClick(clickInput)).rejects.toThrow(/fresh observe/i)

    const observe = server.requestObserve({
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-fresh-gate',
      timeoutMs: 2000,
    })
    const observeRequest = await c.next()
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'observe',
      requestId: observeRequest.requestId,
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-fresh-gate',
      ok: true,
      snapshot: {
        text: 'Save',
        tables: [],
        source: { url: 'https://example.com/', title: 't', origin: 'https://example.com' },
        controls: [{
          elementRef: 'button:Save:0',
          role: 'button',
          label: 'Save',
          observationVersion: 1,
        }],
        observationVersion: 1,
      },
    })
    await expect(observe).resolves.toMatchObject({ observationVersion: 1 })
    expect(await c.next()).toMatchObject({ type: 'observe', requestId: observeRequest.requestId, ok: true })

    const click = server.requestClick(clickInput)
    const clickRequest = await c.next()
    expect(clickRequest).toMatchObject({ type: 'click_request', observationVersion: 1 })
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'click',
      requestId: clickRequest.requestId,
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-fresh-gate',
      elementRef: 'button:Save:0',
      observationVersion: 1,
      ok: true,
      finalUrl: 'https://example.com/',
    })
    expect(await c.next()).toMatchObject({ type: 'click', requestId: clickRequest.requestId, ok: true })
    await expect(click).resolves.toMatchObject({ ok: true })
    c.close()
  })

  it('disconnect после отправки click_request возвращает typed unknown-effect', async () => {
    const c = await connectClient()
    await pairWithBootstrap(c)
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'attach',
      requestId: 'a-click',
      tab: {
        tabRef: 'tab-click',
        url: 'https://example.com/',
        title: 't',
        origin: 'https://example.com',
      },
    })
    await c.next()
    markFresh('tab-click')

    const pending = server.requestClick({
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-click',
      elementRef: 'button:Save:0',
      observationVersion: 1,
      origin: 'https://example.com',
      timeoutMs: 2000,
    })
    const request = await c.next()
    expect(request.type).toBe('click_request')
    c.close()

    const error = await pending.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(UnknownBrowserEffectError)
    expect((error as UnknownBrowserEffectError).effectReason).toBe('disconnect')
  })

  it('same-tab reattach завершает уже отправленный action как typed unknown-effect', async () => {
    const c = await connectClient()
    await pairWithBootstrap(c)
    const tab = {
      tabRef: 'tab-reattach',
      url: 'https://example.com/',
      title: 't',
      origin: 'https://example.com',
    }
    c.send({ v: BRIDGE_PROTOCOL_VERSION, type: 'attach', requestId: 'a-reattach-1', tab })
    const firstAttach = await c.next()
    expect(firstAttach).toMatchObject({ type: 'attach', attachEpoch: 1 })
    markFresh('tab-reattach')

    const pending = server.requestClick({
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-reattach',
      elementRef: 'button:Save:0',
      observationVersion: 1,
      origin: 'https://example.com',
      timeoutMs: 2000,
    })
    const pendingResult = pending.catch((caught: unknown) => caught)
    expect(await c.next()).toMatchObject({ type: 'click_request' })

    c.send({ v: BRIDGE_PROTOCOL_VERSION, type: 'attach', requestId: 'a-reattach-2', tab })
    const secondAttach = await c.next()
    expect(secondAttach).toMatchObject({ type: 'attach', attachEpoch: 2 })
    const error = await pendingResult
    expect(error).toBeInstanceOf(UnknownBrowserEffectError)
    expect((error as UnknownBrowserEffectError).effectReason).toBe('transport')
    c.close()
  })

  it('timeout после отправки click_request возвращает typed unknown-effect', async () => {
    const c = await connectClient()
    await pairWithBootstrap(c)
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'attach',
      requestId: 'a-click-timeout',
      tab: {
        tabRef: 'tab-click-timeout',
        url: 'https://example.com/',
        title: 't',
        origin: 'https://example.com',
      },
    })
    await c.next()
    markFresh('tab-click-timeout')

    const pending = server.requestClick({
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-click-timeout',
      elementRef: 'button:Save:0',
      observationVersion: 1,
      origin: 'https://example.com',
      timeoutMs: 10,
    })
    const request = await c.next()
    expect(request.type).toBe('click_request')

    const error = await pending.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(UnknownBrowserEffectError)
    expect((error as UnknownBrowserEffectError).effectReason).toBe('timeout')
    c.close()
  })

  it('disconnect немедленно завершает pending navigate, не ждёт timeout', async () => {
    const c = await connectClient()
    await pairWithBootstrap(c)
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'attach',
      requestId: 'a-nav',
      tab: {
        tabRef: 'tab-12',
        url: 'https://example.com/',
        title: 't',
        origin: 'https://example.com',
      },
    })
    await c.next()
    markFresh('tab-12')

    const pending = server.requestNavigate({
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-12',
      url: 'https://example.com/next',
      timeoutMs: 2000,
    })
    await c.next()
    const startedAt = Date.now()
    c.close()
    const error = await pending.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(UnknownBrowserEffectError)
    expect((error as UnknownBrowserEffectError).effectReason).toBe('disconnect')
    expect(Date.now() - startedAt).toBeLessThan(1000)
  })

  it('timeout после отправки navigate_request возвращает typed unknown-effect', async () => {
    const c = await connectClient()
    await pairWithBootstrap(c)
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'attach',
      requestId: 'a-nav-timeout',
      tab: {
        tabRef: 'tab-nav-timeout',
        url: 'https://example.com/',
        title: 't',
        origin: 'https://example.com',
      },
    })
    await c.next()
    markFresh('tab-nav-timeout')

    const pending = server.requestNavigate({
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-nav-timeout',
      url: 'https://example.com/next',
      timeoutMs: 10,
    })
    const request = await c.next()
    expect(request.type).toBe('navigate_request')

    const error = await pending.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(UnknownBrowserEffectError)
    expect((error as UnknownBrowserEffectError).effectReason).toBe('timeout')
    c.close()
  })

  it('два navigate response разрешают именно pending с совпавшим requestId', async () => {
    const c = await connectClient()
    await pairWithBootstrap(c)
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'attach',
      requestId: 'a-nav-correlation',
      tab: {
        tabRef: 'tab-nav-correlation',
        url: 'https://example.com/',
        title: 't',
        origin: 'https://example.com',
      },
    })
    await c.next()
    markFresh('tab-nav-correlation')

    const first = server.requestNavigate({
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-nav-correlation',
      url: 'https://example.com/first',
      timeoutMs: 2000,
    })
    const firstRequest = await c.next()
    markFresh('tab-nav-correlation')
    const second = server.requestNavigate({
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-nav-correlation',
      url: 'https://example.com/second',
      timeoutMs: 2000,
    })
    const secondRequest = await c.next()

    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'navigate',
      requestId: String(secondRequest.requestId),
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-nav-correlation',
      ok: true,
      finalUrl: 'https://example.com/second',
      title: 'Second',
    })
    const secondAck = await c.next()
    expect(secondAck).toMatchObject({
      type: 'navigate',
      requestId: secondRequest.requestId,
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-nav-correlation',
    })
    await expect(second).resolves.toMatchObject({ finalUrl: 'https://example.com/second', title: 'Second' })

    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'navigate',
      requestId: String(firstRequest.requestId),
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-nav-correlation',
      ok: true,
      finalUrl: 'https://example.com/first',
      title: 'First',
    })
    const firstAck = await c.next()
    expect(firstAck).toMatchObject({
      type: 'navigate',
      requestId: firstRequest.requestId,
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-nav-correlation',
    })
    await expect(first).resolves.toMatchObject({ finalUrl: 'https://example.com/first', title: 'First' })
    c.close()
  })

  it('navigate response с чужим lineage не завершает pending; exact lineage получает ACK', async () => {
    const c = await connectClient()
    await pairWithBootstrap(c)
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'attach',
      requestId: 'a-nav-lineage',
      tab: {
        tabRef: 'tab-nav-lineage',
        url: 'https://example.com/',
        title: 't',
        origin: 'https://example.com',
      },
    })
    await c.next()
    markFresh('tab-nav-lineage')

    const pending = server.requestNavigate({
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-nav-lineage',
      url: 'https://example.com/right',
      timeoutMs: 2000,
    })
    const request = await c.next()
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'navigate',
      requestId: String(request.requestId),
      browserTaskId: activeBt,
      runId: 'foreign-run',
      tabRef: 'tab-nav-lineage',
      ok: true,
      finalUrl: 'https://evil.example/foreign',
      title: 'Foreign',
    })
    const rejected = await c.next()
    expect(rejected).toMatchObject({ type: 'error', requestId: request.requestId, code: 'lineage_mismatch' })

    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'navigate',
      requestId: String(request.requestId),
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-nav-lineage',
      ok: true,
      finalUrl: 'https://example.com/right',
      title: 'Right',
    })
    const ack = await c.next()
    expect(ack).toMatchObject({ type: 'navigate', requestId: request.requestId, ok: true })
    await expect(pending).resolves.toMatchObject({ finalUrl: 'https://example.com/right', title: 'Right' })
    c.close()
  })

  it('observe capture failure отклоняет pending по исходному requestId и ACK-ается', async () => {
    const c = await connectClient()
    await pairWithBootstrap(c)
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'attach',
      requestId: 'a-observe-failure',
      tab: {
        tabRef: 'tab-observe-failure',
        url: 'https://example.com/',
        title: 't',
        origin: 'https://example.com',
      },
    })
    await c.next()

    const pending = server.requestObserve({
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-observe-failure',
      timeoutMs: 2000,
    })
    const rejectedPending = pending.catch((caught: unknown) => caught)
    const request = await c.next()
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'observe',
      requestId: String(request.requestId),
      browserTaskId: activeBt,
      runId: activeRun,
      tabRef: 'tab-observe-failure',
      ok: false,
      error: 'capture permission denied',
    })

    const ack = await c.next()
    expect(ack).toMatchObject({ type: 'observe', requestId: request.requestId, ok: true })
    const error = await rejectedPending
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/capture permission denied/i)
    c.close()
  })

  it('все extension action results разрешают exact pending и получают ACK с тем же requestId', async () => {
    const c = await connectClient()
    await pairWithBootstrap(c)
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'attach',
      requestId: 'a-all-actions',
      tab: {
        tabRef: 'tab-all-actions',
        url: 'https://example.com/',
        title: 't',
        origin: 'https://example.com',
      },
    })
    await c.next()

    const common = { browserTaskId: activeBt, runId: activeRun, tabRef: 'tab-all-actions' }
    const actions: Array<{
      resultType: string
      start: () => Promise<unknown>
      result: Record<string, unknown>
    }> = [
      {
        resultType: 'click',
        start: () => server.requestClick({ ...common, elementRef: 'button:Save:0', observationVersion: 1, origin: 'https://example.com' }),
        result: { elementRef: 'button:Save:0', observationVersion: 1, finalUrl: 'https://example.com/' },
      },
      { resultType: 'scroll', start: () => server.requestScroll({ ...common, delta: { y: 100 } }), result: {} },
      { resultType: 'focus', start: () => server.requestFocus({ ...common, elementRef: 'input:Name:0', observationVersion: 1 }), result: {} },
      { resultType: 'select_option', start: () => server.requestSelectOption({ ...common, elementRef: 'select:Role:0', observationVersion: 1, value: 'admin' }), result: {} },
      { resultType: 'wait_for', start: () => server.requestWaitFor({ ...common, condition: { text: 'ready', timeoutMs: 100 } }), result: { reason: 'matched' } },
      { resultType: 'type_text', start: () => server.requestTypeText({ ...common, elementRef: 'input:Name:0', observationVersion: 1, text: 'Pavel' }), result: { elementRef: 'input:Name:0' } },
      { resultType: 'clear_field', start: () => server.requestClearField({ ...common, elementRef: 'input:Name:0', observationVersion: 1 }), result: { elementRef: 'input:Name:0' } },
      { resultType: 'toggle', start: () => server.requestToggle({ ...common, elementRef: 'checkbox:Agree:0', observationVersion: 1 }), result: { elementRef: 'checkbox:Agree:0' } },
      { resultType: 'press_key', start: () => server.requestPressKey({ ...common, elementRef: 'input:Name:0', observationVersion: 1, key: 'Enter' }), result: { elementRef: 'input:Name:0' } },
    ]

    for (const action of actions) {
      markFresh('tab-all-actions')
      const pending = action.start()
      const request = await c.next()
      expect(request.type).toBe(`${action.resultType}_request`)
      c.send({
        v: BRIDGE_PROTOCOL_VERSION,
        type: action.resultType,
        requestId: request.requestId,
        ...common,
        ok: true,
        ...action.result,
      })
      const ack = await c.next()
      expect(ack).toMatchObject({ type: action.resultType, requestId: request.requestId })
      await expect(pending).resolves.toMatchObject({ ok: true })
    }
    c.close()
  })

  it('restart recovers pairing without auto-continue attach', async () => {
    const c = await connectClient()
    const creds = await pairWithBootstrap(c)
    c.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'attach',
      requestId: 'a1',
      tab: {
        tabRef: 'tab-x',
        url: 'https://example.com/',
        title: 't',
        origin: 'https://example.com',
      },
    })
    await c.next()
    c.close()
    await server.stop()

    // New server instance = desktop restart
    server = createBridgeServer({
      stateDir: dir,
      appVersion: TEST_APP_VERSION,
      getActiveBrowserTaskId: () => activeBt,
      getActiveRunId: () => activeRun,
    })
    await server.start()
    const pairing = server.getSession().loadPairing()
    expect(pairing?.sessionId).toBe(creds.sessionId)
    expect(server.getPublicState().attachedTab).toBeNull()
    expect(server.getPublicState().ui).not.toBe('attached')
    expect(server.isExtensionAuthenticated()).toBe(false)

    const c2 = await connectClient()
    c2.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'hello',
      requestId: 'h2',
      client: 'chrome-extension',
      extensionId: EXTENSION_ID,
      extensionVersion: BROWSER_EXTENSION_VERSION,
      hostVersion: TEST_APP_VERSION,
    })
    await c2.next()
    c2.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'pair',
      requestId: 'p2',
      sessionId: creds.sessionId,
      pairingToken: creds.pairingToken,
    })
    const pair2 = await c2.next()
    expect(pair2.type).toBe('pair')
    if (pair2.type === 'pair' && 'ok' in pair2) {
      expect(pair2.ok).toBe(true)
      expect(pair2.sessionId).toBe(creds.sessionId)
      expect(pair2.state).not.toBe('attached')
    }
    c2.close()
  })
})
