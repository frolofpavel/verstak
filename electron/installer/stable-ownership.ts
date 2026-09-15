import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, win32 } from 'node:path'
import {
  NATIVE_HOST_OWNER_MARKER,
  isNativeHostOwnerMarker,
  nativeHostOwnerMarker,
} from '../../shared/contracts/native-host-owner'
import { buildUninstallScript } from './engine'
import { acquireNativeHostOwnershipLease } from '../ai/browser/bridge/host-lifecycle'

const UNINSTALL_SCRIPT_NAME = 'Uninstall Verstak.ps1'

export type StableOwnershipMigrationResult =
  | { status: 'current' | 'migrated' | 'skipped'; reason?: string }
  | { status: 'failed'; reason: string; rolledBack: boolean }

export function isStableOwnershipConfirmed(result: StableOwnershipMigrationResult): boolean {
  return result.status === 'current' || result.status === 'migrated'
}

function sameWindowsPath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = win32.normalize(value).replace(/\\+$/, '')
    return normalized.toLocaleLowerCase('en-US')
  }
  return normalize(left) === normalize(right)
}

function readRegisteredInstallLocation(): { ok: true; value: string } | { ok: false; error: string } {
  const script = `$ErrorActionPreference = 'Stop'
try {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ru.verstak.ide', $false)
  if ($null -eq $key) { throw 'stable uninstall registry key is absent' }
  try { $value = [string]$key.GetValue('InstallLocation', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
  finally { $key.Dispose() }
  if (-not $value) { throw 'stable InstallLocation is absent' }
  $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value))
  [Console]::Out.Write('PRESENT ' + $payload)
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 9
}`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
  ], { encoding: 'utf8', shell: false, windowsHide: true })
  if (result.status !== 0) {
    return { ok: false, error: String(result.stderr || result.stdout || 'registry query failed').trim() }
  }
  const match = /^PRESENT ([A-Za-z0-9+/]+={0,2})$/.exec(String(result.stdout || '').trim())
  if (!match) return { ok: false, error: 'stable InstallLocation query protocol malformed' }
  return { ok: true, value: Buffer.from(match[1], 'base64').toString('utf8') }
}

let atomicWriteSequence = 0

function writeFileAtomically(path: string, payload: Buffer, failAfterStage = false): void {
  atomicWriteSequence += 1
  const temporary = `${path}.atomic-next-${process.pid}-${atomicWriteSequence}`
  let descriptor: number | null = null
  try {
    descriptor = openSync(temporary, 'wx')
    writeFileSync(descriptor, payload)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    if (failAfterStage) throw new Error(`injected atomic stage failure: ${path}`)
    renameSync(temporary, path)
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor) } catch { /* already closed */ }
    }
    rmSync(temporary, { force: true })
  }
}

type StableOwnershipMigrationInput = {
  isPackaged: boolean
  platform?: NodeJS.Platform
  installDir: string
  executablePath: string
  appVersion: string
  registeredInstallLocation?: string
  /** Deterministic second read for the ownership TOCTOU regression test. */
  registeredInstallLocationAfter?: string
  portableExecutableFile?: string | null
  portableExecutableDir?: string | null
  smoke?: string | null
  /** Deterministic failure point for the transactional regression test. */
  failAfterWrite?: 'marker' | 'uninstaller'
  /** Failure after fsync but before atomic replace; tests the power-loss boundary. */
  failAfterStage?: 'marker' | 'uninstaller'
  onPhase?: (phase: 'write' | 'rollback') => void
  acquireOwnershipLease?: typeof acquireNativeHostOwnershipLease
}

export function migrateStableInstallOwnershipOnStartup(input: StableOwnershipMigrationInput): StableOwnershipMigrationResult {
  if ((input.platform ?? process.platform) !== 'win32' || !input.isPackaged
    || input.portableExecutableFile || input.portableExecutableDir || input.smoke === '1') {
    return migrateStableOwnershipLocked(input)
  }
  let lease: ReturnType<typeof acquireNativeHostOwnershipLease> | undefined
  try {
    lease = (input.acquireOwnershipLease ?? acquireNativeHostOwnershipLease)()
    return migrateStableOwnershipLocked(input)
  } catch (error) {
    return { status: 'failed', reason: String(error instanceof Error ? error.message : error), rolledBack: true }
  } finally {
    lease?.release()
  }
}

