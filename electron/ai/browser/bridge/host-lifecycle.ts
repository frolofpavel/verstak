// host-lifecycle.ts — Windows HKCU registration Native Messaging host (EXT-B1).
//
// install / upgrade / repair / uninstall + readback для тестов.
// Никаких приватных ключей. allowed_origins — только наш EXTENSION_ID.

import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  NATIVE_HOST_OWNER_MARKER,
  STABLE_OWNERSHIP_MUTEX_NAME,
  isNativeHostOwnerMarker,
} from '../../../../shared/contracts/native-host-owner'
import {
  BROWSER_EXTENSION_VERSION,
  BRIDGE_PROTOCOL_VERSION,
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  NATIVE_HOST_METADATA_FILE,
  NATIVE_HOST_NAME,
} from './constants'

export type NativeHostPolicyMode = 'installed' | 'portable' | 'packaged-smoke' | 'dev-isolated' | 'disabled'

export interface NativeHostPolicy {
  mode: NativeHostPolicyMode
  canInstall: boolean
  canRegister: boolean
  reason: string | null
}

function isSameOrWithinWindowsPath(candidate: string, protectedRoot: string): boolean {
  const relative = win32.relative(win32.normalize(protectedRoot), win32.normalize(candidate))
  return relative === '' || (!relative.startsWith('..') && !win32.isAbsolute(relative))
}

function canonicalWindowsPath(input: string): string | null {
  const trimmed = input.trim()
  // Device/UNC namespaces can make a lexical C:\ comparison lie. Dev isolation
  // is local-only, so reject them rather than attempting to normalize aliases.
  if (!trimmed || /^\\\\[?.]\\/.test(trimmed) || trimmed.startsWith('\\\\')) return null
  if (!/^[a-z]:\\/i.test(trimmed) || !win32.isAbsolute(trimmed)) return null

  let existing = win32.normalize(trimmed)
  const missing: string[] = []
  while (!existsSync(existing)) {
    const parent = win32.dirname(existing)
    if (parent === existing) return null
    missing.unshift(win32.basename(existing))
    existing = parent
  }
  try {
    const resolved = realpathSync.native(existing)
    const canonical = win32.normalize(win32.join(resolved, ...missing))
    return /^\\\\[?.]\\/.test(canonical) || canonical.startsWith('\\\\')
      ? null
      : canonical
  } catch {
    return null
  }
}

export function resolveDevUserDataOverride(input: {
  isPackaged: boolean
  devUserDataDir?: string | null
  defaultUserDataDir?: string | null
  stableUserDataDir?: string | null
}): string | null {
  if (input.isPackaged) return null
  const candidate = input.devUserDataDir?.trim() ?? ''
  const protectedRoots = [input.defaultUserDataDir, input.stableUserDataDir]
    .map(path => path?.trim() ?? '')
  const canonicalCandidate = canonicalWindowsPath(candidate)
  const canonicalProtectedRoots = protectedRoots.map(canonicalWindowsPath)
  if (!canonicalCandidate || canonicalProtectedRoots.some(path => !path)) return null
  return canonicalProtectedRoots.every(path => !isSameOrWithinWindowsPath(canonicalCandidate, path!))
    ? canonicalCandidate
    : null
}

export function resolveNativeHostPolicy(input: {
  isPackaged: boolean
  portableExecutableFile?: string | null
  portableExecutableDir?: string | null
  smoke?: string | null
  devNativeHostOptIn?: string | null
  devUserDataDir?: string | null
  /** Ordinary Electron userData before any dev override. */
  defaultUserDataDir?: string | null
  /** Stable installed app userData root. */
  stableUserDataDir?: string | null
  installedOwnerMarker?: boolean
  installedRegistryOwner?: boolean
}): NativeHostPolicy {
  if (input.isPackaged && (input.portableExecutableFile || input.portableExecutableDir)) {
    return {
      mode: 'portable',
      canInstall: false,
      canRegister: false,
      reason: 'Портативная сборка не регистрирует Native Host; установите стабильную версию Verstak',
    }
  }
  if (input.isPackaged && input.smoke === '1') {
    return { mode: 'packaged-smoke', canInstall: true, canRegister: false, reason: null }
  }
  if (
    input.isPackaged
    && input.installedOwnerMarker === true
    && input.installedRegistryOwner === true
  ) {
    return { mode: 'installed', canInstall: true, canRegister: true, reason: null }
  }
  if (input.isPackaged) {
    return {
      mode: 'disabled',
      canInstall: false,
      canRegister: false,
      reason: 'Эта unpacked-копия не установлена штатным установщиком и не может владеть Native Host',
    }
  }
  return {
    mode: 'disabled',
    canInstall: false,
    canRegister: false,
    reason: 'Dev Native Host выключен до привязки endpoint к dev-сборке; используйте установленный Verstak',
  }
}

export interface BrowserBridgeVersions {
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION
  appVersion: string
  extensionVersion: string
  hostVersion: string
}

export interface HostMetadata extends BrowserBridgeVersions {
  schemaVersion: 1
  files: Record<string, string>
}

export function browserBridgeVersions(appVersion: string): BrowserBridgeVersions {
  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    appVersion,
    extensionVersion: BROWSER_EXTENSION_VERSION,
    hostVersion: appVersion,
  }
}

export function hasStableInstallOwnerMarker(
  installDir: string,
  executablePath = join(installDir, 'Verstak.exe'),
  appVersion?: string,
): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(installDir, NATIVE_HOST_OWNER_MARKER), 'utf8')) as unknown
    return existsSync(executablePath) && isNativeHostOwnerMarker(parsed, {
      installDir,
      executablePath,
      appVersion,
    })
  } catch {
    return false
  }
}

export type NativeMessagingRegistrySnapshotEntry =
  | { state: 'present'; value: string }
  | { state: 'absent' }
  | { state: 'error'; error: string }

export type NativeMessagingRegistrySnapshot = Record<string, NativeMessagingRegistrySnapshotEntry>

