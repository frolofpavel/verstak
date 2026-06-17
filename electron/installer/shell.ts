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

export function setUninstallRegistry(entry: {
  displayName: string
  displayVersion: string
  publisher: string
  installLocation: string
  uninstallString: string
  displayIcon: string
}): void {
  const key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ru.verstak.ide'
  const script = `
New-Item -Path '${psQuote(key)}' -Force | Out-Null
Set-ItemProperty -Path '${psQuote(key)}' -Name DisplayName -Value '${psQuote(entry.displayName)}'
Set-ItemProperty -Path '${psQuote(key)}' -Name DisplayVersion -Value '${psQuote(entry.displayVersion)}'
Set-ItemProperty -Path '${psQuote(key)}' -Name Publisher -Value '${psQuote(entry.publisher)}'
Set-ItemProperty -Path '${psQuote(key)}' -Name InstallLocation -Value '${psQuote(entry.installLocation)}'
Set-ItemProperty -Path '${psQuote(key)}' -Name UninstallString -Value '${psQuote(entry.uninstallString)}'
Set-ItemProperty -Path '${psQuote(key)}' -Name DisplayIcon -Value '${psQuote(entry.displayIcon)}'
Set-ItemProperty -Path '${psQuote(key)}' -Name NoModify -Value 1 -Type DWord
Set-ItemProperty -Path '${psQuote(key)}' -Name NoRepair -Value 1 -Type DWord
`
  runPowerShell(script)
}