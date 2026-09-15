import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { buildUninstallScript, dirIsOursToWipe, newInstallLedger, rollbackInstall, runInstall } from '../electron/installer/engine'
import * as shell from '../electron/installer/shell'
import { acquireNativeHostOwnershipLease } from '../electron/ai/browser/bridge/host-lifecycle'
import { randomUUID } from 'node:crypto'

// A second process cannot acquire the lock while a production registry transport
// runs. This catches moving WaitOne outside the write/delete critical section.
const assertOwnershipMutexHeld = `
function Assert-OwnershipMutexHeld {
  $probe = '$m = [Threading.Mutex]::new($false, "Local\\Verstak.StableOwnership.v1"); try { if ($m.WaitOne(0)) { $m.ReleaseMutex(); exit 7 }; exit 0 } finally { $m.Dispose() }'
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probe))
  & powershell.exe -NoProfile -NonInteractive -EncodedCommand $encoded
  if ($LASTEXITCODE -ne 0) { throw 'Registry operation ran without ownership mutex' }
}
`

/**
 * B1: runInstall при ЛЮБОЙ ошибке делал rm(installDir, recursive, force) —
 * стирал ВСЮ выбранную папку, включая чужие/старые файлы (обновление поверх
 * установки или выбор папки с личными файлами + сбой копирования = потеря данных).
 * Откат теперь убирает только то, что записал сам установщик.
 */