export interface NativeMessagingRegistryAdapter {
  /** Isolated adapters may provide deterministic ownership/lock behavior. */
  verifyStableOwner?(installDir: string): { ok: boolean; error?: string }
  withExclusive?<T>(work: () => T): T
  write(manifestPath: string): { ok: boolean; keys: string[]; error?: string }
  snapshot(): NativeMessagingRegistrySnapshot
  read(): Record<string, string | null>
  remove(expectedManifestPath?: string): { ok: boolean; error?: string }
  restore(
    values: NativeMessagingRegistrySnapshot,
    expectedCurrent?: NativeMessagingRegistrySnapshot,
  ): { ok: boolean; error?: string }
}

export interface HostManifest {
  name: string
  description: string
  path: string
  type: 'stdio'
  allowed_origins: string[]
}

export interface HostInstallResult {
  ok: boolean
  hostName: string
  manifestPath: string
  hostLauncherPath: string
  metadataPath: string
  registryKeys: string[]
  versions: BrowserBridgeVersions
  rolledBack?: boolean
  error?: string
}

/** Pure: построить JSON host-manifest (для package + install). */
export function buildHostManifest(hostLauncherAbsolutePath: string): HostManifest {
  return {
    name: NATIVE_HOST_NAME,
    description: 'Verstak Browser Bridge (Connected Eyes)',
    path: hostLauncherAbsolutePath.replace(/\//g, '\\'),
    type: 'stdio',
    allowed_origins: [EXTENSION_ORIGIN],
  }
}

/** Pure: только наш origin, без wildcards. */
export function validateHostManifest(m: unknown): { ok: true; manifest: HostManifest } | { ok: false; reason: string } {
  if (!m || typeof m !== 'object') return { ok: false, reason: 'not object' }
  const o = m as Record<string, unknown>
  if (o.name !== NATIVE_HOST_NAME) return { ok: false, reason: 'bad name' }
  if (o.type !== 'stdio') return { ok: false, reason: 'type must be stdio' }
  if (typeof o.path !== 'string' || !o.path) return { ok: false, reason: 'path required' }
  if (!Array.isArray(o.allowed_origins) || o.allowed_origins.length !== 1) {
    return { ok: false, reason: 'allowed_origins must be exactly one origin' }
  }
  if (o.allowed_origins[0] !== EXTENSION_ORIGIN) {
    return { ok: false, reason: `allowed_origins must be ${EXTENSION_ORIGIN}` }
  }
  // Reject wildcards / all_urls style
  for (const origin of o.allowed_origins) {
    if (typeof origin !== 'string' || origin.includes('*') || origin.includes('all_urls')) {
      return { ok: false, reason: 'wildcard origins forbidden' }
    }
  }
  return {
    ok: true,
    manifest: {
      name: NATIVE_HOST_NAME,
      description: String(o.description ?? ''),
      path: String(o.path),
      type: 'stdio',
      allowed_origins: [EXTENSION_ORIGIN],
    },
  }
}

export function chromeRegistryKey(): string {
  return `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
}

export function edgeRegistryKey(): string {
  return `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
}

/** reg.exe пишет консольный вывод в OEM code page; на русской Windows это CP866. */
export function decodeRegistryOutput(value: Buffer): string {
  if (process.platform !== 'win32') return value.toString('utf8')
  return new TextDecoder('ibm866').decode(value)
}

/**
 * Записать default value registry key → path to host manifest JSON.
 * reg.exe надёжнее PS Set-ItemProperty '(default)' на RU Windows.
 */
export function writeNativeMessagingRegistry(manifestPath: string): { ok: boolean; keys: string[]; error?: string } {
  try {
    return withNativeHostOwnershipLock(() => writeNativeMessagingRegistryLocked(manifestPath))
  } catch (error) {
    return { ok: false, keys: [], error: String(error instanceof Error ? error.message : error) }
  }
}

function writeNativeMessagingRegistryLocked(manifestPath: string): { ok: boolean; keys: string[]; error?: string } {
  const keys = [chromeRegistryKey(), edgeRegistryKey()]
  if (process.platform !== 'win32') {
    return { ok: true, keys: [] } // no-op off Windows (dev/CI)
  }
  const mp = manifestPath.replace(/\//g, '\\')
  const errors: string[] = []
  for (const key of keys) {
    // /ve = default value; /f = force overwrite
    const r = spawnSync(
      'reg.exe',
      ['add', key, '/ve', '/t', 'REG_SZ', '/d', mp, '/f'],
      { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000 },
    )
    if (r.status !== 0) {
      errors.push(`${key}: ${(r.stderr || r.stdout || 'reg add failed').trim()}`)
    }
  }
  if (errors.length) return { ok: false, keys, error: errors.join('; ') }
  return { ok: true, keys }
}

function encodedPowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

const ownershipWait = new Int32Array(new SharedArrayBuffer(4))

/** Explicit lease: async callers keep it until their final rollback/commit. */
export function acquireNativeHostOwnershipLease(
  options: { mutexName?: string; acquireTimeoutMs?: number } = {},
): { release(): void } {
  if (process.platform !== 'win32') return { release() {} }
  const controlDir = mkdtempSync(join(tmpdir(), 'verstak-host-owner-'))
  const ready = join(controlDir, 'ready')
  const release = join(controlDir, 'release')
  const done = join(controlDir, 'done')
  const errorFile = join(controlDir, 'error')
  const timeout = options.acquireTimeoutMs ?? 15000
  const script = `$ErrorActionPreference = 'Stop'
$operation = 'VERSTAK_NATIVE_HOST_MUTEX_HOLDER_V1'
$controlDirBase64 = '${Buffer.from(controlDir, 'utf8').toString('base64')}'
$control = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($controlDirBase64))
$mutexName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(options.mutexName ?? STABLE_OWNERSHIP_MUTEX_NAME, 'utf8').toString('base64')}'))
$mutex = [Threading.Mutex]::new($false, $mutexName)
$acquired = $false
try {
  $parentProcess = [Diagnostics.Process]::GetProcessById(${process.pid})
  try { $acquired = $mutex.WaitOne(${timeout}) }
  catch [Threading.AbandonedMutexException] { $acquired = $true }
  if (-not $acquired) { throw 'Stable ownership mutex timeout' }
  if ($parentProcess.HasExited -or [IO.File]::Exists((Join-Path $control 'release'))) { return }
  [IO.File]::WriteAllText((Join-Path $control 'ready'), 'ACQUIRED')
  while (-not [IO.File]::Exists((Join-Path $control 'release'))) {
    if ($parentProcess.HasExited) { break }
    Start-Sleep -Milliseconds 20
  }
} catch {
  [IO.File]::WriteAllText((Join-Path $control 'error'), $_.Exception.Message)
} finally {
  if ($acquired) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
  [IO.File]::WriteAllText((Join-Path $control 'done'), 'DONE')
}`
  const holder = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script),
  ], { stdio: 'ignore', windowsHide: true, shell: false })
  holder.on('error', () => { /* bounded handshake reports launch failure */ })
  holder.unref()
  const waitUntil = (predicate: () => boolean, waitMs: number): boolean => {
    const deadline = Date.now() + waitMs
    while (!predicate()) {
      if (Date.now() >= deadline) return false
      Atomics.wait(ownershipWait, 0, 0, 20)
    }
    return true
  }
  let released = false
  const releaseLease = () => {
    if (released) return
    released = true
    try { writeFileSync(release, 'RELEASE', 'utf8') } catch {
      holder.kill()
    }
    if (!holder.pid || waitUntil(() => {
      try { return readFileSync(done, 'utf8') === 'DONE' } catch { return false }
    }, timeout + 10000)) {
      if (!waitUntil(() => {
        try { rmSync(controlDir, { recursive: true, force: true }); return true } catch { return false }
      }, 3000)) throw new Error('Stable ownership mutex control cleanup failed')
    } else {
      holder.kill()
      throw new Error('Stable ownership mutex holder did not acknowledge release')
    }
  }
  try {
    const acquired = waitUntil(() => {
      if (existsSync(done)) return true
      try { return existsSync(ready) && readFileSync(ready, 'utf8') === 'ACQUIRED' } catch { return false }
    }, timeout + 10000)
    if (!acquired || !existsSync(ready) || readFileSync(ready, 'utf8') !== 'ACQUIRED') {
      throw new Error(existsSync(errorFile)
        ? readFileSync(errorFile, 'utf8')
        : 'Stable ownership mutex acquisition failed')
    }
    if (existsSync(done)) throw new Error('Stable ownership mutex holder exited before transaction')
    return { release: releaseLease }
  } catch (error) {
    releaseLease()
    throw error
  }
}

