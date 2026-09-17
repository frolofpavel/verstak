import { afterEach, describe, expect, it } from 'vitest'
import { createConnection } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BROWSER_EXTENSION_VERSION,
  BRIDGE_PROTOCOL_VERSION,
  EXTENSION_ID,
  NativeFrameDecoder,
  createBridgeServer,
  encodeNativeFrame,
  type BridgeOutbound,
  type BridgeServer,
} from '../../../electron/ai/browser/bridge'

const APP_VERSION = '9.8.7'
let dir = ''
let server: BridgeServer | null = null

afterEach(async () => {
  try { await server?.stop() } catch { /* ignore */ }
  server = null
  if (dir) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  dir = ''
})

async function requestHello(
  hostVersion: string,
  extensionVersion: string = BROWSER_EXTENSION_VERSION,
): Promise<BridgeOutbound> {
  dir = mkdtempSync(join(tmpdir(), 'verstak-bridge-version-'))
  server = createBridgeServer({
    stateDir: dir,
    appVersion: APP_VERSION,
    getActiveBrowserTaskId: () => null,
    getActiveRunId: () => null,
  })
  const endpoint = await server.start()
  const socket = createConnection(endpoint)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const decoder = new NativeFrameDecoder()
  const response = new Promise<BridgeOutbound>((resolve) => {
    socket.on('data', (chunk) => {
      for (const frame of decoder.push(Buffer.from(chunk))) {
        if (frame.ok) resolve(JSON.parse(frame.json) as BridgeOutbound)
      }
    })
  })
  socket.write(encodeNativeFrame(JSON.stringify({
    v: BRIDGE_PROTOCOL_VERSION,
    type: 'hello',
    requestId: 'version-hello',
    client: 'chrome-extension',
    extensionId: EXTENSION_ID,
    extensionVersion,
    hostVersion,
  })))
  const result = await response
  socket.destroy()
  return result
}

describe('Browser Employee version handshake', () => {
  it('returns the exact app/extension/host/protocol triplet on a compatible hello', async () => {
    const response = await requestHello(APP_VERSION)
    expect(response).toMatchObject({
      type: 'hello',
      ok: true,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      appVersion: APP_VERSION,
      extensionVersion: BROWSER_EXTENSION_VERSION,
      hostVersion: APP_VERSION,
    })
  })

  it('fails closed with one stable reason when the native host is stale', async () => {
    const response = await requestHello('9.8.6')
    const expectedReason = `Browser Employee несовместим: app=${APP_VERSION}, extension=${BROWSER_EXTENSION_VERSION}, host=9.8.6, protocol=${BRIDGE_PROTOCOL_VERSION}`
    expect(response).toMatchObject({
      type: 'error',
      code: 'version_incompatible',
    })
    expect('message' in response ? response.message : '').toBe(expectedReason)
    expect(server?.getPublicState()).toMatchObject({
      ui: 'error',
      lastError: expectedReason,
    })
    expect(server?.isExtensionAuthenticated()).toBe(false)
  })

  it('fails closed before authentication when the extension runtime is stale', async () => {
    const response = await requestHello(APP_VERSION, '0.1.9')
    const expectedReason = `Browser Employee несовместим: app=${APP_VERSION}, extension=0.1.9, host=${APP_VERSION}, protocol=${BRIDGE_PROTOCOL_VERSION}`
    expect(response).toMatchObject({
      type: 'error',
      code: 'version_incompatible',
    })
    expect('message' in response ? response.message : '').toBe(expectedReason)
    expect(server?.getPublicState()).toMatchObject({
      ui: 'error',
      lastError: expectedReason,
    })
    expect(server?.isExtensionAuthenticated()).toBe(false)
  })
})
