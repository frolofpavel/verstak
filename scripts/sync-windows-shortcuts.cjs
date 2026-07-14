#!/usr/bin/env node
/**
 * Updates Verstak.exe icon metadata and repairs Windows shortcuts.
 *
 * Important: do not delete valid pinned taskbar shortcuts such as
 * "Verstak (2).lnk". Windows keeps a separate taskbar cache that may point to
 * that exact file. If we remove the file, the pinned button becomes a dead
 * Windows item. Valid pinned links are updated in place instead.
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const rcedit = require('rcedit')

const ROOT = path.join(__dirname, '..')
const DEFAULT_EXE = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Verstak', 'Verstak.exe')
const ICO = path.join(ROOT, 'resources', 'icon.ico')
const TASKBAR_DIR = path.join(process.env.APPDATA || '', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar')
const PINNED_START_DIR = path.join(process.env.APPDATA || '', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'StartMenu')
const START_MENU_DIR = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')

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

function cleanupShortcutBackups(lnkPath) {
  const dir = path.dirname(lnkPath)
  const base = path.basename(lnkPath)
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir)) {
    if (entry.toLowerCase().startsWith(`${base.toLowerCase()}.bak-`)) {
      try {
        fs.unlinkSync(path.join(dir, entry))
        console.log('[sync-shortcuts] removed backup shortcut ->', path.join(dir, entry))
      } catch (err) {
        console.warn('[sync-shortcuts] remove backup shortcut failed:', err.message || err)
      }
    }
  }
}

function cleanupBrokenShortcuts() {
  const dirs = [
    TASKBAR_DIR,
    PINNED_START_DIR,
    START_MENU_DIR,
    path.join(os.homedir(), 'Desktop'),
  ].filter(Boolean)

  const script = `
$dirs = @(${dirs.map(d => `'${psQuote(d)}'`).join(',')})
$sh = New-Object -ComObject WScript.Shell
foreach ($dir in $dirs) {
  if (-not (Test-Path -LiteralPath $dir)) { continue }
  Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match '^(Verstak|Electron)( \\(\\d+\\))?\\.lnk(\\.bak-.+)?$'
  } | ForEach-Object {
    $remove = $false
    if ($_.Name -match '\\.bak-') { $remove = $true }
    elseif ($_.Extension -ieq '.lnk') {
      try {
        $shortcut = $sh.CreateShortcut($_.FullName)
        if (-not $shortcut.TargetPath -or -not (Test-Path -LiteralPath $shortcut.TargetPath)) { $remove = $true }
      } catch {
        $remove = $true
      }
    }
    if ($remove) {
      Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
      Write-Output $_.FullName
    }
  }
}
`
  const out = runPowerShell(script)
  for (const removed of out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
    console.log('[sync-shortcuts] removed broken shortcut ->', removed)
  }
}

function findExistingPinnedLinks() {
  const found = []
  for (const dir of [TASKBAR_DIR, PINNED_START_DIR]) {
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir)) {
      if (/^(Verstak|Electron)( \(\d+\))?\.lnk$/i.test(entry)) {
        found.push(path.join(dir, entry))
      }
    }
  }
  return found
}

function findPinnedLinksForExe(exePath) {
  const dirs = [TASKBAR_DIR, PINNED_START_DIR].filter(dir => fs.existsSync(dir))
  if (!dirs.length) return []

  const script = `
$dirs = @(${dirs.map(d => `'${psQuote(d)}'`).join(',')})
$exe = '${psQuote(exePath)}'
$sh = New-Object -ComObject WScript.Shell
foreach ($dir in $dirs) {
  Get-ChildItem -LiteralPath $dir -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $s = $sh.CreateShortcut($_.FullName)
      if ($s.TargetPath -ieq $exe) { $_.FullName }
    } catch {}
  }
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
    console.log('[sync-shortcuts] skip - not Windows')
    return
  }

  const exePath = path.resolve(process.argv[2] || DEFAULT_EXE)
  if (!fs.existsSync(exePath)) {
    throw new Error(`exe not found: ${exePath}`)
  }
  if (!fs.existsSync(ICO)) {
    throw new Error(`ico not found: ${ICO} - npm run generate:icon`)
  }

  await rcedit(exePath, {
    icon: ICO,
    'version-string': {
      FileDescription: 'VERSTAK',
      ProductName: 'VERSTAK',
      InternalName: 'VERSTAK',
      OriginalFilename: 'Verstak.exe',
    },
  })
  console.log('[sync-shortcuts] icon + metadata ->', exePath)

  cleanupBrokenShortcuts()

  const shortcuts = [
    path.join(os.homedir(), 'Desktop', 'Verstak.lnk'),
    path.join(START_MENU_DIR, 'Verstak.lnk'),
    ...findExistingPinnedLinks(),
    ...findPinnedLinksForExe(exePath),
  ]

  const seen = new Set()
  for (const lnk of shortcuts) {
    if (!lnk || seen.has(lnk.toLowerCase())) continue
    seen.add(lnk.toLowerCase())
    try {
      fs.mkdirSync(path.dirname(lnk), { recursive: true })
      upsertShortcut(lnk, exePath)
      cleanupShortcutBackups(lnk)
      console.log('[sync-shortcuts] shortcut ->', lnk)
    } catch (err) {
      console.warn('[sync-shortcuts] skip', lnk, err.message || err)
    }
  }

  cleanupBrokenShortcuts()
  refreshShellIcons()
  console.log('[sync-shortcuts] shell icon cache notified')
}

main().catch(err => {
  console.error('[sync-shortcuts]', err.message || err)
  process.exit(1)
})
