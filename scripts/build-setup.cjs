#!/usr/bin/env node
/**
 * Собирает Electron-установщик Verstak (вариант C).
 * Требует готовый release/win-unpacked (без вложенного app-payload).
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const UNPACKED = path.join(ROOT, 'release', 'win-unpacked')
const STAGING = path.join(ROOT, 'release', 'app-payload-staging')
const INSTALLER_OUT = path.join(ROOT, 'release', 'installer-build')

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function die(msg) {
  console.error(`[build-setup] ${msg}`)
  process.exit(1)
}

function copyDirFiltered(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'app-payload') continue
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDirFiltered(from, to)
    else if (entry.isFile()) fs.copyFileSync(from, to)
  }
}

if (!fs.existsSync(path.join(UNPACKED, 'Verstak.exe'))) {
  die('Нет release/win-unpacked — сначала соберите приложение (electron-builder --win --x64).')
}

console.log('[build-setup] prepare app-payload-staging')
fs.rmSync(STAGING, { recursive: true, force: true })
copyDirFiltered(UNPACKED, STAGING)

console.log('[build-setup] vite build (installer)')
run(NPX, ['electron-vite', 'build', '--config', 'electron.vite.installer.config.ts'])

console.log('[build-setup] electron-builder portable setup')
fs.rmSync(INSTALLER_OUT, { recursive: true, force: true })
run(NPX, [
  'electron-builder',
  '--config',
  'electron-builder.installer.json',
  '--win',
  'portable',
  '--x64',
])

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const setupName = `Verstak-Setup-${pkg.version}-x64.exe`
const built = path.join(INSTALLER_OUT, setupName)
const dest = path.join(ROOT, 'release', setupName)
if (!fs.existsSync(built)) die(`Не найден ${built}`)
fs.copyFileSync(built, dest)
console.log(`[build-setup] OK → release/${setupName}`)