export function withNativeHostOwnershipLock<T>(work: () => T,
  options: { mutexName?: string; acquireTimeoutMs?: number } = {}): T {
  const lease = acquireNativeHostOwnershipLease(options)
  try { return work() } finally { lease.release() }
}

function registrySubKey(key: string): string | null {
  const prefix = 'HKCU\\'
  return key.toLocaleUpperCase('en-US').startsWith(prefix)
    ? key.slice(prefix.length)
    : null
}

function queryNativeMessagingRegistryValue(key: string): NativeMessagingRegistrySnapshotEntry {
  if (process.platform !== 'win32') return { state: 'absent' }
  const subKey = registrySubKey(key)
  if (!subKey) return { state: 'error', error: 'registry key is outside HKCU' }
  const keyBase64 = Buffer.from(subKey, 'utf8').toString('base64')
  const script = `$ErrorActionPreference = 'Stop'
$operation = 'VERSTAK_QUERY_DEFAULT_V1'
$keyBase64 = '${keyBase64}'
try {
  $keyPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($keyBase64))
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath, $false)
  if ($null -eq $key) { [Console]::Out.Write('ABSENT'); exit 0 }
  try { $value = $key.GetValue($null, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
  finally { $key.Dispose() }
  if ($null -eq $value) { [Console]::Out.Write('ABSENT'); exit 0 }
  $valueBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$value))
  [Console]::Out.Write('PRESENT ' + $valueBase64)
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 9
}`
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)],
    { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000 },
  )
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim()
    return { state: 'error', error: detail || `registry query exited ${String(result.status)}` }
  }
  const text = String(result.stdout || '').trim()
  if (text === 'ABSENT') return { state: 'absent' }
  const match = /^PRESENT ([A-Za-z0-9+/]+={0,2})$/.exec(text)
  if (!match) return { state: 'error', error: 'registry query protocol malformed' }
  try {
    return { state: 'present', value: Buffer.from(match[1], 'base64').toString('utf8') }
  } catch {
    return { state: 'error', error: 'registry query value is not valid base64' }
  }
}

export function snapshotNativeMessagingRegistry(): NativeMessagingRegistrySnapshot {
  return {
    [chromeRegistryKey()]: queryNativeMessagingRegistryValue(chromeRegistryKey()),
    [edgeRegistryKey()]: queryNativeMessagingRegistryValue(edgeRegistryKey()),
  }
}

/** Simple public/UI readback. Transactional code uses the strict snapshot above. */
export function readNativeMessagingRegistry(): Record<string, string | null> {
  const snapshot = snapshotNativeMessagingRegistry()
  return Object.fromEntries(Object.entries(snapshot).map(([key, entry]) => [
    key,
    entry.state === 'present' ? entry.value : null,
  ]))
}

