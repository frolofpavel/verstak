import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, hostManifest, installNativeHost, readNativeMessagingRegistry } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  hostManifest: {
    content: JSON.stringify({
      name: 'ru.verstak.browser_bridge',
      description: 'Verstak Browser Bridge (Connected Eyes)',
      path: 'C:\\bridge\\host.cmd',
      type: 'stdio',
      allowed_origins: ['chrome-extension://jbhddmgcngdchlgmilphmbbcccfigadb/'],
    }),
  },
  installNativeHost: vi.fn(() => ({
    ok: true,
    hostName: 'ru.verstak.browser_bridge',
    manifestPath: 'C:\\bridge\\ru.verstak.browser_bridge.json',
    hostLauncherPath: 'C:\\bridge\\host.cmd',
    registryKeys: ['HKCU\\Chrome'],
  })),
  readNativeMessagingRegistry: vi.fn(() => ({
    chrome: 'C:\\bridge\\ru.verstak.browser_bridge.json',
    edge: 'C:\\bridge\\ru.verstak.browser_bridge.json',
  })),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
  },
  app: {
    isPackaged: false,
    getAppPath: () => 'C:\\project',
  },
}))

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return {
    ...original,
    existsSync: () => true,
    readFileSync: (path: Parameters<typeof original.readFileSync>[0], ...args: unknown[]) => {
      if (String(path).endsWith('ru.verstak.browser_bridge.json')) return hostManifest.content
      return (original.readFileSync as (...values: unknown[]) => unknown)(path, ...args)
    },
  }
})

vi.mock('../../electron/ai/browser/bridge/host-lifecycle', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../electron/ai/browser/bridge/host-lifecycle')>(),
  installNativeHost,
  uninstallNativeHost: vi.fn(() => ({ ok: true })),
  readNativeMessagingRegistry,
}))

import { registerBrowserBridgeIpc } from '../../electron/ipc/browser-bridge'

