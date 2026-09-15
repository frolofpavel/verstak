import { existsSync } from 'fs'
import { dirname, join, relative } from 'path'
import { nativeFsPromises } from './native-fs'
import {
  NATIVE_HOST_OWNER_MARKER,
  nativeHostOwnerMarker,
} from '../../shared/contracts/native-host-owner'

const { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } = nativeFsPromises

const STALE_UNPACKED = join('resources', 'app.asar.unpacked')

async function removeStaleUnpacked(installDir: string): Promise<void> {
  const unpacked = join(installDir, STALE_UNPACKED)
  await rm(unpacked, { recursive: true, force: true }).catch(() => {})
}
import { homedir } from 'os'
import type { InstallDefaults, InstallProgress, InstallResult } from './types'
import { detectRunningInstall, probeLock, RUNNING_INSTALL_MESSAGE, type LockProbe } from './running-check'
import { createShortcut, psQuote, runPowerShell, setUninstallRegistry } from './shell'
import { acquireNativeHostOwnershipLease } from '../ai/browser/bridge/host-lifecycle'
import {
  defaultInstallDir,
  installedExePath,
  resolvePayloadRoot,
  uninstallScriptName,
} from './paths'

type FileEntry = { abs: string; rel: string; size: number }

async function walkFiles(root: string, dir = root): Promise<FileEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: FileEntry[] = []
  for (const entry of entries) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...await walkFiles(root, abs))
    } else if (entry.isFile()) {
      const st = await stat(abs)
      out.push({ abs, rel: relative(root, abs), size: st.size })
    }
  }
  return out
}

export async function collectPayloadStats(payloadRoot: string): Promise<{ fileCount: number; payloadBytes: number }> {
  const files = await walkFiles(payloadRoot)
  return {
    fileCount: files.length,
    payloadBytes: files.reduce((sum, f) => sum + f.size, 0),
  }
}

async function readPayloadManifest(payloadRoot: string): Promise<{ fileCount: number; payloadBytes: number } | null> {
  try {
    const raw = await readFile(join(payloadRoot, 'payload-manifest.json'), 'utf8')
    const parsed = JSON.parse(raw) as { fileCount?: number; payloadBytes?: number }
    if (typeof parsed.fileCount === 'number' && typeof parsed.payloadBytes === 'number') {
      return { fileCount: parsed.fileCount, payloadBytes: parsed.payloadBytes }
    }
  } catch {
    // fall back to directory walk
  }
  return null
}

async function readPackagedPayloadManifest(): Promise<{ fileCount: number; payloadBytes: number } | null> {
  const candidates = [
    join(process.resourcesPath, 'app-payload-manifest.json'),
    join(process.cwd(), 'release', 'app-payload-manifest.json'),
    join(process.cwd(), 'release', 'app-payload-staging', 'payload-manifest.json'),
  ]
  for (const manifestPath of candidates) {
    if (!existsSync(manifestPath)) continue
    try {
      const raw = await readFile(manifestPath, 'utf8')
      const parsed = JSON.parse(raw) as { fileCount?: number; payloadBytes?: number }
      if (typeof parsed.fileCount === 'number' && typeof parsed.payloadBytes === 'number') {
        return { fileCount: parsed.fileCount, payloadBytes: parsed.payloadBytes }
      }
    } catch {
      // try next candidate
    }
  }
  return null
}

export async function getInstallDefaults(version: string, productName: string): Promise<InstallDefaults> {
  const packagedManifest = await readPackagedPayloadManifest()
  let stats = packagedManifest
  if (!stats) {
    const payloadRoot = resolvePayloadRoot()
    stats = (await readPayloadManifest(payloadRoot)) ?? await collectPayloadStats(payloadRoot)
  }
  return {
    version,
    productName,
    defaultInstallDir: defaultInstallDir(),
    ...stats,
  }
}

function emit(
  onProgress: (p: InstallProgress) => void,
  partial: Partial<InstallProgress> & Pick<InstallProgress, 'phase'>,
  filesDone: number,
  filesTotal: number,
  bytesDone: number,
  bytesTotal: number,
  currentFile: string,
): void {
  const percent = bytesTotal > 0 ? Math.min(100, Math.round((bytesDone / bytesTotal) * 100)) : 0
  onProgress({
    filesDone,
    filesTotal,
    bytesDone,
    bytesTotal,
    currentFile,
    percent,
    ...partial,
  })
}