/** Удалить HKCU keys (uninstall / cleanup). */
function sameWindowsPath(left: string, right: string): boolean {
  return left.replace(/\//g, '\\').replace(/\\+$/, '').toLocaleLowerCase('en-US')
    === right.replace(/\//g, '\\').replace(/\\+$/, '').toLocaleLowerCase('en-US')
}

type ConditionalRegistryDeleteResult =
  | { state: 'deleted' | 'absent' }
  | { state: 'successor'; value: string }
  | { state: 'error'; error: string }

type ConditionalRegistryRestoreResult =
  | { state: 'restored' | 'already' | 'successor' }
  | { state: 'error'; error: string }

function deleteRegistryKeyIfValueMatches(
  key: string,
  expectedValue: string,
): ConditionalRegistryDeleteResult {
  const subKey = registrySubKey(key)
  if (!subKey) return { state: 'error', error: 'registry key is outside HKCU' }
  const keyBase64 = Buffer.from(subKey, 'utf8').toString('base64')
  const expectedBase64 = Buffer.from(expectedValue, 'utf8').toString('base64')
  const script = `$ErrorActionPreference = 'Stop'
$operation = 'VERSTAK_DELETE_IF_MATCH_V1'
$keyBase64 = '${keyBase64}'
$expectedBase64 = '${expectedBase64}'
try {
  $keyPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($keyBase64))
  $expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($expectedBase64))
  $slash = $keyPath.LastIndexOf('\\')
  if ($slash -lt 1) { throw 'registry key has no parent' }
  $parentPath = $keyPath.Substring(0, $slash)
  $leaf = $keyPath.Substring($slash + 1)
  $parent = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($parentPath, $true)
  if ($null -eq $parent) { [Console]::Out.Write('ABSENT'); exit 0 }
  try {
    $currentKey = $parent.OpenSubKey($leaf, $false)
    if ($null -eq $currentKey) { [Console]::Out.Write('ABSENT'); exit 0 }
    try { $current = $currentKey.GetValue($null, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    finally { $currentKey.Dispose() }
    if ($null -eq $current) { [Console]::Out.Write('ABSENT'); exit 0 }
    if (-not [string]::Equals([string]$current, $expected, [StringComparison]::OrdinalIgnoreCase)) {
      $actualBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$current))
      [Console]::Out.Write('SUCCESSOR ' + $actualBase64)
      exit 0
    }
    $parent.DeleteSubKeyTree($leaf, $false)
    [Console]::Out.Write('DELETED')
  } finally { $parent.Dispose() }
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 9
}`
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)],
    { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000 },
  )
  if (result.status !== 0) {
    return {
      state: 'error',
      error: String(result.stderr || result.stdout || `conditional registry delete exited ${String(result.status)}`).trim(),
    }
  }
  const output = String(result.stdout || '').trim()
  if (output === 'DELETED') return { state: 'deleted' }
  if (output === 'ABSENT') return { state: 'absent' }
  const successor = /^SUCCESSOR ([A-Za-z0-9+/]+={0,2})$/.exec(output)
  if (successor) {
    return { state: 'successor', value: Buffer.from(successor[1], 'base64').toString('utf8') }
  }
  return { state: 'error', error: 'conditional registry delete protocol malformed' }
}

function restoreRegistryKeyIfValueMatches(
  key: string,
  previous: NativeMessagingRegistrySnapshotEntry,
  expectedCurrent?: NativeMessagingRegistrySnapshotEntry,
): ConditionalRegistryRestoreResult {
  if (previous.state === 'error' || expectedCurrent?.state === 'error') {
    return { state: 'error', error: 'invalid registry rollback snapshot' }
  }
  const subKey = registrySubKey(key)
  if (!subKey) return { state: 'error', error: 'registry key is outside HKCU' }
  const keyBase64 = Buffer.from(subKey, 'utf8').toString('base64')
  const previousValueBase64 = previous.state === 'present'
    ? Buffer.from(previous.value, 'utf8').toString('base64')
    : ''
  const expectedValueBase64 = expectedCurrent?.state === 'present'
    ? Buffer.from(expectedCurrent.value, 'utf8').toString('base64')
    : ''
  const script = `$ErrorActionPreference = 'Stop'
$operation = 'VERSTAK_RESTORE_IF_UNCHANGED_V2'
$keyBase64 = '${keyBase64}'
$previousState = '${previous.state}'
$previousValueBase64 = '${previousValueBase64}'
$expectedState = '${expectedCurrent?.state ?? 'any'}'
$expectedValueBase64 = '${expectedValueBase64}'
try {
  $keyPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($keyBase64))
  $previousValue = if ($previousState -eq 'present') { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($previousValueBase64)) } else { $null }
  $expectedValue = if ($expectedState -eq 'present') { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($expectedValueBase64)) } else { $null }
  $slash = $keyPath.LastIndexOf('\\')
  if ($slash -lt 1) { throw 'registry key has no parent' }
  $parentPath = $keyPath.Substring(0, $slash)
  $leaf = $keyPath.Substring($slash + 1)
  $parent = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($parentPath, $true)
  if ($null -eq $parent -and $previousState -eq 'present' -and ($expectedState -eq 'absent' -or $expectedState -eq 'any')) {
    $parent = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($parentPath)
  }
  if ($null -eq $parent) {
    if ($previousState -eq 'absent') { [Console]::Out.Write('ALREADY'); exit 0 }
    [Console]::Out.Write('SUCCESSOR'); exit 0
  }
  try {
    $currentKey = $parent.OpenSubKey($leaf, $true)
    $current = $null
    if ($null -ne $currentKey) {
      $current = $currentKey.GetValue($null, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    }
    $matchesExpected = $expectedState -eq 'any' -or (
      ($expectedState -eq 'absent' -and $null -eq $current) -or
      ($expectedState -eq 'present' -and $null -ne $current -and [string]::Equals([string]$current, $expectedValue, [StringComparison]::OrdinalIgnoreCase))
    )
    if (-not $matchesExpected) {
      if ($null -ne $currentKey) { $currentKey.Dispose() }
      [Console]::Out.Write('SUCCESSOR'); exit 0
    }
    $alreadyPrevious = ($previousState -eq 'absent' -and $null -eq $current) -or (
      $previousState -eq 'present' -and $null -ne $current -and [string]::Equals([string]$current, $previousValue, [StringComparison]::OrdinalIgnoreCase)
    )
    if ($alreadyPrevious) {
      if ($null -ne $currentKey) { $currentKey.Dispose() }
      [Console]::Out.Write('ALREADY'); exit 0
    }
    if ($previousState -eq 'absent') {
      if ($null -ne $currentKey) { $currentKey.Dispose() }
      $parent.DeleteSubKeyTree($leaf, $false)
      if ($null -ne $parent.OpenSubKey($leaf, $false)) { throw 'registry rollback readback mismatch' }
    } else {
      if ($null -eq $currentKey) {
        $currentKey = $parent.CreateSubKey($leaf)
        $racedValue = $currentKey.GetValue($null, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -ne $racedValue) {
          $currentKey.Dispose()
          [Console]::Out.Write('SUCCESSOR'); exit 0
        }
      }
      try {
        $currentKey.SetValue($null, $previousValue, [Microsoft.Win32.RegistryValueKind]::String)
        $currentKey.Flush()
        $restored = $currentKey.GetValue($null, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -eq $restored -or -not [string]::Equals([string]$restored, $previousValue, [StringComparison]::OrdinalIgnoreCase)) {
          throw 'registry rollback readback mismatch'
        }
      } finally { $currentKey.Dispose() }
    }
    [Console]::Out.Write('RESTORED')
  } finally { $parent.Dispose() }
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 9
}`
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)],
    { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000 },
  )
  if (result.status !== 0) {
    return {
      state: 'error',
      error: String(result.stderr || result.stdout || `conditional registry restore exited ${String(result.status)}`).trim(),
    }
  }
  const output = String(result.stdout || '').trim()
  if (output === 'RESTORED') return { state: 'restored' }
  if (output === 'ALREADY') return { state: 'already' }
  if (output === 'SUCCESSOR') return { state: 'successor' }
  return { state: 'error', error: 'conditional registry restore protocol malformed' }
}

