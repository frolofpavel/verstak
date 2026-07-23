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
  EXTENSION_ID,
  type BridgeServer,
  type BridgeOutbound,
} from '../../../electron/ai/browser/bridge'

let dir: string
let server: BridgeServer
let activeBt = 'bt-lineage-1'
let activeRun = 'run-lineage-1'
const attaches: Array<{ bt: string; tabRef: string }> = []
const taskPrompts: string[] = []

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'verstak-bridge-srv-'))
  attaches.length = 0
  taskPrompts.length = 0
  activeBt = 'bt-lineage-1'
  activeRun = 'run-lineage-1'
  server = createBridgeServer({
    stateDir: dir,
    getActiveBrowserTaskId: () => activeBt,
    getActiveRunId: () => activeRun,
    onAttach: (bt, tab) => attaches.push({ bt, tabRef: tab.tabRef }),
    onTaskSubmit: async (prompt) => {
      taskPrompts.push(prompt)
      return { sendId: 7, browserTaskId: 'bt-chat-1', chatId: 1 }
    },
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
  return {
    sessionId: pair.sessionId as string,
    pairingToken: pair.pairingToken as string,
  }
}

describe('bridge server — security fail-closed', () => {
  it('task_submit before pair is rejected and never reaches Verstak', async () => {
    const c = await connectClient()
    await helloOk(c)
    c.send({ v: BRIDGE_PROTOCOL_VERSION, type: 'task_submit', requestId: 't0', prompt: 'нажми кнопку' })
    const res = await c.next()
    expect(res.type).toBe('error')
    expect(taskPrompts).toEqual([])
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

  it('empty first pair → reject', async () => {
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
    // No credentials on new socket → empty pair reject
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