describe('installer rollback (B1: не теряем чужие файлы при сбое)', () => {
  let base: string
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'gg-inst-')) })
  afterEach(() => { rmSync(base, { recursive: true, force: true }) })

  it('dirIsOursToWipe: пустая → true, непустая → false, несуществующая → true', async () => {
    const empty = join(base, 'empty'); mkdirSync(empty)
    const full = join(base, 'full'); mkdirSync(full); writeFileSync(join(full, 'x.txt'), 'x')
    expect(await dirIsOursToWipe(empty)).toBe(true)
    expect(await dirIsOursToWipe(full)).toBe(false)
    expect(await dirIsOursToWipe(join(base, 'nope'))).toBe(true)
  })

  /**
   * Утверждение «откат УДАЛЯЕТ записанные payload-файлы» здесь стояло до 16.08 и
   * стерегло контракт, отменённый враждебным ревью §1: payload-файлы и есть вся
   * установка, поэтому их удаление означало «снести рабочее приложение при сбое».
   * Что осталось верным и проверяется по-прежнему — чужие файлы откат не трогает;
   * восстановление прежних версий стережёт tests/installer/install-guard.test.ts.
   */
  it('ownDir=false: откат убирает дописанное, СОХРАНЯЯ чужие файлы', async () => {
    const installDir = join(base, 'install'); mkdirSync(installDir)
    writeFileSync(join(installDir, 'sentinel.txt'), 'МОИ ДАННЫЕ') // чужой файл
    writeFileSync(join(installDir, 'a.txt'), 'a')                 // дописан установкой

    const ledger = newInstallLedger()
    ledger.created.push('a.txt')
    await rollbackInstall(installDir, ledger, false)

    expect(existsSync(join(installDir, 'sentinel.txt'))).toBe(true) // сохранён
    expect(existsSync(join(installDir, 'a.txt'))).toBe(false)       // дописанное убрано
  })

  it('ownDir=true: откат убирает папку целиком', async () => {
    const installDir = join(base, 'owned'); mkdirSync(installDir)
    writeFileSync(join(installDir, 'a.txt'), 'a')
    await rollbackInstall(installDir, newInstallLedger(), true)
    expect(existsSync(installDir)).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('installer keeps destructive uninstall out from payload copy through registry failure and rollback', async () => {
    const mutexName = `Local\\Verstak.InstallerTest.${randomUUID()}`
    const installDir = join(base, 'install'); mkdirSync(installDir)
    const sentinel = join(installDir, 'sentinel.txt'); writeFileSync(sentinel, 'old')
    const payload = join(base, 'payload'); mkdirSync(payload)
    writeFileSync(join(payload, 'new.txt'), 'new')
    const observations: number[] = []
    const contend = () => {
      const probe = `$m = [Threading.Mutex]::new($false, '${mutexName}')
$owned = $false
try { $owned = $m.WaitOne(0); if ($owned) { Remove-Item -LiteralPath '${sentinel}' -Force; exit 7 }; exit 0 }
finally { if ($owned) { $m.ReleaseMutex() }; $m.Dispose() }`
      observations.push(spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probe],
        { encoding: 'utf8', windowsHide: true }).status ?? -1)
    }
    const result = await runInstall(installDir, '2.8.2', event => {
      if (event.phase === 'preparing' || event.phase === 'registry') contend()
    }, {
      probeLock: async () => 'free', payloadRoot: payload,
      acquireOwnershipLease: () => acquireNativeHostOwnershipLease({ mutexName }),
      createShortcuts: async () => undefined,
      setUninstallRegistry: () => { contend(); throw new Error('injected registry failure') },
    } as Parameters<typeof runInstall>[3])
    expect(observations).toEqual([0, 0, 0])
    expect(result).toMatchObject({ ok: false, error: 'injected registry failure' })
    expect(readFileSync(sentinel, 'utf8')).toBe('old')
    expect(existsSync(join(installDir, 'new.txt'))).toBe(false)
    contend()
    expect(observations.at(-1)).toBe(7)
  }, 60_000)

  it('terminal progress failure cannot roll back a committed install', async () => {
    const installDir = join(base, 'completed'); mkdirSync(installDir)
    const payload = join(base, 'payload'); mkdirSync(payload)
    writeFileSync(join(payload, 'installed.txt'), 'committed target')
    const result = await runInstall(installDir, '2.8.2', event => {
      if (event.phase === 'done') throw new Error('renderer closed after commit')
    }, {
      probeLock: async () => 'free', payloadRoot: payload,
      acquireOwnershipLease: () => acquireNativeHostOwnershipLease({ mutexName: `Local\\Verstak.TerminalTest.${randomUUID()}` }),
      createShortcuts: async () => undefined,
      setUninstallRegistry: () => undefined,
    })
    expect(result).toMatchObject({ ok: true, installDir })
    expect(readFileSync(join(installDir, 'installed.txt'), 'utf8')).toBe('committed target')
  }, 30_000)

  it('uninstaller compare-and-deletes only its own Native Host manifest path', () => {
    const script = buildUninstallScript('C:\\Apps\\Verstak-old')
    expect(script).toContain('GetValue($null')
    expect(script).toContain("$dir = 'C:\\Apps\\Verstak-old'")
    expect(script).toContain("Join-Path $dir 'resources\\browser-bridge\\ru.verstak.browser_bridge.json'")
    expect(script).toContain('$nativeHostPreflightErrors = @()')
    expect(script).toContain('$deletedNativeHostKeys = @()')
    expect(script).toContain('VERSTAK_NATIVE_HOST_DELETE_IF_MATCH_V2')
    expect(script).toContain('VERSTAK_NATIVE_HOST_RESTORE_IF_UNCHANGED_V2')
    expect(script).toContain('[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($parentPath, $true)')
    expect(script).toContain('$parent.DeleteSubKeyTree($leaf, $false)')
    expect(script).toContain('$currentKey.SetValue($null, $PreviousValue')
    expect(script).toContain('$currentKey.Flush()')
    expect(script).toContain('$restored = $currentKey.GetValue')
    expect(script).toContain('Native Host registry key still exists after delete')
    expect(script).toContain('throw "Native Host cleanup failed:')
    expect(script).toContain('registry rollback completed')
    expect(script).toContain('owned Native Host manifest is missing; registry rollback would be unsafe')
    const preflight = script.indexOf('$nativeHostOwnership = @()')
    const registryDelete = script.indexOf('$deleteResult = Remove-VerstakNativeHostIfOwned')
    const shortcutDelete = script.indexOf('Remove-Item -LiteralPath $lnk')
    const installDirDelete = script.indexOf('Remove-Item -LiteralPath $dir')
    expect(preflight).toBeGreaterThan(-1)
    expect(registryDelete).toBeGreaterThan(preflight)
    expect(shortcutDelete).toBeGreaterThan(registryDelete)
    expect(installDirDelete).toBeGreaterThan(registryDelete)
    expect(script).not.toContain('Remove-Item -LiteralPath $entry.Key')
    expect(script).not.toContain('Set-Item -LiteralPath $entry.Key -Value $entry.Value')
    expect(script).not.toContain(
      "Remove-Item -Path 'HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\ru.verstak.browser_bridge'",
    )
  })

  it.skipIf(process.platform !== 'win32')('uninstaller serializes ownership and preserves a successor install', () => {
    const script = buildUninstallScript(join(base, 'installed'))
    expect(script).toContain('Local\\Verstak.StableOwnership.v1')
    expect(script).toContain('AbandonedMutexException')
    expect(script).toContain('WaitOne(15000)')
    expect(script).toContain('ReleaseMutex()')
    expect(script).toContain('Dispose()')
    for (const owns of [false, true]) {
      const mutexName = `Local\\Verstak.UninstallerTest.${randomUUID()}`
      const harness = `
${assertOwnershipMutexHeld}
function Get-VerstakInstallLocation { return '${owns ? join(base, 'installed') : 'C:\\Successor'}' }
function Get-VerstakNativeHostSnapshot { Assert-OwnershipMutexHeld; return [PSCustomObject]@{ State = 'absent'; Value = $null } }
function Remove-VerstakInstallRegistrationIfOwned { Assert-OwnershipMutexHeld; [Console]::Write('registration-deleted'); return $true }
function Test-Path { return $false }
function Remove-Item { throw 'unexpected removal' }
${script}
`
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        harness.replaceAll('Local\\Verstak.StableOwnership.v1', mutexName)],
        { encoding: 'utf8', windowsHide: true })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe(owns ? 'registration-deleted' : '')
    }
  }, 60_000)

  it.skipIf(process.platform !== 'win32')('registry writer serializes the tuple and checks exact readback in PowerShell', () => {
    const builder = (shell as unknown as { buildUninstallRegistryScript?: (entry: Record<string, string>) => string }).buildUninstallRegistryScript
    expect(builder).toBeTypeOf('function')
    const script = builder!({ displayName: 'Verstak', displayVersion: '2.8.2', publisher: 'Pavel',
      installLocation: 'C:\\Apps\\Verstak', uninstallString: 'uninstall', displayIcon: 'icon' })
    expect(script).toContain('Local\\Verstak.StableOwnership.v1')
    expect(script).toContain('WaitOne(15000)')
    expect(script).toContain('AbandonedMutexException')
    expect(script).toContain('ReleaseMutex()')
    for (const corrupt of [false, true]) {
      const mutexName = `Local\\Verstak.WriterTest.${randomUUID()}`
      const harness = `${assertOwnershipMutexHeld}
$script:values = @{}
function New-Item { param($Path, [switch]$Force); Assert-OwnershipMutexHeld }
function Set-ItemProperty { param($Path, $Name, $Value, $Type); $script:values[$Name] = $Value }
function Get-ItemProperty { param($LiteralPath); ${corrupt ? "$script:values['DisplayVersion'] = 'successor'" : ''}; return [PSCustomObject]$script:values }
function Test-Path { return $false }
function Remove-Item { param($LiteralPath, [switch]$Recurse, [switch]$Force); $script:values.Clear() }
${script}`
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        harness.replaceAll('Local\\Verstak.StableOwnership.v1', mutexName)],
        { encoding: 'utf8', windowsHide: true })
      expect(result.status, result.stderr).toBe(corrupt ? 1 : 0)
      if (corrupt) expect(result.stderr).toContain('readback mismatch')
    }
  }, 60_000)

  it.skipIf(process.platform !== 'win32')('registry writer restores exact previous values after a partial tuple failure', () => {
    const script = shell.buildUninstallRegistryScript({ displayName: 'new', displayVersion: '2.8.2',
      publisher: 'new publisher', installLocation: 'C:\\New', uninstallString: 'new cmd', displayIcon: 'new icon' })
    const harness = `$script:values = @{ DisplayName = 'old'; DisplayVersion = '2.8.1'; NoModify = 0; CustomValue = 'untouched' }
$script:failed = $false
function Test-Path { return $true }
function New-Item { param($Path, [switch]$Force) }
function Get-ItemProperty { param($LiteralPath); return [PSCustomObject]$script:values }
function Get-Item {
  param($LiteralPath)
  $item = [PSCustomObject]@{}
  $item | Add-Member ScriptMethod GetValueKind { param($Name); if ($Name -eq 'NoModify') { return 'DWord' }; return 'String' }
  $item | Add-Member ScriptMethod GetValue { param($Name, $Default, $Options); return $script:values[$Name] }
  return $item
}
function Set-ItemProperty {
  param($Path, $Name, $Value, $Type)
  $script:values[$Name] = $Value
  if ($Name -eq 'DisplayVersion' -and -not $script:failed) { $script:failed = $true; throw 'injected partial write' }
}
function Remove-ItemProperty { param($LiteralPath, $Name); $script:values.Remove($Name) }
function Remove-Item { throw 'must preserve existing key' }
try {
${script}
} catch { [Console]::WriteLine($_.Exception.Message) }
[Console]::WriteLine(($script:values | ConvertTo-Json -Compress))`
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      harness.replaceAll('Local\\Verstak.StableOwnership.v1', `Local\\Verstak.PartialWriterTest.${randomUUID()}`)],
    { encoding: 'utf8', windowsHide: true })
    expect(result.status, result.stderr).toBe(0)
    const lines = result.stdout.trim().split(/\r?\n/)
    expect(lines[0]).toContain('rollback completed')
    expect(JSON.parse(lines.at(-1)!)).toEqual({ DisplayName: 'old', DisplayVersion: '2.8.1', NoModify: 0, CustomValue: 'untouched' })
  })

  it.skipIf(process.platform !== 'win32')(
    'generated uninstaller restores registry after file failure and preserves a successor',
    () => {
      const installDir = join(base, 'installed')
      const harnessPath = join(base, 'uninstall-harness.ps1')
      const eventsPath = join(base, 'events.txt')
      const chromeKey = 'Software\\Google\\Chrome\\NativeMessagingHosts\\ru.verstak.browser_bridge'
      const edgeKey = 'Software\\Microsoft\\Edge\\NativeMessagingHosts\\ru.verstak.browser_bridge'
      const manifest = join(installDir, 'resources', 'browser-bridge', 'ru.verstak.browser_bridge.json')
      const successor = 'C:\\Program Files\\Verstak-successor\\resources\\browser-bridge\\ru.verstak.browser_bridge.json'
      const quote = (value: string) => value.replace(/'/g, "''")
      const script = buildUninstallScript(installDir)
      const harness = `$script:events = [Collections.Generic.List[string]]::new()
$script:registry = @{}
$script:registry['${quote(chromeKey)}'] = '${quote(manifest)}'
$script:registry['${quote(edgeKey)}'] = '${quote(manifest)}'
function Get-VerstakInstallLocation { return '${quote(installDir)}' }

function Get-VerstakNativeHostSnapshot {
  param([string]$SubKeyPath)
  $script:events.Add("atomic-read:$SubKeyPath") | Out-Null
  if (-not $script:registry.ContainsKey($SubKeyPath)) {
    return [PSCustomObject]@{ State = 'absent'; Value = $null }
  }
  return [PSCustomObject]@{ State = 'present'; Value = $script:registry[$SubKeyPath] }
}
function Remove-VerstakNativeHostIfOwned {
  param([string]$SubKeyPath, [string]$ExpectedValue)
  $script:events.Add("atomic-delete:$SubKeyPath") | Out-Null
  if (-not $script:registry.ContainsKey($SubKeyPath)) {
    return [PSCustomObject]@{ State = 'absent'; Value = $null }
  }
  if ($script:registry[$SubKeyPath] -ne $ExpectedValue) {
    return [PSCustomObject]@{ State = 'successor'; Value = $script:registry[$SubKeyPath] }
  }
  $script:registry.Remove($SubKeyPath)
  return [PSCustomObject]@{ State = 'deleted'; Value = $null }
}
function Restore-VerstakNativeHostIfUnchanged {
  param([string]$SubKeyPath, [string]$ExpectedState, [string]$ExpectedValue, [string]$PreviousValue)
  $script:events.Add("atomic-restore:$($SubKeyPath):$ExpectedState") | Out-Null
  if ($script:registry.ContainsKey($SubKeyPath)) {
    return [PSCustomObject]@{ State = 'successor'; Value = $script:registry[$SubKeyPath] }
  }
  $script:registry[$SubKeyPath] = $PreviousValue
  $script:events.Add("restore-write:$SubKeyPath") | Out-Null
  return [PSCustomObject]@{ State = 'restored'; Value = $PreviousValue }
}

function Test-Path {
  [CmdletBinding()] param([string]$LiteralPath, [string]$Path)
  $target = if ($LiteralPath) { $LiteralPath } else { $Path }
  return $true
}
function Remove-Item {
  [CmdletBinding()] param([string]$LiteralPath, [string]$Path, [switch]$Recurse, [switch]$Force)
  $target = if ($LiteralPath) { $LiteralPath } else { $Path }
  $script:events.Add("file-delete:$target") | Out-Null
  $script:registry['${quote(chromeKey)}'] = '${quote(successor)}'
  $script:events.Add('successor-claimed-chrome') | Out-Null
  throw 'injected file delete failure'
}

try {
${script}
} catch {
  $script:events.Add("caught:$($_.Exception.Message)") | Out-Null
}
[IO.File]::WriteAllLines('${quote(eventsPath)}', $script:events)
`
      writeFileSync(harnessPath, harness.replaceAll('Local\\Verstak.StableOwnership.v1',
        `Local\\Verstak.RollbackTest.${randomUUID()}`), 'utf8')

      const result = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harnessPath,
      ], { encoding: 'utf8', windowsHide: true, shell: false })
      expect(result.status, result.stderr || result.stdout).toBe(0)
      const events = readFileSync(eventsPath, 'utf8').split(/\r?\n/).filter(Boolean)
      const chromeDelete = events.indexOf(`atomic-delete:${chromeKey}`)
      const edgeDelete = events.indexOf(`atomic-delete:${edgeKey}`)
      const fileDelete = events.findIndex(event => event.startsWith('file-delete:'))
      const chromeRestore = events.indexOf(`restore-write:${chromeKey}`)
      const edgeRestore = events.indexOf(`restore-write:${edgeKey}`)
      expect(chromeDelete).toBeGreaterThan(-1)
      expect(edgeDelete).toBeGreaterThan(chromeDelete)
      expect(fileDelete).toBeGreaterThan(edgeDelete)
      expect(events).toContain('successor-claimed-chrome')
      expect(events).toContain(`atomic-restore:${chromeKey}:absent`)
      expect(events).toContain(`atomic-restore:${edgeKey}:absent`)
      expect(chromeRestore).toBe(-1)
      expect(edgeRestore).toBeGreaterThan(fileDelete)
      expect(events.some(event => event.includes('registry rollback completed'))).toBe(true)
    },
  )
})