function migrateStableOwnershipLocked(input: StableOwnershipMigrationInput): StableOwnershipMigrationResult {
  const platform = input.platform ?? process.platform
  if (platform !== 'win32' || !input.isPackaged) {
    return { status: 'skipped', reason: 'not a packaged Windows build' }
  }
  if (input.portableExecutableFile || input.portableExecutableDir) {
    return { status: 'skipped', reason: 'portable build cannot own stable registration' }
  }
  if (input.smoke === '1') {
    return { status: 'skipped', reason: 'packaged smoke cannot own stable registration' }
  }
  if (!existsSync(input.executablePath) || !sameWindowsPath(input.executablePath, join(input.installDir, 'Verstak.exe'))) {
    return { status: 'skipped', reason: 'exact stable executable proof is absent' }
  }

  const readRegisteredOwner = (afterWork = false): { ok: true; value: string } | { ok: false; error: string } => {
    const injected = afterWork
      ? input.registeredInstallLocationAfter ?? input.registeredInstallLocation
      : input.registeredInstallLocation
    return injected === undefined
      ? readRegisteredInstallLocation()
      : { ok: true, value: injected }
  }
  const matchesRegisteredOwner = (
    registered: { ok: true; value: string } | { ok: false; error: string },
  ): boolean => registered.ok && sameWindowsPath(registered.value, input.installDir)

  const registered = readRegisteredOwner()
  if (!matchesRegisteredOwner(registered)) {
    return { status: 'skipped', reason: registered.ok ? 'InstallLocation mismatch' : registered.error }
  }

  const markerPath = join(input.installDir, NATIVE_HOST_OWNER_MARKER)
  const uninstallPath = join(input.installDir, UNINSTALL_SCRIPT_NAME)
  if (!existsSync(uninstallPath)) {
    return { status: 'skipped', reason: 'stable uninstaller proof is absent' }
  }
  const markerBefore = existsSync(markerPath) ? readFileSync(markerPath) : null
  const uninstallBefore = readFileSync(uninstallPath)
  const uninstallPayload = Buffer.from(buildUninstallScript(input.installDir), 'utf8')
  let parsedMarker: unknown = null
  if (markerBefore) {
    try { parsedMarker = JSON.parse(markerBefore.toString('utf8')) } catch { parsedMarker = null }
    if (!isNativeHostOwnerMarker(parsedMarker, {
      installDir: input.installDir,
      executablePath: input.executablePath,
    })) {
      return { status: 'failed', reason: 'present owner marker is invalid for exact stable install', rolledBack: true }
    }
    if (
      isNativeHostOwnerMarker(parsedMarker, {
        installDir: input.installDir,
        executablePath: input.executablePath,
        appVersion: input.appVersion,
      })
      && uninstallBefore.equals(uninstallPayload)
    ) {
      const confirmed = readRegisteredOwner(true)
      if (!matchesRegisteredOwner(confirmed)) {
        return {
          status: 'skipped',
          reason: confirmed.ok ? 'InstallLocation changed before ownership confirmation' : confirmed.error,
        }
      }
      return { status: 'current' }
    }
  }

  const markerPayload = Buffer.from(`${JSON.stringify(
    nativeHostOwnerMarker(input.appVersion, input.installDir, input.executablePath),
    null,
    2,
  )}\n`, 'utf8')
  let markerWritten = false
  let uninstallerWritten = false
  try {
    input.onPhase?.('write')
    writeFileAtomically(markerPath, markerPayload, input.failAfterStage === 'marker')
    markerWritten = true
    if (input.failAfterWrite === 'marker') throw new Error('injected marker write failure')
    writeFileAtomically(uninstallPath, uninstallPayload, input.failAfterStage === 'uninstaller')
    uninstallerWritten = true
    if (input.failAfterWrite === 'uninstaller') throw new Error('injected uninstaller write failure')
    const markerReadback = JSON.parse(readFileSync(markerPath, 'utf8')) as unknown
    if (!isNativeHostOwnerMarker(markerReadback, {
      installDir: input.installDir,
      executablePath: input.executablePath,
      appVersion: input.appVersion,
    })) throw new Error('owner marker readback mismatch')
    if (!readFileSync(uninstallPath).equals(uninstallPayload)) throw new Error('uninstaller readback mismatch')
    const confirmed = readRegisteredOwner(true)
    if (!matchesRegisteredOwner(confirmed)) {
      throw new Error(confirmed.ok
        ? 'InstallLocation changed before ownership confirmation'
        : confirmed.error)
    }
    return { status: 'migrated' }
  } catch (error) {
    input.onPhase?.('rollback')
    const ownedWrites = [
      ...(markerWritten ? [{ path: markerPath, payload: markerPayload, before: markerBefore }] : []),
      ...(uninstallerWritten ? [{ path: uninstallPath, payload: uninstallPayload, before: uninstallBefore }] : []),
    ]
    const stillOwned = ownedWrites.every(({ path, payload }) => (
      existsSync(path) && readFileSync(path).equals(payload)
    ))
    if (!stillOwned) {
      return {
        status: 'failed',
        reason: `${error instanceof Error ? error.message : String(error)}; successor bytes preserved`,
        rolledBack: false,
      }
    }
    try {
      for (const { path, before } of [...ownedWrites].reverse()) {
        if (before === null) rmSync(path, { force: true })
        else writeFileSync(path, before)
      }
      const restored = ownedWrites.every(({ path, before }) => (
        before === null ? !existsSync(path) : existsSync(path) && readFileSync(path).equals(before)
      ))
      return {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        rolledBack: restored,
      }
    } catch (rollbackError) {
      return {
        status: 'failed',
        reason: `${error instanceof Error ? error.message : String(error)}; rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        rolledBack: false,
      }
    }
  }
}