/** Суффикс отложенной прежней версии файла. Живёт только внутри одной установки. */
export const INSTALL_BACKUP_SUFFIX = '.verstak-bak'

/**
 * Что установка успела сделать с папкой — чтобы откат ВОССТАНОВИЛ, а не стёр.
 * `replaced` — файлы, у которых прежняя версия отложена под .verstak-bak;
 * `created` — файлов раньше не было, при откате их достаточно убрать.
 */
export type InstallLedger = { replaced: string[]; created: string[] }

export function newInstallLedger(): InstallLedger {
  return { replaced: [], created: [] }
}

export async function copyPayload(
  payloadRoot: string,
  installDir: string,
  onProgress: (p: InstallProgress) => void,
  ledger: InstallLedger,
): Promise<void> {
  const files = await walkFiles(payloadRoot)
  const bytesTotal = files.reduce((sum, f) => sum + f.size, 0)
  let bytesDone = 0

  emit(onProgress, { phase: 'copying' }, 0, files.length, 0, bytesTotal, '')

  await mkdir(installDir, { recursive: true })

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const target = join(installDir, file.rel)
    await mkdir(dirname(target), { recursive: true })
    // Прежняя версия не затирается, а ОТКЛАДЫВАЕТСЯ: переименование внутри той
    // же папки — операция над метаданными, копирования 860 МБ не добавляет.
    if (existsSync(target)) {
      const backup = `${target}${INSTALL_BACKUP_SUFFIX}`
      await rm(backup, { force: true }).catch(() => {})
      await rename(target, backup)
      ledger.replaced.push(file.rel)
    } else {
      ledger.created.push(file.rel)
    }
    await cp(file.abs, target, { force: true })
    bytesDone += file.size
    emit(onProgress, { phase: 'copying' }, i + 1, files.length, bytesDone, bytesTotal, file.rel)
  }
}

/** Установка удалась — отложенные копии больше не нужны. */
export async function commitInstall(installDir: string, ledger: InstallLedger): Promise<void> {
  for (const rel of ledger.replaced) {
    await rm(join(installDir, `${rel}${INSTALL_BACKUP_SUFFIX}`), { force: true }).catch(() => {})
  }
}

