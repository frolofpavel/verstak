import { win32 } from 'node:path'

export const NATIVE_HOST_OWNER_MARKER = '.verstak-install-owner.json'
export const STABLE_OWNERSHIP_MUTEX_NAME = 'Local\\Verstak.StableOwnership.v1'

export interface NativeHostOwnerMarker {
  schemaVersion: 1
  product: 'Verstak'
  appVersion: string
  installDir: string
  executablePath: string
  ownsNativeHostRegistration: true
}

function normalizeOwnerPath(value: string): string {
  const normalized = win32.normalize(value.trim())
  return normalized.length > 3 ? normalized.replace(/\\+$/, '') : normalized
}

function sameOwnerPath(left: string, right: string): boolean {
  return normalizeOwnerPath(left).toLocaleLowerCase('en-US')
    === normalizeOwnerPath(right).toLocaleLowerCase('en-US')
}

export function nativeHostOwnerMarker(
  appVersion: string,
  installDir: string,
  executablePath = win32.join(installDir, 'Verstak.exe'),
): NativeHostOwnerMarker {
  return {
    schemaVersion: 1,
    product: 'Verstak',
    appVersion,
    installDir: normalizeOwnerPath(installDir),
    executablePath: normalizeOwnerPath(executablePath),
    ownsNativeHostRegistration: true,
  }
}

export function isNativeHostOwnerMarker(
  input: unknown,
  expected?: { installDir: string; executablePath: string; appVersion?: string },
): input is NativeHostOwnerMarker {
  if (!input || typeof input !== 'object') return false
  const value = input as Partial<NativeHostOwnerMarker>
  if (!(value.schemaVersion === 1
    && value.product === 'Verstak'
    && typeof value.appVersion === 'string'
    && value.appVersion.length > 0
    && typeof value.installDir === 'string'
    && win32.isAbsolute(value.installDir)
    && typeof value.executablePath === 'string'
    && win32.isAbsolute(value.executablePath)
    && sameOwnerPath(value.executablePath, win32.join(value.installDir, 'Verstak.exe'))
    && value.ownsNativeHostRegistration === true)) return false
  if (!expected) return true
  return sameOwnerPath(value.installDir, expected.installDir)
    && sameOwnerPath(value.executablePath, expected.executablePath)
    && (!expected.appVersion || value.appVersion === expected.appVersion)
}
