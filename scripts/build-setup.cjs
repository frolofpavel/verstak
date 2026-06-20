#!/usr/bin/env node
/**
 * Собирает Electron-установщик Verstak (вариант C).
 * Требует готовый release/win-unpacked (без вложенного app-payload).
 */
const { spawnSync } = require('child_process')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const UNPACKED = path.join(ROOT, 'release', 'win-unpacked')
const STAGING = path.join(ROOT, 'release', 'app-payload-staging')
const PAYLOAD_ARCHIVE = path.join(ROOT, 'release', 'app-payload.7z')
const SEVEN_ZA = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
const APP_STAGING = path.join(ROOT, 'release', 'installer-app-staging')
const INSTALLER_OUT = path.join(ROOT, 'release', 'installer-build')
const PORTABLE_NSIS = path.join(
  ROOT,
  'node_modules',
  'app-builder-lib',
  'templates',
  'nsis',
  'portable.nsi',
)

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

const PAYLOAD_SKIP = new Set(['app-payload', 'locales'])

function computePayloadManifest(dir) {
  let fileCount = 0
  let payloadBytes = 0
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile()) {
        fileCount += 1
        payloadBytes += fs.statSync(abs).size
      }
    }
  }
  walk(dir)
  return { fileCount, payloadBytes }
}

function copyDirFiltered(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (PAYLOAD_SKIP.has(entry.name)) continue
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDirFiltered(from, to)
    else if (entry.isFile()) fs.copyFileSync(from, to)
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(from, to)
    else if (entry.isFile()) fs.copyFileSync(from, to)
  }
}

function prepareInstallerAppStaging(version) {
  fs.rmSync(APP_STAGING, { recursive: true, force: true })
  fs.mkdirSync(APP_STAGING, { recursive: true })
  const installerPkg = {
    name: 'verstak-setup',
    version,
    description: 'Verstak installer',
    main: 'out/installer/main.mjs',
    private: true,
  }
  fs.writeFileSync(
    path.join(APP_STAGING, 'package.json'),
    `${JSON.stringify(installerPkg, null, 2)}\n`,
  )
  for (const sub of ['installer', 'preload', 'renderer']) {
    copyDir(path.join(ROOT, 'out', sub), path.join(APP_STAGING, 'out', sub))
  }
  const splashDir = path.join(APP_STAGING, 'splash')
  fs.mkdirSync(splashDir, { recursive: true })
  fs.copyFileSync(
    path.join(ROOT, 'resources', 'installer-splash.html'),
    path.join(splashDir, 'installer-splash.html'),
  )
  fs.copyFileSync(path.join(ROOT, 'resources', 'icon.png'), path.join(splashDir, 'icon.png'))
}

function patchPortableNsisTemplate() {
  const backup = `${PORTABLE_NSIS}.bak-verstak`
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(PORTABLE_NSIS, backup)
  }
  fs.copyFileSync(path.join(ROOT, 'build', 'portable-verstak.nsi'), PORTABLE_NSIS)
}

function restorePortableNsisTemplate() {
  const backup = `${PORTABLE_NSIS}.bak-verstak`
  if (fs.existsSync(backup)) {
    fs.copyFileSync(backup, PORTABLE_NSIS)
  }
}

function hashFileSha512Base64(filePath) {
  const hash = createHash('sha512')
  const fd = fs.openSync(filePath, 'r')
  const buf = Buffer.allocUnsafe(4 * 1024 * 1024)
  try {
    let read = 0
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('base64')
}

function writeLatestYml(version, setupPath) {
  const setupName = path.basename(setupPath)
  const stat = fs.statSync(setupPath)
  const sha512 = hashFileSha512Base64(setupPath)
  const body = [
    `version: ${version}`,
    'files:',
    `  - url: ${setupName}`,
    `    sha512: ${sha512}`,
    `    size: ${stat.size}`,
    `path: ${setupName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n')
  fs.writeFileSync(path.join(ROOT, 'release', 'latest.yml'), body)
}

if (!fs.existsSync(path.join(UNPACKED, 'Verstak.exe'))) {
  die('Нет release/win-unpacked — сначала соберите приложение (electron-builder --win --x64).')
}

console.log('[build-setup] prepare app-payload-staging')
fs.rmSync(STAGING, { recursive: true, force: true })
copyDirFiltered(UNPACKED, STAGING)
const manifest = computePayloadManifest(STAGING)
fs.writeFileSync(
  path.join(STAGING, 'payload-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
)
console.log(`[build-setup] payload: ${(manifest.payloadBytes / (1024 * 1024)).toFixed(1)} MB, ${manifest.fileCount} files`)

if (!fs.existsSync(SEVEN_ZA)) {
  die('Нет 7za.exe (npm install 7zip-bin).')
}
console.log('[build-setup] pack app-payload.7z')
fs.rmSync(PAYLOAD_ARCHIVE, { force: true })
const pack = spawnSync(SEVEN_ZA, ['a', '-t7z', '-mx=1', PAYLOAD_ARCHIVE, '*'], {
  cwd: STAGING,
  stdio: 'inherit',
  windowsHide: true,
})
if (pack.status !== 0) die('Не удалось создать app-payload.7z')
const archiveMb = (fs.statSync(PAYLOAD_ARCHIVE).size / (1024 * 1024)).toFixed(1)
console.log(`[build-setup] archive: ${archiveMb} MB → release/app-payload.7z`)

console.log('[build-setup] vite build (installer)')
run(NPX, ['electron-vite', 'build', '--config', 'electron.vite.installer.config.ts'])

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
console.log('[build-setup] prepare installer-app-staging')
prepareInstallerAppStaging(pkg.version)

console.log('[build-setup] patch portable.nsi (animated splash)')
patchPortableNsisTemplate()

console.log('[build-setup] electron-builder portable setup')
fs.rmSync(INSTALLER_OUT, { recursive: true, force: true })
try {
run(NPX, [
  'electron-builder',
  '--config',
  'electron-builder.installer.json',
  '--win',
  'portable',
  '--x64',
])
} finally {
  restorePortableNsisTemplate()
}

const setupName = `Verstak-Setup-${pkg.version}-x64.exe`
const built = path.join(INSTALLER_OUT, setupName)
const dest = path.join(ROOT, 'release', setupName)
if (!fs.existsSync(built)) die(`Не найден ${built}`)
fs.copyFileSync(built, dest)
writeLatestYml(pkg.version, dest)
console.log(`[build-setup] OK → release/${setupName}`)