export function removeNativeMessagingRegistry(
  expectedManifestPath?: string,
): { ok: boolean; error?: string } {
  try {
    return withNativeHostOwnershipLock(() => removeNativeMessagingRegistryLocked(expectedManifestPath))
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
}

function removeNativeMessagingRegistryLocked(expectedManifestPath?: string): { ok: boolean; error?: string } {
  if (process.platform !== 'win32') return { ok: true }
  const keys = [chromeRegistryKey(), edgeRegistryKey()]
  const snapshot = snapshotNativeMessagingRegistry()
  const snapshotErrors = keys.flatMap(key => {
    const entry = snapshot[key]
    return entry?.state === 'error' ? [`${key}: ${entry.error}`] : []
  })
  if (snapshotErrors.length) return { ok: false, error: `registry preflight failed: ${snapshotErrors.join('; ')}` }

  const targets = keys.filter(key => {
    const entry = snapshot[key]
    if (entry?.state !== 'present') return false
    return !expectedManifestPath || sameWindowsPath(entry.value, expectedManifestPath)
  })
  const deleted: string[] = []
  for (const key of targets) {
    const previous = snapshot[key]
    if (!previous || previous.state !== 'present') continue
    const result = deleteRegistryKeyIfValueMatches(key, previous.value)
    if (result.state === 'successor' || result.state === 'absent') continue
    if (result.state === 'error') {
      const expectedAbsent = Object.fromEntries(
        deleted.map(deletedKey => [deletedKey, { state: 'absent' as const }]),
      )
      const rollback = restoreNativeMessagingRegistryLocked(Object.fromEntries(
        deleted.map(deletedKey => [deletedKey, snapshot[deletedKey]!]),
      ), expectedAbsent)
      const failure = `${key}: ${result.error}`
      return {
        ok: false,
        error: rollback.ok ? failure : `${failure}; rollback: ${rollback.error}`,
      }
    }
    deleted.push(key)
    const readback = queryNativeMessagingRegistryValue(key)
    // A successor may claim the key immediately after our conditional delete.
    // Preserve that ownership; only an unreadable key or our old value is failure.
    if (readback.state === 'error' || (
      readback.state === 'present'
      && sameWindowsPath(readback.value, previous.value)
    )) {
      const expectedAbsent = Object.fromEntries(
        deleted.map(deletedKey => [deletedKey, { state: 'absent' as const }]),
      )
      const rollback = restoreNativeMessagingRegistryLocked(Object.fromEntries(
        deleted.map(deletedKey => [deletedKey, snapshot[deletedKey]!]),
      ), expectedAbsent)
      const failure = `${key}: registry key still present or unreadable after delete`
      return {
        ok: false,
        error: rollback.ok ? failure : `${failure}; rollback: ${rollback.error}`,
      }
    }
  }
  return { ok: true }
}

function restoreNativeMessagingRegistryLocked(
  values: NativeMessagingRegistrySnapshot,
  expectedCurrent?: NativeMessagingRegistrySnapshot,
): { ok: boolean; error?: string } {
  if (process.platform !== 'win32') return { ok: true }
  const errors: string[] = []
  for (const key of Object.keys(values)) {
    const previous = values[key]
    if (!previous || previous.state === 'error') {
      errors.push(`${key}: invalid rollback snapshot`)
      continue
    }
    const expected = expectedCurrent?.[key]
    const result = restoreRegistryKeyIfValueMatches(key, previous, expected)
    if (result.state === 'error') errors.push(`${key}: ${result.error}`)
  }
  return errors.length ? { ok: false, error: errors.join('; ') } : { ok: true }
}

const systemRegistry: NativeMessagingRegistryAdapter = {
  withExclusive: withNativeHostOwnershipLock,
  verifyStableOwner: verifyCurrentStableOwner,
  // This private adapter is called only inside withExclusive. Public standalone
  // registry APIs acquire their own lease; no process-global reentrancy bypass.
  write: writeNativeMessagingRegistryLocked,
  snapshot: snapshotNativeMessagingRegistry,
  read: readNativeMessagingRegistry,
  remove: removeNativeMessagingRegistryLocked,
  restore: restoreNativeMessagingRegistryLocked,
}

function verifyCurrentStableOwner(installDir: string): { ok: boolean; error?: string } {
  if (process.platform !== 'win32') return { ok: true }
  const script = `$ErrorActionPreference = 'Stop'
$operation = 'VERSTAK_VERIFY_STABLE_OWNER_V1'
$expectedInstallDirBase64 = '${Buffer.from(installDir, 'utf8').toString('base64')}'
try {
  $expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($expectedInstallDirBase64))
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ru.verstak.ide', $false)
  if ($null -eq $key) { throw 'Stable InstallLocation is missing' }
  try { $actual = $key.GetValue('InstallLocation', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
  finally { $key.Dispose() }
  if ($null -eq $actual -or -not [string]::Equals([IO.Path]::GetFullPath([string]$actual).TrimEnd('\\'), [IO.Path]::GetFullPath($expected).TrimEnd('\\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Stable InstallLocation moved or is missing'
  }
  [Console]::Out.Write('OWNED')
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 9
}`
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script),
  ], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000 })
  if (result.status === 0 && String(result.stdout || '').trim() === 'OWNED') return { ok: true }
  return { ok: false, error: String(result.stderr || result.stdout || 'Stable InstallLocation cannot be verified').trim() }
}