describe('browser bridge connect IPC', () => {
  beforeEach(() => {
    handlers.clear()
    installNativeHost.mockClear()
    readNativeMessagingRegistry.mockReset()
    readNativeMessagingRegistry.mockReturnValue({
      chrome: 'C:\\bridge\\ru.verstak.browser_bridge.json',
      edge: 'C:\\bridge\\ru.verstak.browser_bridge.json',
    })
    hostManifest.content = JSON.stringify({
      name: 'ru.verstak.browser_bridge',
      description: 'Verstak Browser Bridge (Connected Eyes)',
      path: 'C:\\bridge\\host.cmd',
      type: 'stdio',
      allowed_origins: ['chrome-extension://jbhddmgcngdchlgmilphmbbcccfigadb/'],
    })
  })

  it('оставляет renderer только безопасные getState и connect без ручного pairing API', async () => {
    const bridge = {
      getPublicState: () => ({
        ui: 'connecting', desktopOnline: true, sessionId: null,
        browserTaskId: null, runId: null, attachedTab: null, lastError: null,
      }),
      getActivePairingCode: () => ({ code: 'secret-bootstrap', expiresAt: Date.now() + 60_000 }),
      isExtensionConnected: () => true,
      isExtensionAuthenticated: () => false,
      openAutoPairWindow: vi.fn(),
    }
    registerBrowserBridgeIpc({
      getBridge: () => bridge as never,
      getHostInstallDir: () => 'C:\\bridge',
      getHostScriptSource: () => 'host source',
    })

    expect([...handlers.keys()].sort()).toEqual([
      'browser-bridge:connect',
      'browser-bridge:get-state',
    ])
    const state = await handlers.get('browser-bridge:get-state')?.()
    expect(Object.keys(state as Record<string, unknown>).sort()).toEqual([
      'authenticated',
      'connected',
      'host',
      'lastError',
      'ui',
    ])
    expect(Object.keys((state as { host: Record<string, unknown> }).host).sort()).toEqual([
      'installed',
      'needsRepair',
    ])
  })

  it('одним вызовом чинит native host и возвращает итоговый статус подключения', async () => {
    const openAutoPairWindow = vi.fn()
    const bridge = {
      getPublicState: () => ({
        ui: 'paired', desktopOnline: true, sessionId: 'session-1',
        browserTaskId: null, runId: null, attachedTab: null, lastError: null,
      }),
      getActivePairingCode: () => null,
      isExtensionConnected: () => true,
      isExtensionAuthenticated: () => true,
      openAutoPairWindow,
    }
    registerBrowserBridgeIpc({
      getBridge: () => bridge as never,
      getHostInstallDir: () => 'C:\\bridge',
      getHostScriptSource: () => 'host source',
    })

    const connect = handlers.get('browser-bridge:connect')
    expect(connect).toBeTypeOf('function')
    const result = await connect?.()

    expect(installNativeHost).toHaveBeenCalledOnce()
    expect(installNativeHost).toHaveBeenCalledWith(expect.objectContaining({
      installDir: 'C:\\bridge',
    }))
    expect(openAutoPairWindow).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: true,
      needsExtensionAction: false,
      state: {
        authenticated: true,
        connected: true,
        host: { installed: true, needsRepair: false },
      },
    })
  })

  it('Connect при готовом host и unauthenticated extension открывает одноразовое окно pair', async () => {
    const openAutoPairWindow = vi.fn(() => ({ expiresAt: Date.now() + 60_000 }))
    const bridge = {
      getPublicState: () => ({
        ui: 'connecting', desktopOnline: true, sessionId: null,
        browserTaskId: null, runId: null, attachedTab: null, lastError: null,
      }),
      getActivePairingCode: () => null,
      isExtensionConnected: () => true,
      isExtensionAuthenticated: () => false,
      openAutoPairWindow,
    }
    registerBrowserBridgeIpc({
      getBridge: () => bridge as never,
      getHostInstallDir: () => 'C:\\bridge',
      getHostScriptSource: () => 'host source',
    })

    const connect = handlers.get('browser-bridge:connect')
    const result = await connect?.()

    expect(openAutoPairWindow).toHaveBeenCalledOnce()
    expect(openAutoPairWindow).toHaveBeenCalledWith({ ttlMs: 60_000 })
    expect(result).toMatchObject({
      ok: true,
      needsExtensionAction: true,
      state: { host: { installed: true }, authenticated: false },
    })
  })

  it('не считает host исправным, если registry указывает на старый существующий manifest', async () => {
    readNativeMessagingRegistry.mockReturnValue({
      chrome: 'C:\\old\\ru.verstak.browser_bridge.json',
      edge: 'C:\\old\\ru.verstak.browser_bridge.json',
    })
    const bridge = {
      getPublicState: () => ({ ui: 'offline', desktopOnline: true, lastError: null }),
      getActivePairingCode: () => null,
      isExtensionConnected: () => false,
      isExtensionAuthenticated: () => false,
    }
    registerBrowserBridgeIpc({
      getBridge: () => bridge as never,
      getHostInstallDir: () => 'C:\\bridge',
      getHostScriptSource: () => 'host source',
    })

    const getState = handlers.get('browser-bridge:get-state')
    const state = await getState?.()
    expect(state).toMatchObject({
      host: { installed: false, needsRepair: true },
    })
  })

  it('не считает host исправным, если manifest существует, но разрешает чужой extension', async () => {
    hostManifest.content = JSON.stringify({
      name: 'ru.verstak.browser_bridge',
      description: 'tampered',
      path: 'C:\\bridge\\host.cmd',
      type: 'stdio',
      allowed_origins: ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'],
    })
    const bridge = {
      getPublicState: () => ({ ui: 'offline', desktopOnline: true, lastError: null }),
      getActivePairingCode: () => null,
      isExtensionConnected: () => false,
      isExtensionAuthenticated: () => false,
    }
    registerBrowserBridgeIpc({
      getBridge: () => bridge as never,
      getHostInstallDir: () => 'C:\\bridge',
      getHostScriptSource: () => 'host source',
    })

    const getState = handlers.get('browser-bridge:get-state')
    const state = await getState?.()
    expect(state).toMatchObject({
      host: { installed: false, needsRepair: true },
    })
  })

  it('startup и Settings используют один канонический каталог native host', () => {
    const main = readFileSync(join(process.cwd(), 'electron', 'main.ts'), 'utf8')

    expect(main).toContain('const browserHostInstallDir =')
    expect(main).toContain('installDir: browserHostInstallDir')
    expect(main).toContain('getHostInstallDir: () => browserHostInstallDir')
    expect(main).not.toContain('getStateDir: () => dir')
  })
})