export function buildUninstallScript(installDir: string): string {
  const desktop = join(homedir(), 'Desktop', 'Verstak.lnk')
  const startMenu = join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Verstak.lnk')
  return `# Verstak uninstall helper
$ErrorActionPreference = 'Stop'
$dir = '${psQuote(installDir)}'
$ownedNativeHostManifest = [IO.Path]::GetFullPath((Join-Path $dir 'resources\\browser-bridge\\ru.verstak.browser_bridge.json'))
$shortcuts = @(
  '${psQuote(desktop)}',
  '${psQuote(startMenu)}'
)
# EXT-B1 Connected Eyes: compare-and-delete. An old uninstaller must not remove
# a registry value already transferred to a newer/different stable install.
$nativeHostKeys = @(
  [PSCustomObject]@{ Key = 'HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\ru.verstak.browser_bridge'; SubKey = 'Software\\Google\\Chrome\\NativeMessagingHosts\\ru.verstak.browser_bridge' },
  [PSCustomObject]@{ Key = 'HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\ru.verstak.browser_bridge'; SubKey = 'Software\\Microsoft\\Edge\\NativeMessagingHosts\\ru.verstak.browser_bridge' }
)

function Test-VerstakNativeHostPathEqual {
  param([string]$Left, [string]$Right)
  if (-not $Left -or -not $Right) { return $false }
  try {
    return [string]::Equals([IO.Path]::GetFullPath($Left), [IO.Path]::GetFullPath($Right), [StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

# These function guards let the production-shaped test harness replace only
# the registry transport. Production always uses one writable parent key for
# compare + delete and one writable child key for compare + restore + readback.
if (-not (Get-Command -Name Get-VerstakNativeHostSnapshot -CommandType Function -ErrorAction SilentlyContinue)) {
  function Get-VerstakNativeHostSnapshot {
    param([string]$SubKeyPath)
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKeyPath, $false)
    if ($null -eq $key) { return [PSCustomObject]@{ State = 'absent'; Value = $null } }
    try {
      $value = $key.GetValue($null, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if ($null -eq $value) { return [PSCustomObject]@{ State = 'absent'; Value = $null } }
      return [PSCustomObject]@{ State = 'present'; Value = [string]$value }
    } finally {
      $key.Dispose()
    }
  }
}

if (-not (Get-Command -Name Remove-VerstakNativeHostIfOwned -CommandType Function -ErrorAction SilentlyContinue)) {
  function Remove-VerstakNativeHostIfOwned {
    param([string]$SubKeyPath, [string]$ExpectedValue)
    $operation = 'VERSTAK_NATIVE_HOST_DELETE_IF_MATCH_V2'
    $slash = $SubKeyPath.LastIndexOf('\\')
    if ($slash -lt 1) { throw 'Native Host registry key has no parent' }
    $parentPath = $SubKeyPath.Substring(0, $slash)
    $leaf = $SubKeyPath.Substring($slash + 1)
    $parent = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($parentPath, $true)
    if ($null -eq $parent) { return [PSCustomObject]@{ State = 'absent'; Value = $null } }
    try {
      $currentKey = $parent.OpenSubKey($leaf, $false)
      if ($null -eq $currentKey) { return [PSCustomObject]@{ State = 'absent'; Value = $null } }
      try {
        $current = $currentKey.GetValue($null, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      } finally {
        $currentKey.Dispose()
      }
      if ($null -eq $current) { return [PSCustomObject]@{ State = 'absent'; Value = $null } }
      if (-not (Test-VerstakNativeHostPathEqual ([string]$current) $ExpectedValue)) {
        return [PSCustomObject]@{ State = 'successor'; Value = [string]$current }
      }
      # Compare and delete are performed through the same writable parent
      # RegistryKey. No provider-level Test-Path/Get-Item/Remove-Item split.
      $parent.DeleteSubKeyTree($leaf, $false)
      $afterKey = $parent.OpenSubKey($leaf, $false)
      if ($null -eq $afterKey) { return [PSCustomObject]@{ State = 'deleted'; Value = $null } }
      try {
        $after = $afterKey.GetValue($null, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      } finally {
        $afterKey.Dispose()
      }
      if ($null -ne $after -and -not (Test-VerstakNativeHostPathEqual ([string]$after) $ExpectedValue)) {
        return [PSCustomObject]@{ State = 'successor'; Value = [string]$after }
      }
      throw "Native Host registry key still exists after delete: $SubKeyPath"
    } finally {
      $parent.Dispose()
    }
  }
}

if (-not (Get-Command -Name Restore-VerstakNativeHostIfUnchanged -CommandType Function -ErrorAction SilentlyContinue)) {
  function Restore-VerstakNativeHostIfUnchanged {
    param([string]$SubKeyPath, [string]$ExpectedState, [string]$ExpectedValue, [string]$PreviousValue)
    $operation = 'VERSTAK_NATIVE_HOST_RESTORE_IF_UNCHANGED_V2'
    $slash = $SubKeyPath.LastIndexOf('\\')
    if ($slash -lt 1) { throw 'Native Host registry key has no parent' }
    $parentPath = $SubKeyPath.Substring(0, $slash)
    $leaf = $SubKeyPath.Substring($slash + 1)
    $parent = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($parentPath, $true)
    if ($null -eq $parent -and $ExpectedState -eq 'absent') {
      $parent = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($parentPath)
    }
    if ($null -eq $parent) { return [PSCustomObject]@{ State = 'successor'; Value = $null } }
    try {
      # Open the child writable once. The expected-current comparison, write,
      # flush and readback all happen on this same RegistryKey handle.
      $currentKey = $parent.OpenSubKey($leaf, $true)
      $current = if ($null -eq $currentKey) {
        $null
      } else {
        $currentKey.GetValue($null, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      }
      $matchesExpected = ($ExpectedState -eq 'absent' -and $null -eq $current) -or (
        $ExpectedState -eq 'present' -and $null -ne $current -and (Test-VerstakNativeHostPathEqual ([string]$current) $ExpectedValue)
      )
      if (-not $matchesExpected) {
        if ($null -ne $currentKey) { $currentKey.Dispose() }
        $successorValue = if ($null -eq $current) { $null } else { [string]$current }
        return [PSCustomObject]@{ State = 'successor'; Value = $successorValue }
      }
      if ($null -eq $currentKey) {
        $currentKey = $parent.CreateSubKey($leaf)
        $racedValue = $currentKey.GetValue($null, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -ne $racedValue) {
          $currentKey.Dispose()
          return [PSCustomObject]@{ State = 'successor'; Value = [string]$racedValue }
        }
      }
      try {
        $currentKey.SetValue($null, $PreviousValue, [Microsoft.Win32.RegistryValueKind]::String)
        $currentKey.Flush()
        $restored = $currentKey.GetValue($null, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -eq $restored -or -not (Test-VerstakNativeHostPathEqual ([string]$restored) $PreviousValue)) {
          throw "Native Host registry rollback readback mismatch: $SubKeyPath"
        }
      } finally {
        $currentKey.Dispose()
      }
      return [PSCustomObject]@{ State = 'restored'; Value = $PreviousValue }
    } finally {
      $parent.Dispose()
    }
  }
}


if (-not (Get-Command -Name Get-VerstakInstallLocation -CommandType Function -ErrorAction SilentlyContinue)) {
  function Get-VerstakInstallLocation {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ru.verstak.ide', $false)
    if ($null -eq $key) { return $null }
    try {
      return $key.GetValue('InstallLocation', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    } finally { $key.Dispose() }
  }
}
if (-not (Get-Command -Name Remove-VerstakInstallRegistrationIfOwned -CommandType Function -ErrorAction SilentlyContinue)) {
  function Remove-VerstakInstallRegistrationIfOwned {
    param([string]$ExpectedDir)
    $parent = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', $true)
    if ($null -eq $parent) { return $false }
    try {
      $key = $parent.OpenSubKey('ru.verstak.ide', $false)
      if ($null -eq $key) { return $false }
      try {
        $current = $key.GetValue('InstallLocation', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      } finally { $key.Dispose() }
      if (-not [string]::Equals([string]$current, $ExpectedDir, [StringComparison]::OrdinalIgnoreCase)) { return $false }
      $parent.DeleteSubKeyTree('ru.verstak.ide', $false)
      $after = $parent.OpenSubKey('ru.verstak.ide', $false)
      if ($null -ne $after) {
        $after.Dispose()
        throw 'Stable uninstall registry deletion readback mismatch'
      }
      return $true
    } finally { $parent.Dispose() }
  }
}
$ownershipMutex = [Threading.Mutex]::new($false, 'Local\\Verstak.StableOwnership.v1')
$ownershipLockAcquired = $false
try {
  try { $ownershipLockAcquired = $ownershipMutex.WaitOne(15000) }
  catch [Threading.AbandonedMutexException] { $ownershipLockAcquired = $true }
  if (-not $ownershipLockAcquired) { throw 'Stable ownership mutex timeout' }
  $currentInstallLocation = Get-VerstakInstallLocation
  if (-not [string]::Equals([string]$currentInstallLocation, $dir, [StringComparison]::OrdinalIgnoreCase)) { return }

$nativeHostOwnership = @()
$nativeHostPreflightErrors = @()
foreach ($keySpec in $nativeHostKeys) {
  try {
    $snapshot = Get-VerstakNativeHostSnapshot $keySpec.SubKey
    if ($snapshot.State -eq 'present' -and (Test-VerstakNativeHostPathEqual ([string]$snapshot.Value) $ownedNativeHostManifest)) {
      $nativeHostOwnership += [PSCustomObject]@{ Key = $keySpec.Key; SubKey = $keySpec.SubKey; Value = [string]$snapshot.Value }
    }
  } catch {
    $nativeHostPreflightErrors += "$($keySpec.Key): $($_.Exception.Message)"
  }
}
if ($nativeHostPreflightErrors.Count -gt 0) {
  throw "Native Host cleanup preflight failed: $($nativeHostPreflightErrors -join '; ')"
}

$deletedNativeHostKeys = @()
try {
  foreach ($entry in $nativeHostOwnership) {
    $deleteResult = Remove-VerstakNativeHostIfOwned $entry.SubKey $entry.Value
    if ($deleteResult.State -eq 'deleted') {
      $deletedNativeHostKeys += $entry
    } elseif ($deleteResult.State -ne 'absent' -and $deleteResult.State -ne 'successor') {
      throw "Native Host registry key still exists after delete: $($entry.Key)"
    }
  }

  # File cleanup is part of the same Native Host transaction. If it fails while
  # the owned manifest still exists, restore registry ownership with CAS.
  foreach ($lnk in $shortcuts) {
    if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force -ErrorAction Stop }
  }
  if (Test-Path -LiteralPath $dir) {
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop
  }
} catch {
  $nativeHostCleanupFailure = $_.Exception.Message
  $nativeHostRollbackErrors = @()
  if (-not (Test-Path -LiteralPath $ownedNativeHostManifest)) {
    $nativeHostRollbackErrors += 'owned Native Host manifest is missing; registry rollback would be unsafe'
  } else {
    foreach ($entry in $deletedNativeHostKeys) {
      try {
        $restoreResult = Restore-VerstakNativeHostIfUnchanged $entry.SubKey 'absent' $null $entry.Value
        if ($restoreResult.State -ne 'restored' -and $restoreResult.State -ne 'already' -and $restoreResult.State -ne 'successor') {
          throw "Native Host registry rollback readback mismatch: $($entry.Key)"
        }
      } catch {
        $nativeHostRollbackErrors += "$($entry.Key): $($_.Exception.Message)"
      }
    }
  }
  if ($nativeHostRollbackErrors.Count -gt 0) {
    throw "Native Host cleanup failed: $nativeHostCleanupFailure; rollback failed: $($nativeHostRollbackErrors -join '; ')"
  }
  throw "Native Host cleanup failed: $nativeHostCleanupFailure; registry rollback completed"
}

Remove-VerstakInstallRegistrationIfOwned $dir | Out-Null
} finally {
  if ($ownershipLockAcquired) { $ownershipMutex.ReleaseMutex() }
  $ownershipMutex.Dispose()
}
`
}