/**
 * Windows host.cmd — запускает host.mjs через Electron-as-node
 * (ELECTRON_RUN_AS_NODE=1). Packaged path: resources/browser-bridge → ../../Verstak.exe.
 * Absolute electronExeAbsolute предпочтителен (bake at install) — не зависит от cwd.
 * System node — только dev fallback (allowNodeFallback=true).
 */
export function buildHostCmdContent(opts: {
  hostMjsRelativeToCmd?: string
  /** Absolute path to Verstak.exe / Electron.exe (preferred for install). */
  electronExeAbsolute?: string
  /**
   * Relative to host.cmd directory.
   * Packaged layout: resources/browser-bridge/host.cmd → ../../Verstak.exe
   */
  electronExeRelativeToCmd?: string
  /** Dev-only: fallback to system node if Verstak.exe missing. Packaged = false. */
  allowNodeFallback?: boolean
}): string {
  const hostMjs = opts.hostMjsRelativeToCmd ?? 'host.mjs'
  // Packaged: browser-bridge lives under resources/, exe is two levels up.
  const electronRel = opts.electronExeRelativeToCmd ?? '..\\..\\Verstak.exe'
  const allowNode = opts.allowNodeFallback === true
  const absLine = opts.electronExeAbsolute
    ? `set "ELECTRON_EXE_ABS=${opts.electronExeAbsolute.replace(/\//g, '\\')}"\n`
    : 'set "ELECTRON_EXE_ABS="\n'
  const nodeFallback = allowNode
    ? `where node >nul 2>nul
if %ERRORLEVEL%==0 (
  node "%HOST_JS%"
  exit /b %ERRORLEVEL%
)
`
    : ''
  return `@echo off
setlocal
set "HOST_DIR=%~dp0"
set "HOST_JS=%HOST_DIR%${hostMjs}"
${absLine}if defined ELECTRON_EXE_ABS if exist "%ELECTRON_EXE_ABS%" (
  set ELECTRON_RUN_AS_NODE=1
  "%ELECTRON_EXE_ABS%" "%HOST_JS%"
  exit /b %ERRORLEVEL%
)
set "ELECTRON_EXE=%HOST_DIR%${electronRel}"
if exist "%ELECTRON_EXE%" (
  set ELECTRON_RUN_AS_NODE=1
  "%ELECTRON_EXE%" "%HOST_JS%"
  exit /b %ERRORLEVEL%
)
${nodeFallback}echo Verstak native host: Verstak.exe not found (packaged host must not rely on system Node) 1>&2
exit /b 1
`
}

