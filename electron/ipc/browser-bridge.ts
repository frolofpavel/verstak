// browser-bridge.ts — IPC for Browser card UI (EXT-B1/C1).
// Pairing code, host install/repair status, public bridge state.
// No secrets in logs; pairing code returned once to UI for copy.

import { ipcMain, app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BridgeServer } from '../ai/browser/bridge/server'
import {
  installNativeHost,
  uninstallNativeHost,
  readNativeMessagingRegistry,
  resolveDevHostInstallDir,
  type HostInstallResult,
} from '../ai/browser/bridge/host-lifecycle'
import { EXTENSION_ID, NATIVE_HOST_NAME } from '../ai/browser/bridge/constants'

export interface BrowserBridgePublicState {
  ui: string
  desktopOnline: boolean
  connected: boolean
  authenticated: boolean
  sessionId: string | null
  browserTaskId: string | null
  runId: string | null
  attachedTab: {
    tabRef: string
    url: string
    title: string
    origin: string
  } | null
  lastError: string | null
  host: {
    installed: boolean
    needsRepair: boolean
    hostName: string
    extensionId: string
    registryOk: boolean
    manifestPath: string | null
  }
  extensionDir: string
  activePairingCode: string | null
  activePairingExpiresAt: number | null
}

export interface BrowserBridgeIpcDeps {
  getBridge: () => BridgeServer | null
  getStateDir: () => string
  getHostScriptSource: () => string | null
}

function extensionDirPath(): string {
  // Dev: project browser-extension/. Packaged: resources/browser-extension.
  const packaged = join(process.resourcesPath || '', 'browser-extension')
  if (app.isPackaged && existsSync(packaged)) return packaged
  const candidates = [
    join(app.getAppPath(), 'browser-extension'),
    join(process.cwd(), 'browser-extension'),
  ]
  for (const c of candidates) {
    if (existsSync(join(c, 'manifest.json'))) return c
  }
  return candidates[0]
}

function readHostStatus(installDir: string): BrowserBridgePublicState['host'] {
  const manifestPath = join(installDir, `${NATIVE_HOST_NAME}.json`)
  const launcherPath = join(installDir, 'host.cmd')
  const filesOk = existsSync(manifestPath) && existsSync(launcherPath)
  let registryOk = false
  try {
    const reg = readNativeMessagingRegistry()
    const paths = Object.values(reg).filter((p): p is string => typeof p === 'string' && p.length > 0)
    registryOk = paths.length > 0 && paths.some((p) => existsSync(p))
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

function hostInstallDir(stateDir: string): string {
  if (process.resourcesPath && app.isPackaged) {
    return join(process.resourcesPath, 'browser-bridge')
  }
  return resolveDevHostInstallDir(stateDir)
}

export function registerBrowserBridgeIpc(deps: BrowserBridgeIpcDeps): void {
  ipcMain.handle('browser-bridge:get-state', async (): Promise<BrowserBridgePublicState> => {
    const bridge = deps.getBridge()
    const stateDir = deps.getStateDir()
    const installDir = hostInstallDir(stateDir)
    const host = readHostStatus(installDir)
    const st = bridge?.getPublicState()
    const active = bridge?.getActivePairingCode() ?? null
    return {
      ui: st?.ui ?? 'offline',
      desktopOnline: st?.desktopOnline ?? !!bridge,
      connected: bridge?.isExtensionConnected() ?? false,
      authenticated: bridge?.isExtensionAuthenticated() ?? false,
      sessionId: st?.sessionId ?? null,
      browserTaskId: st?.browserTaskId ?? null,
      runId: st?.runId ?? null,
      attachedTab: st?.attachedTab ?? null,
      lastError: st?.lastError ?? null,
      host,
      extensionDir: extensionDirPath(),
      // Never expose full durable pairingToken — only short-lived bootstrap code if any.
      activePairingCode: active?.code ?? null,
      activePairingExpiresAt: active?.expiresAt ?? null,
    }
  })

  ipcMain.handle(
    'browser-bridge:issue-pairing-code',
    async (): Promise<{ ok: true; code: string; expiresAt: number } | { ok: false; error: string }> => {
      const bridge = deps.getBridge()
      if (!bridge) return { ok: false, error: 'Bridge server не запущен' }
      try {
        const c = bridge.issuePairingCode()
        return { ok: true, code: c.code, expiresAt: c.expiresAt }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(
    'browser-bridge:install-host',
    async (): Promise<HostInstallResult & { readback?: BrowserBridgePublicState['host'] }> => {
      const stateDir = deps.getStateDir()
      const installDir = hostInstallDir(stateDir)
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
    },
  )

  ipcMain.handle('browser-bridge:uninstall-host', async () => {
    const stateDir = deps.getStateDir()
    const installDir = hostInstallDir(stateDir)
    return uninstallNativeHost(installDir)
  })

  ipcMain.handle('browser-bridge:extension-dir', async () => {
    return { path: extensionDirPath(), extensionId: EXTENSION_ID }
  })
}