async function writeUninstaller(installDir: string, ledger: InstallLedger): Promise<string> {
  const rel = uninstallScriptName()
  const scriptPath = join(installDir, rel)
  // Тем же порядком, что и payload: прежний скрипт откладывается, а не теряется —
  // иначе откат обновления оставил бы рабочую установку без своего деинсталлятора.
  if (existsSync(scriptPath)) {
    const backup = `${scriptPath}${INSTALL_BACKUP_SUFFIX}`
    await rm(backup, { force: true }).catch(() => {})
    await rename(scriptPath, backup)
    ledger.replaced.push(rel)
  } else {
    ledger.created.push(rel)
  }
  await writeFile(scriptPath, buildUninstallScript(installDir), 'utf8')
  return scriptPath
}

async function writeNativeHostOwnerMarker(
  installDir: string,
  version: string,
  ledger: InstallLedger,
): Promise<void> {
  const path = join(installDir, NATIVE_HOST_OWNER_MARKER)
  if (existsSync(path)) {
    const backup = `${path}${INSTALL_BACKUP_SUFFIX}`
    await rm(backup, { force: true }).catch(() => {})
    await rename(path, backup)
    ledger.replaced.push(NATIVE_HOST_OWNER_MARKER)
  } else {
    ledger.created.push(NATIVE_HOST_OWNER_MARKER)
  }
  await writeFile(
    path,
    JSON.stringify(nativeHostOwnerMarker(version, installDir, installedExePath(installDir)), null, 2),
    'utf8',
  )
}