export interface InstallHostOptions {
  /** Каталог, куда кладём host.cmd + host.mjs + host-manifest.json */
  installDir: string
  /** Содержимое host.mjs (или путь — копируем снаружи). */
  hostScriptSource: string
  /** Absolute path to Verstak.exe / Electron (baked into host.cmd). */
  electronExeAbsolute?: string
  /**
   * Relative electron exe from installDir for host.cmd.
   * Default packaged: ..\\..\\Verstak.exe (resources/browser-bridge → app root).
   */
  electronExeRelative?: string
  /** Dev-only system node fallback. Packaged installs must leave false. */
  allowNodeFallback?: boolean
  /** Если true — перезаписать (upgrade/repair). */
  force?: boolean
  /**
   * Stage host assets without changing browser registry. Used only by the
   * explicitly isolated packaged startup smoke, whose app directory is deleted
   * after the run. Normal startup and Settings keep the default true behavior.
   */
  registerNativeMessaging?: boolean
  /** Exact versions written beside the host and checked during hello. */
  versions: BrowserBridgeVersions
  /** Tests/sandbox only. Production uses the system HKCU adapter. */
  registry?: NativeMessagingRegistryAdapter
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function writeTrackedFile(path: string, contents: string): void {
  // writeFileSync replaces an existing file on Windows. Do not rename a temp
  // over an existing target: renameSync has platform-dependent EEXIST/EPERM
  // behaviour there. The transaction snapshot below restores every prior byte
  // if a later file/registry/readback step fails.
  writeFileSync(path, contents, 'utf8')
}

function snapshotFiles(paths: string[]): Map<string, Buffer | null> {
  return new Map(paths.map(path => [path, existsSync(path) ? readFileSync(path) : null]))
}

function restoreFiles(snapshot: Map<string, Buffer | null>): { ok: boolean; error?: string } {
  const errors: string[] = []
  for (const [path, content] of snapshot) {
    try {
      if (content === null) rmSync(path, { force: true })
      else writeFileSync(path, content)
      const restored = content === null
        ? !existsSync(path)
        : existsSync(path) && readFileSync(path).equals(content)
      if (!restored) errors.push(`${path}: file rollback readback mismatch`)
    } catch (err) {
      errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return errors.length ? { ok: false, error: errors.join('; ') } : { ok: true }
}

function sameVersions(actual: Partial<BrowserBridgeVersions>, expected: BrowserBridgeVersions): boolean {
  return actual.protocolVersion === expected.protocolVersion
    && actual.appVersion === expected.appVersion
    && actual.extensionVersion === expected.extensionVersion
    && actual.hostVersion === expected.hostVersion
}

export function readInstalledMetadata(metadataPath: string): HostMetadata | null {
  try {
    const raw = JSON.parse(readFileSync(metadataPath, 'utf8')) as HostMetadata
    if (
      raw?.schemaVersion !== 1
      || raw.protocolVersion !== BRIDGE_PROTOCOL_VERSION
      || typeof raw.appVersion !== 'string'
      || typeof raw.extensionVersion !== 'string'
      || typeof raw.hostVersion !== 'string'
      || !raw.files
      || typeof raw.files !== 'object'
    ) return null
    return raw
  } catch {
    return null
  }
}

export function validateInstalledHostBundle(
  installDir: string,
  expected: BrowserBridgeVersions,
): { ok: true; metadata: HostMetadata } | { ok: false; reason: string } {
  const metadataPath = join(installDir, NATIVE_HOST_METADATA_FILE)
  const metadata = readInstalledMetadata(metadataPath)
  if (!metadata) return { ok: false, reason: 'host metadata missing or malformed' }
  if (!sameVersions(metadata, expected)) {
    return {
      ok: false,
      reason: `version mismatch app=${metadata.appVersion}, extension=${metadata.extensionVersion}, host=${metadata.hostVersion}, protocol=${metadata.protocolVersion}`,
    }
  }
  const paths = {
    'host.cmd': join(installDir, 'host.cmd'),
    'host.mjs': join(installDir, 'host.mjs'),
    [`${NATIVE_HOST_NAME}.json`]: join(installDir, `${NATIVE_HOST_NAME}.json`),
  }
  for (const [name, path] of Object.entries(paths)) {
    if (!existsSync(path)) return { ok: false, reason: `${name} missing` }
    const expectedHash = metadata.files[name]
    if (!expectedHash || sha256(readFileSync(path)) !== expectedHash) {
      return { ok: false, reason: `${name} hash mismatch` }
    }
  }
  return { ok: true, metadata }
}

/**
 * install/upgrade/repair: пишет assets + HKCU + readback.
 * hostScriptSource — полный текст host.mjs.
 */
export function installNativeHost(opts: InstallHostOptions): HostInstallResult {
  const registry = opts.registry ?? systemRegistry
  try {
    const install = () => {
      if (opts.registerNativeMessaging === true) {
        const stableInstallDir = opts.electronExeAbsolute ? dirname(opts.electronExeAbsolute) : ''
        if (!stableInstallDir) throw new Error('Exact stable executable is required for Native Host registration')
        const ownership = registry.verifyStableOwner?.(stableInstallDir)
        if (ownership && !ownership.ok) throw new Error(ownership.error || 'Stable InstallLocation moved')
      }
      return installNativeHostLocked(opts)
    }
    return opts.registerNativeMessaging === true && registry.withExclusive
      ? registry.withExclusive(install)
      : install()
  } catch (error) {
    return {
      ok: false,
      hostName: NATIVE_HOST_NAME,
      manifestPath: join(opts.installDir, `${NATIVE_HOST_NAME}.json`),
      hostLauncherPath: join(opts.installDir, 'host.cmd'),
      metadataPath: join(opts.installDir, NATIVE_HOST_METADATA_FILE),
      registryKeys: [],
      versions: opts.versions,
      rolledBack: true,
      error: String(error instanceof Error ? error.message : error),
    }
  }
}

function installNativeHostLocked(opts: InstallHostOptions): HostInstallResult {
  const installDir = opts.installDir
  const hostLauncherPath = join(installDir, 'host.cmd')
  const hostMjsPath = join(installDir, 'host.mjs')
  const manifestPath = join(installDir, `${NATIVE_HOST_NAME}.json`)
  const metadataPath = join(installDir, NATIVE_HOST_METADATA_FILE)
  const registry = opts.registry ?? systemRegistry
  const shouldRegister = opts.registerNativeMessaging === true
  let fileSnapshot = new Map<string, Buffer | null>()
  let registrySnapshot: NativeMessagingRegistrySnapshot | null = null
  try {
    mkdirSync(installDir, { recursive: true })
    const trackedPaths = [hostLauncherPath, hostMjsPath, manifestPath, metadataPath]
    fileSnapshot = snapshotFiles(trackedPaths)
    if (shouldRegister) {
      const snapshot = registry.snapshot()
      const snapshotErrors = Object.entries(snapshot).flatMap(([key, entry]) => (
        entry.state === 'error' ? [`${key}: ${entry.error}`] : []
      ))
      if (snapshotErrors.length) {
        throw new Error(`registry snapshot failed: ${snapshotErrors.join('; ')}`)
      }
      registrySnapshot = snapshot
    }

    const launcher = buildHostCmdContent({
      hostMjsRelativeToCmd: 'host.mjs',
      electronExeAbsolute: opts.electronExeAbsolute,
      electronExeRelativeToCmd: opts.electronExeRelative ?? '..\\..\\Verstak.exe',
      allowNodeFallback: opts.allowNodeFallback === true,
    })

    const manifest = buildHostManifest(hostLauncherPath)
    const validated = validateHostManifest(manifest)
    if (!validated.ok) {
      return {
        ok: false,
        hostName: NATIVE_HOST_NAME,
        manifestPath,
        hostLauncherPath,
        metadataPath,
        registryKeys: [],
        versions: opts.versions,
        error: validated.reason,
      }
    }
    const manifestJson = JSON.stringify(validated.manifest, null, 2)
    const metadata: HostMetadata = {
      schemaVersion: 1,
      ...opts.versions,
      files: {
        'host.cmd': sha256(launcher),
        'host.mjs': sha256(opts.hostScriptSource),
        [`${NATIVE_HOST_NAME}.json`]: sha256(manifestJson),
      },
    }
    writeTrackedFile(hostMjsPath, opts.hostScriptSource)
    writeTrackedFile(hostLauncherPath, launcher)
    writeTrackedFile(manifestPath, manifestJson)
    writeTrackedFile(metadataPath, JSON.stringify(metadata, null, 2))

    const reg = shouldRegister
      ? registry.write(manifestPath)
      : { ok: true, keys: [] }
    if (!reg.ok) {
      throw new Error(reg.error || 'native host registry write failed')
    }

    // Readback
    if (shouldRegister && process.platform === 'win32') {
      const values = registry.read()
      for (const key of [chromeRegistryKey(), edgeRegistryKey()]) {
        const registeredManifestPath = values[key]
        if (!registeredManifestPath || !sameWindowsPath(registeredManifestPath, manifestPath)) {
          throw new Error(`registry readback failed: ${JSON.stringify(values)}`)
        }
      }
    }

    return {
      ok: true,
      hostName: NATIVE_HOST_NAME,
      manifestPath,
      hostLauncherPath,
      metadataPath,
      registryKeys: reg.keys,
      versions: opts.versions,
    }
  } catch (err) {
    const fileRollback = restoreFiles(fileSnapshot)
    const expectedCurrent = registrySnapshot
      ? Object.fromEntries(Object.keys(registrySnapshot).map(key => [
          key,
          { state: 'present' as const, value: manifestPath },
        ]))
      : undefined
    const registryRollback = registrySnapshot
      ? registry.restore(registrySnapshot, expectedCurrent)
      : { ok: true }
    const baseError = err instanceof Error ? err.message : String(err)
    const rollbackErrors = [
      fileRollback.ok ? null : `files: ${fileRollback.error}`,
      registryRollback.ok ? null : `registry: ${registryRollback.error}`,
    ].filter(Boolean)
    return {
      ok: false,
      hostName: NATIVE_HOST_NAME,
      manifestPath,
      hostLauncherPath,
      metadataPath,
      registryKeys: [],
      versions: opts.versions,
      rolledBack: fileRollback.ok && registryRollback.ok,
      error: rollbackErrors.length ? `${baseError}; rollback: ${rollbackErrors.join('; ')}` : baseError,
    }
  }
}

/** uninstall cleanup: registry + optional files. */
export function uninstallNativeHost(
  installDir?: string,
  registry: NativeMessagingRegistryAdapter = systemRegistry,
  files: { removeFile(path: string): void } = {
    removeFile: path => rmSync(path, { force: true }),
  },
): { ok: boolean; rolledBack?: boolean; error?: string } {
  try {
    const uninstall = () => uninstallNativeHostLocked(installDir, registry, files)
    return registry.withExclusive ? registry.withExclusive(uninstall) : uninstall()
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
}

function uninstallNativeHostLocked(
  installDir: string | undefined,
  registry: NativeMessagingRegistryAdapter,
  files: { removeFile(path: string): void },
): { ok: boolean; rolledBack?: boolean; error?: string } {
  const expectedManifestPath = installDir
    ? join(installDir, `${NATIVE_HOST_NAME}.json`)
    : undefined
  let registrySnapshot: NativeMessagingRegistrySnapshot
  try {
    registrySnapshot = registry.snapshot()
  } catch (err) {
    return { ok: false, error: `registry snapshot failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  const snapshotErrors = Object.entries(registrySnapshot).flatMap(([key, entry]) => (
    entry.state === 'error' ? [`${key}: ${entry.error}`] : []
  ))
  if (snapshotErrors.length) {
    return { ok: false, error: `registry snapshot failed: ${snapshotErrors.join('; ')}` }
  }
  const expectedAfterRemove: NativeMessagingRegistrySnapshot = Object.fromEntries(
    Object.entries(registrySnapshot).map(([key, entry]) => [
      key,
      expectedManifestPath && entry.state === 'present' && sameWindowsPath(entry.value, expectedManifestPath)
        ? { state: 'absent' as const }
        : entry,
    ]),
  )
  const trackedPaths = installDir
    ? [
        join(installDir, 'host.cmd'),
        join(installDir, 'host.mjs'),
        join(installDir, `${NATIVE_HOST_NAME}.json`),
        join(installDir, NATIVE_HOST_METADATA_FILE),
      ]
    : []
  let fileSnapshot: Map<string, Buffer | null>
  try {
    fileSnapshot = snapshotFiles(trackedPaths)
  } catch (err) {
    return { ok: false, error: `file snapshot failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  const reg = registry.remove(expectedManifestPath)
  if (!reg.ok) return reg
  if (installDir && existsSync(installDir)) {
    try {
      for (const path of trackedPaths) {
        files.removeFile(path)
        if (existsSync(path)) throw new Error(`${path}: file cleanup readback mismatch`)
      }
    } catch (err) {
      // Restore files before making the Native Host discoverable again.
      const fileRollback = restoreFiles(fileSnapshot)
      let registryRollback: { ok: boolean; error?: string }
      try {
        registryRollback = registry.restore(registrySnapshot, expectedAfterRemove)
      } catch (restoreErr) {
        registryRollback = { ok: false, error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr) }
      }
      const cleanupError = err instanceof Error ? err.message : String(err)
      const rollbackErrors = [
        fileRollback.ok ? null : `files: ${fileRollback.error}`,
        registryRollback.ok ? null : `registry: ${registryRollback.error}`,
      ].filter(Boolean)
      return {
        ok: false,
        rolledBack: fileRollback.ok && registryRollback.ok,
        error: rollbackErrors.length
          ? `file cleanup failed: ${cleanupError}; rollback failed: ${rollbackErrors.join('; ')}`
          : `file cleanup failed: ${cleanupError}; rollback completed`,
      }
    }
  }
  return reg
}

/** Для dev: install рядом с userData. */
export function resolveDevHostInstallDir(userData: string): string {
  return join(userData, 'browser-bridge-host')
}

export function readInstalledManifest(manifestPath: string): HostManifest | null {
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const v = validateHostManifest(raw)
    return v.ok ? v.manifest : null
  } catch {
    return null
  }
}

export { EXTENSION_ID, EXTENSION_ORIGIN, NATIVE_HOST_NAME }
