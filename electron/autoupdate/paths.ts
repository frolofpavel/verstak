import { app } from 'electron'
import { dirname, join } from 'path'

export function localAppDataRoot(): string {
  return process.env.LOCALAPPDATA || app.getPath('appData')
}

export function autoUpdateRoot(): string {
  return join(localAppDataRoot(), 'Verstak', 'AutoUpdate')
}

export function statePath(): string {
  return join(autoUpdateRoot(), 'state.json')
}

export function lockPath(): string {
  return join(autoUpdateRoot(), 'lock')
}

export function logsDir(): string {
  return join(autoUpdateRoot(), 'logs')
}

export function downloadsDir(version: string): string {
  return join(autoUpdateRoot(), 'downloads', version)
}

export function payloadVersionDir(version: string): string {
  return join(autoUpdateRoot(), 'payloads', version)
}

export function payloadRoot(version: string): string {
  return join(payloadVersionDir(version), 'payload')
}


export function currentInstallDir(): string {
  return dirname(process.execPath)
}

export function resourcesDir(): string {
  return join(currentInstallDir(), 'resources')
}

export function sevenZipPath(): string {
  return join(resourcesDir(), '7za.exe')
}

export function helperPath(): string {
  return join(resourcesDir(), 'verstak-auto-update-helper.cjs')
}

export function legacyStagingRoot(): string {
  return join(localAppDataRoot(), 'verstak-update-staging')
}

export function legacyUpdaterRoot(): string {
  return join(localAppDataRoot(), 'verstak-updater')
}