async function createShortcuts(installDir: string): Promise<void> {
  const exe = installedExePath(installDir)
  const shortcuts = [
    join(homedir(), 'Desktop', 'Verstak.lnk'),
    join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Verstak.lnk'),
  ]
  for (const lnk of shortcuts) {
    await mkdir(dirname(lnk), { recursive: true })
    createShortcut(lnk, exe)
  }
}

/** Папку безопасно стереть целиком при откате ТОЛЬКО если установщик её создал
 *  (не существовала) или она была ПУСТА. Иначе (обновление поверх старой версии
 *  или пользователь выбрал папку с личными файлами) — трогать чужое нельзя (B1). */
export async function dirIsOursToWipe(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir)
    return entries.length === 0
  } catch {
    return true // папки нет — создаст установщик, при откате можно убрать
  }
}

/**
 * Откат установки.
 *
 * ownDir → папку завёл сам установщик (не было или была пуста), терять нечего —
 * убираем целиком. Иначе (обновление поверх рабочей версии) откат ВОССТАНАВЛИВАЕТ
 * прежние файлы из отложенных копий и убирает только дописанное.
 *
 * Прежний контракт — «откат удаляет записанные payload-файлы» — ОТМЕНЁН
 * (враждебное ревью 2.6.4 §1): payload-файлы и есть вся установка, поэтому
 * такое удаление означало «снести рабочее приложение при сбое». Замер по живому
 * стенду: 22 записи в каталоге → 11, `locales/` пуст, приложение не стартует
 * вообще. Удаление рабочей установки при сбое запрещено в любом случае.
 */
