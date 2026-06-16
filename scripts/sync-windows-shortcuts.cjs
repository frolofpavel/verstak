#!/usr/bin/env node
/**
 * Обновляет иконку в Verstak.exe и все ярлыки Windows (рабочий стол, Пуск, закреплённая панель).
 * Windows кэширует иконки — без явного IconLocation в .lnk панель задач показывает старый Electron.
 *
 * Запуск: node scripts/sync-windows-shortcuts.cjs [путь/к/Verstak.exe]
 * Вызывается из deploy-local.cjs после robocopy.
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const rcedit = require('rcedit')

const ROOT = path.join(__dirname, '..')
const DEFAULT_EXE = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Verstak', 'Verstak.exe')
const ICO = path.join(ROOT, 'resources', 'icon.ico')

function psQuote(s) {
  return String(s).replace(/'/g, "''")
}

function runPowerShell(script) {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', shell: false }
  )
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || '').trim()
    throw new Error(err || `PowerShell exit ${r.status}`)
  }
  return (r.stdout || '').trim()
}

function upsertShortcut(lnkPath, exePath) {
  const dir = path.dirname(exePath)
  const script = `
$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut('${psQuote(lnkPath)}')
$lnk.TargetPath = '${psQuote(exePath)}'
$lnk.WorkingDirectory = '${psQuote(dir)}'
$lnk.IconLocation = '${psQuote(exePath)},0'
$lnk.Description = 'Verstak'
$lnk.Save()
Write-Output 'OK'
`
  runPowerShell(script)
}

function findPinnedTaskbarLinks(exePath) {
  const pinned = path.join(
    process.env.APPDATA || '',
    'Microsoft',
    'Internet Explorer',
    'Quick Launch',
    'User Pinned',
    'TaskBar'
  )
  if (!fs.existsSync(pinned)) return []

  const script = `
$dir = '${psQuote(pinned)}'
$exe = '${psQuote(exePath)}'
$sh = New-Object -ComObject WScript.Shell
Get-ChildItem -LiteralPath $dir -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
  $s = $sh.CreateShortcut($_.FullName)
  if ($s.TargetPath -ieq $exe) { $_.FullName }
}
`
  const out = runPowerShell(script)
  return out ? out.split(/\r?\n/).map(l => l.trim()).filter(Boolean) : []
}

function refreshShellIcons() {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class VerstakShell {
  [DllImport("shell32.dll")]
  public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);
}
"@
[VerstakShell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
if (Get-Command ie4uinit.exe -ErrorAction SilentlyContinue) { & ie4uinit.exe -show }
Write-Output 'refreshed'
`
  runPowerShell(script)
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('[sync-shortcuts] skip — not Windows')
    return
  }

  const exePath = path.resolve(process.argv[2] || DEFAULT_EXE)
  if (!fs.existsSync(exePath)) {
    throw new Error(`exe not found: ${exePath}`)
  }
  if (!fs.existsSync(ICO)) {
    throw new Error(`ico not found: ${ICO} — npm run generate:icon`)
  }

  await rcedit(exePath, { icon: ICO })
  console.log('[sync-shortcuts] icon →', exePath)

  const shortcuts = [
    path.join(os.homedir(), 'Desktop', 'Verstak.lnk'),
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Verstak.lnk'),
    ...findPinnedTaskbarLinks(exePath),
  ]

  const seen = new Set()
  for (const lnk of shortcuts) {
    if (!lnk || seen.has(lnk.toLowerCase())) continue
    seen.add(lnk.toLowerCase())
    try {
      fs.mkdirSync(path.dirname(lnk), { recursive: true })
      upsertShortcut(lnk, exePath)
      console.log('[sync-shortcuts] shortcut →', lnk)
    } catch (err) {
      console.warn('[sync-shortcuts] skip', lnk, err.message || err)
    }
  }

  refreshShellIcons()
  console.log('[sync-shortcuts] shell icon cache notified')
}

main().catch(err => {
  console.error('[sync-shortcuts]', err.message || err)
  process.exit(1)
})