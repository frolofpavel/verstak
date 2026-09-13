// browser-bridge.ts — narrow renderer IPC for Browser settings (EXT-B1/C1).
// The renderer can read public state and start the one-click connection flow.

import { ipcMain, app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import type { BridgeServer } from '../ai/browser/bridge/server'
import {
  installNativeHost,
  readNativeMessagingRegistry,
  validateHostManifest,
  type HostInstallResult,
} from '../ai/browser/bridge/host-lifecycle'
import { EXTENSION_ID, NATIVE_HOST_NAME } from '../ai/browser/bridge/constants'

export interface BrowserBridgePublicState {
  ui: string
  connected: boolean
  authenticated: boolean
  lastError: string | null
  host: {
    installed: boolean
    needsRepair: boolean
  }
}

interface BrowserHostStatus {
  installed: boolean
  needsRepair: boolean
  hostName: string
  extensionId: string
  registryOk: boolean
  manifestPath: string | null
}

export interface BrowserBridgeIpcDeps {
  getBridge: () => BridgeServer | null
  /** Единственный каталог host, уже разрешённый bootstrap'ом приложения. */
  getHostInstallDir: () => string
  getHostScriptSource: () => string | null
}

function readHostStatus(installDir: string): BrowserHostStatus {
  const manifestPath = join(installDir, `${NATIVE_HOST_NAME}.json`)
  const launcherPath = join(installDir, 'host.cmd')
  const hostScriptPath = join(installDir, 'host.mjs')
  const assetsExist = existsSync(manifestPath) && existsSync(launcherPath) && existsSync(hostScriptPath)
  let manifestOk = false
  if (assetsExist) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
      const validated = validateHostManifest(parsed)
      manifestOk = validated.ok
        && normalize(validated.manifest.path).toLocaleLowerCase('en-US')
          === normalize(launcherPath).toLocaleLowerCase('en-US')
    } catch {
      manifestOk = false
    }
  }
  const filesOk = assetsExist && manifestOk
  let registryOk = false
  try {
    const reg = readNativeMessagingRegistry()
    const expected = normalize(manifestPath).toLocaleLowerCase('en-US')
    const paths = Object.values(reg)
    registryOk = paths.length > 0 && paths.every((p) => (
      typeof p === 'string'
      && normalize(p).toLocaleLowerCase('en-US') === expected
      && existsSync(p)
    ))
  } catch {
    registryOk = false
  }
  return {
    installed: filesOk && registryOk,
    needsRepair: !filesOk || !registryOk,
    hostName: NATIVE_HOST_NAME,
    extensionId: EXTENSION_ID,
    registryOk,
    manifestPath: filesOk ? manifestPath : null,
  }
}

function publicState(deps: BrowserBridgeIpcDeps): BrowserBridgePublicState {
  const bridge = deps.getBridge()
  const installDir = deps.getHostInstallDir()
  const host = readHostStatus(installDir)
  const st = bridge?.getPublicState()
  return {
    ui: st?.ui ?? 'offline',
    connected: bridge?.isExtensionConnected() ?? false,
    authenticated: bridge?.isExtensionAuthenticated() ?? false,
    lastError: st?.lastError ?? null,
    host: {
      installed: host.installed,
      needsRepair: host.needsRepair,
    },
  }
}

function installHost(deps: BrowserBridgeIpcDeps): HostInstallResult & {
  readback?: BrowserHostStatus
} {
  const installDir = deps.getHostInstallDir()
  const src = deps.getHostScriptSource()
  if (!src) {
    return {
      ok: false,
      hostName: NATIVE_HOST_NAME,
      manifestPath: '',
      hostLauncherPath: '',
      registryKeys: [],
      error: 'host-runtime.mjs не найден',
    }
  }
  const result = installNativeHost({
    installDir,
    hostScriptSource: src,
    electronExeAbsolute: process.execPath,
    electronExeRelative: app.isPackaged ? '..\\..\\Verstak.exe' : undefined,
    allowNodeFallback: !app.isPackaged,
    force: true,
  })
  return { ...result, readback: readHostStatus(installDir) }
}

export function registerBrowserBridgeIpc(deps: BrowserBridgeIpcDeps): void {
  ipcMain.handle('browser-bridge:get-state', async (): Promise<BrowserBridgePublicState> => {
    return publicState(deps)
  })

  ipcMain.handle('browser-bridge:connect', async () => {
    const installed = installHost(deps)
    const bridge = deps.getBridge()
    let state = publicState(deps)
    let ok = installed.ok && state.host.installed && !state.host.needsRepair && !!bridge
    if (ok && !state.authenticated) {
      try {
        bridge!.openAutoPairWindow({ ttlMs: 60_000 })
        state = publicState(deps)
      } catch {
        ok = false
      }
    }
    return {
      ok,
      state,
      needsExtensionAction: ok && !state.authenticated,
      error: ok
        ? undefined
        : (installed.error || state.lastError || (!bridge ? 'Bridge server не запущен' : 'Не удалось подключить браузер')),
    }
  })

}