export async function rollbackInstall(
  installDir: string,
  ledger: InstallLedger,
  ownDir: boolean,
): Promise<void> {
  if (ownDir) {
    await rm(installDir, { recursive: true, force: true })
    return
  }
  for (const rel of ledger.created) {
    await rm(join(installDir, rel), { force: true }).catch(() => {})
  }
  for (const rel of ledger.replaced) {
    const target = join(installDir, rel)
    // rename на Windows идёт через MoveFileEx(REPLACE_EXISTING) — недописанная
    // новая версия перекрывается прежней одним движением.
    await rename(`${target}${INSTALL_BACKUP_SUFFIX}`, target).catch(() => {})
  }
}

type InstallDependencies = {
  acquireOwnershipLease?: typeof acquireNativeHostOwnershipLease
  probeLock?: LockProbe
  payloadRoot?: string
  createShortcuts?: typeof createShortcuts
  setUninstallRegistry?: typeof setUninstallRegistry
}

export async function runInstall(installDir: string, version: string,
  onProgress: (p: InstallProgress) => void, deps: InstallDependencies = {}): Promise<InstallResult> {
  let lease: ReturnType<typeof acquireNativeHostOwnershipLease> | undefined
  try {
    lease = (deps.acquireOwnershipLease ?? acquireNativeHostOwnershipLease)()
    return await runInstallLocked(installDir, version, onProgress, deps)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    lease?.release()
  }
}

async function runInstallLocked(
  installDir: string,
  version: string,
  onProgress: (p: InstallProgress) => void,
  deps: InstallDependencies,
): Promise<InstallResult> {
  const normalized = installDir.trim()
  if (!normalized) return { ok: false, error: 'Укажите папку установки.' }
  // §1 ревью 2.6.4: отказ ДО первой записи. Установка поверх работающей копии
  // упирается в залоченный файл на середине — и до этой проверки доламывала то,
  // что ещё работало. Ничего не тронуто → откатывать нечего.
  if (await detectRunningInstall(normalized, deps.probeLock ?? probeLock)) {
    return { ok: false, error: RUNNING_INSTALL_MESSAGE }
  }
  // B1: фиксируем ДО любых записей, можно ли при откате стирать папку целиком —
  // иначе сбой копирования в существующую непустую папку удалял бы чужие данные.
  const ownDir = await dirIsOursToWipe(normalized)
  const ledger = newInstallLedger()
  let payloadRoot = ''
  try {
    emit(onProgress, { phase: 'preparing' }, 0, 0, 0, 0, '')
    payloadRoot = deps.payloadRoot ?? resolvePayloadRoot()

    await removeStaleUnpacked(normalized)
    await copyPayload(payloadRoot, normalized, onProgress, ledger)
    // Only the real installer writes this marker. win-unpacked and Portable do
    // not get ordinary HKCU NativeMessagingHosts ownership merely by launching.
    await writeNativeHostOwnerMarker(normalized, version, ledger)

    emit(onProgress, { phase: 'shortcuts' }, 0, 0, 0, 0, '')
    await (deps.createShortcuts ?? createShortcuts)(normalized)

    const uninstallPs1 = await writeUninstaller(normalized, ledger)
    const exe = installedExePath(normalized)
    const uninstallString = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${uninstallPs1}"`

    emit(onProgress, { phase: 'registry' }, 0, 0, 0, 0, '')
    const writeRegistry = deps.setUninstallRegistry ?? setUninstallRegistry
    writeRegistry({
      displayName: 'Verstak',
      displayVersion: version,
      publisher: 'Pavel Frolov',
      installLocation: normalized,
      uninstallString,
      displayIcon: `${exe},0`,
    }, true)

    await commitInstall(normalized, ledger)
    // Backups are gone: a closed renderer cannot turn a committed install into
    // rollback. Terminal notification is best-effort after the commit boundary.
    try { emit(onProgress, { phase: 'done', percent: 100 }, 0, 0, 0, 0, '') } catch { /* committed */ }
    return { ok: true, installDir: normalized }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    try {
      await rollbackInstall(normalized, ledger, ownDir)
    } catch {
      // ignore cleanup errors
    }
    return { ok: false, error: message }
  }
}

export function launchInstalledApp(installDir: string): void {
  const exe = installedExePath(installDir)
  runPowerShell(`Start-Process -FilePath '${psQuote(exe)}'`)
}
