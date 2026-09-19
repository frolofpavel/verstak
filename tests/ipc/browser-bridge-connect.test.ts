import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, hostManifest, installNativeHost, readNativeMessagingRegistry, validateInstalledHostBundle } = vi.hoisted(() => ({
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
  validateInstalledHostBundle: vi.fn(() => ({ ok: true })),
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
  validateInstalledHostBundle,
}))

import { registerBrowserBridgeIpc as registerBrowserBridgeIpcRaw } from '../../electron/ipc/browser-bridge'

type BrowserBridgeTestDeps = Omit<
  Parameters<typeof registerBrowserBridgeIpcRaw>[0],
  'hostPolicy' | 'hostVersions'
>

function registerBrowserBridgeIpc(deps: BrowserBridgeTestDeps): void {
  registerBrowserBridgeIpcRaw({
    ...deps,
    hostPolicy: { mode: 'installed', canInstall: true, canRegister: true, reason: null },
    hostVersions: {
      protocolVersion: 1,
      appVersion: '2.9.1',
      extensionVersion: '0.2.0',
      hostVersion: '2.9.1',
    },
  })
}

describe('browser bridge connect IPC', () => {
  const isolatedRoots: string[] = []
  afterEach(() => {
    for (const root of isolatedRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  it('Settings repair rejects moved ownership after startup approved its cached policy', async () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), 'verstak-settings-owner-moved-'))
    isolatedRoots.push(isolatedRoot)
    const actual = await vi.importActual<typeof import('../../electron/ai/browser/bridge/host-lifecycle')>(
      '../../electron/ai/browser/bridge/host-lifecycle',
    )
    let currentOwner = 'this-install'
    let locked = false
    const write = vi.fn(() => ({ ok: true, keys: [] }))
    const snapshot = vi.fn(() => ({}))
    const registry: import('../../electron/ai/browser/bridge/host-lifecycle').NativeMessagingRegistryAdapter = {
      withExclusive: work => {
        locked = true
        try { return work() } finally { locked = false }
      },
      verifyStableOwner: () => {
        expect(locked).toBe(true)
        return currentOwner === 'this-install'
          ? { ok: true }
          : { ok: false, error: 'Stable InstallLocation moved' }
      },
      write, snapshot, read: () => ({}), remove: () => ({ ok: true }), restore: () => ({ ok: true }),
    }
    registerBrowserBridgeIpc({
      getBridge: () => null,
      getHostInstallDir: () => join(isolatedRoot, 'host'),
      getHostScriptSource: () => 'host source',
    })
    currentOwner = 'successor-install'
    installNativeHost.mockImplementationOnce((...args: unknown[]) => (
      actual.installNativeHost({ ...(args[0] as Parameters<typeof actual.installNativeHost>[0]), registry })
    ))
    const result = await handlers.get('browser-bridge:connect')?.()
    expect(result).toMatchObject({ ok: false, error: 'Stable InstallLocation moved' })
    expect(write).not.toHaveBeenCalled()
    expect(snapshot).not.toHaveBeenCalled()
  })

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
      'connectionGeneration',
      'exactTabAttached',
      'freshObservation',
      'host',
      'lastError',
      'supported',
      'ui',
      'unavailableReason',
    ])
    expect(Object.keys((state as { host: Record<string, unknown> }).host).sort()).toEqual([
      'installed',
      'needsRepair',
    ])
  })

  it('на macOS не читает и не устанавливает Windows Native Host', async () => {
    registerBrowserBridgeIpc({
      supported: false,
      getBridge: () => null,
      getHostInstallDir: () => '/Applications/Verstak.app/Contents/Resources/browser-bridge',
      getHostScriptSource: () => 'host source',
    })

    const state = await handlers.get('browser-bridge:get-state')?.()
    const result = await handlers.get('browser-bridge:connect')?.()

    expect(readNativeMessagingRegistry).not.toHaveBeenCalled()
    expect(installNativeHost).not.toHaveBeenCalled()
    expect(state).toMatchObject({
      supported: false,
      ui: 'unsupported',
      host: { installed: false, needsRepair: false },
    })
    expect(result).toMatchObject({ ok: false, state: { supported: false, ui: 'unsupported' } })
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
        exactTabAttached: false,
        freshObservation: false,
        host: { installed: true, needsRepair: false },
      },
    })
  })

  it('readiness публикует только exact-tab/fresh booleans текущего connectionGeneration', async () => {
    let freshGeneration = 7
    const bridge = {
      getPublicState: () => ({
        ui: 'attached',
        desktopOnline: true,
        sessionId: 'session-secret',
        browserTaskId: 'bt-1',
        runId: 'run-1',
        connectionGeneration: 7,
        attachedTab: {
          tabRef: 'tab-42',
          url: 'https://secret.example/account',
          title: 'Secret account',
          origin: 'https://secret.example',
        },
        freshObservation: {
          connectionGeneration: freshGeneration,
          browserTaskId: 'bt-1',
          runId: 'run-1',
          tabRef: 'tab-42',
          observationVersion: 100,
          observedAt: Date.now(),
        },
        lastError: null,
      }),
      isExtensionConnected: () => true,
      isExtensionAuthenticated: () => true,
    }
    registerBrowserBridgeIpc({
      getBridge: () => bridge as never,
      getHostInstallDir: () => 'C:\\bridge',
      getHostScriptSource: () => 'host source',
    })

    const getState = handlers.get('browser-bridge:get-state')
    const ready = await getState?.() as Record<string, unknown>
    expect(ready).toMatchObject({
      connectionGeneration: 7,
      exactTabAttached: true,
      freshObservation: true,
    })
    expect(ready).not.toHaveProperty('attachedTab')
    expect(JSON.stringify(ready)).not.toContain('secret.example')

    freshGeneration = 6
    const stale = await getState?.()
    expect(stale).toMatchObject({ exactTabAttached: true, freshObservation: false })
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

  it('Settings cannot bypass portable ownership policy and write HKCU', async () => {
    const reason = 'Портативная сборка не регистрирует Native Host; установите стабильную версию Verstak'
    registerBrowserBridgeIpcRaw({
      getBridge: () => null,
      getHostInstallDir: () => 'C:\\portable-temp\\resources\\browser-bridge',
      getHostScriptSource: () => 'host source',
      hostPolicy: { mode: 'portable', canInstall: false, canRegister: false, reason },
      hostVersions: {
        protocolVersion: 1,
        appVersion: '2.9.1',
        extensionVersion: '0.2.0',
        hostVersion: '2.9.1',
      },
    })

    const result = await handlers.get('browser-bridge:connect')?.()
    expect(installNativeHost).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: false,
      error: reason,
      state: { host: { installed: false, needsRepair: false } },
    })
  })
})
