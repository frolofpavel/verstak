import { spawnSync } from 'child_process'

/** Закрывает HTA-splash portable-установщика, если он ещё висит. */
export function dismissPortableSplash(): void {
  if (process.platform !== 'win32') return
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-WindowStyle',
      'Hidden',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='mshta.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*portable-splash.hta*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ],
    { windowsHide: true, shell: false },
  )
}

export function psQuote(value: string): string {
  return String(value).replace(/'/g, "''")
}

export function runPowerShell(script: string): string {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', shell: false },
  )
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || '').trim()
    throw new Error(err || `PowerShell exit ${result.status}`)
  }
  return (result.stdout || '').trim()
}

export function createShortcut(lnkPath: string, exePath: string, description = 'VERSTAK'): void {
  const dir = exePath.replace(/\\[^\\]+$/, '')
  const script = `
$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut('${psQuote(lnkPath)}')
$lnk.TargetPath = '${psQuote(exePath)}'
$lnk.WorkingDirectory = '${psQuote(dir)}'
$lnk.IconLocation = '${psQuote(exePath)},0'
$lnk.Description = '${psQuote(description)}'
$lnk.Save()
`
  runPowerShell(script)
}

type UninstallRegistryEntry = {
  displayName: string
  displayVersion: string
  publisher: string
  installLocation: string
  uninstallString: string
  displayIcon: string
}

export function buildUninstallRegistryScript(entry: UninstallRegistryEntry, alreadyHeld = false): string {
  const key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ru.verstak.ide'
  return `
$ErrorActionPreference = 'Stop'
$ownershipMutex = [Threading.Mutex]::new($false, 'Local\\Verstak.StableOwnership.v1')
$ownershipLockAcquired = $false
try {
  try { if (-not $${alreadyHeld}) { $ownershipLockAcquired = $ownershipMutex.WaitOne(15000) } }
  catch [Threading.AbandonedMutexException] { $ownershipLockAcquired = $true }
  if (-not $${alreadyHeld} -and -not $ownershipLockAcquired) { throw 'Stable ownership mutex timeout' }
$expected = @{
  DisplayName = '${psQuote(entry.displayName)}'
  DisplayVersion = '${psQuote(entry.displayVersion)}'
  Publisher = '${psQuote(entry.publisher)}'
  InstallLocation = '${psQuote(entry.installLocation)}'
  UninstallString = '${psQuote(entry.uninstallString)}'
  DisplayIcon = '${psQuote(entry.displayIcon)}'
  NoModify = 1
  NoRepair = 1
}
$beforeExists = Test-Path -LiteralPath '${psQuote(key)}'
$before = @{}
if ($beforeExists) {
  $old = Get-ItemProperty -LiteralPath '${psQuote(key)}'
  $oldKey = Get-Item -LiteralPath '${psQuote(key)}'
  foreach ($name in $expected.Keys) {
    if ($old.PSObject.Properties.Name -contains $name) {
      $before[$name] = @{ Value = $oldKey.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); Kind = [string]$oldKey.GetValueKind($name) }
    }
  }
}
try {
New-Item -Path '${psQuote(key)}' -Force | Out-Null
foreach ($name in $expected.Keys) {
  $kind = if ($name -eq 'NoModify' -or $name -eq 'NoRepair') { 'DWord' } else { 'String' }
  Set-ItemProperty -Path '${psQuote(key)}' -Name $name -Value $expected[$name] -Type $kind
}
$actual = Get-ItemProperty -LiteralPath '${psQuote(key)}'
foreach ($name in $expected.Keys) {
  if ($actual.$name -cne $expected[$name]) { throw "Stable uninstall registry readback mismatch: $name" }
}
} catch {
  $failure = $_.Exception.Message
  try {
    if ($beforeExists) {
      foreach ($name in $expected.Keys) {
        if ($before.ContainsKey($name)) {
          Set-ItemProperty -Path '${psQuote(key)}' -Name $name -Value $before[$name].Value -Type $before[$name].Kind
        } else {
          Remove-ItemProperty -LiteralPath '${psQuote(key)}' -Name $name -ErrorAction SilentlyContinue
        }
      }
      $restored = Get-ItemProperty -LiteralPath '${psQuote(key)}'
      $restoredKey = Get-Item -LiteralPath '${psQuote(key)}'
      foreach ($name in $expected.Keys) {
        if ($before.ContainsKey($name)) {
          $restoredValue = $restoredKey.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
          if ($restoredValue -cne $before[$name].Value -or [string]$restoredKey.GetValueKind($name) -cne $before[$name].Kind) {
            throw "Stable uninstall rollback readback mismatch: $name"
          }
        } elseif ($restored.PSObject.Properties.Name -contains $name) { throw "Stable uninstall rollback unexpected value: $name" }
      }
    } else {
      Remove-Item -LiteralPath '${psQuote(key)}' -Recurse -Force -ErrorAction Stop
      if (Test-Path -LiteralPath '${psQuote(key)}') { throw 'Stable uninstall rollback key still present' }
    }
  } catch { throw "$failure; registry rollback failed: $($_.Exception.Message)" }
  throw "$failure; registry rollback completed"
}
} finally {
  if ($ownershipLockAcquired) { $ownershipMutex.ReleaseMutex() }
  $ownershipMutex.Dispose()
}
`
}

export function setUninstallRegistry(entry: UninstallRegistryEntry, alreadyHeld = false): void {
  runPowerShell(buildUninstallRegistryScript(entry, alreadyHeld))
}
