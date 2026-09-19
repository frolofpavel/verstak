import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error(`Mac M0 package check requires darwin-arm64, got ${process.platform}-${process.arch}`)
}

const releaseDir = resolve('release')
const appDir = join(releaseDir, 'mac-arm64', 'Verstak.app')
const resourcesDir = join(appDir, 'Contents', 'Resources')
const unpackedDir = join(resourcesDir, 'app.asar.unpacked')
const executable = join(appDir, 'Contents', 'MacOS', 'Verstak')

function walk(root) {
  const found = []
  if (!existsSync(root)) return found
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) found.push(...walk(path))
    else found.push(path)
  }
  return found
}

function assertArm64(path, label) {
  if (!existsSync(path)) throw new Error(`${label} не найден: ${path}`)
  const output = execFileSync('/usr/bin/file', ['-b', path], { encoding: 'utf8' })
  if (!/arm64/.test(output)) throw new Error(`${label} не arm64: ${output.trim()}`)
}

assertArm64(executable, 'Verstak executable')
const nativeModules = walk(unpackedDir).filter(path => path.endsWith('.node'))
const sqlite = nativeModules.find(path => path.endsWith(`${join('better-sqlite3', 'build', 'Release', 'better_sqlite3.node')}`))
const pty = nativeModules.find(path => path.endsWith(`${join('@homebridge', 'node-pty-prebuilt-multiarch', 'build', 'Release', 'pty.node')}`))
assertArm64(sqlite || '', 'better-sqlite3')
assertArm64(pty || '', 'node-pty')

for (const forbidden of ['7za.exe', 'verstak-auto-update-helper.cjs', 'browser-bridge', 'computer-use', 'browser-extension']) {
  if (existsSync(join(resourcesDir, forbidden))) {
    throw new Error(`Windows-only resource попал в Mac package: ${forbidden}`)
  }
}

const artifacts = readdirSync(releaseDir).filter(name => statSync(join(releaseDir, name)).isFile())
const dmg = artifacts.find(name => /-mac-arm64\.dmg$/.test(name))
const zip = artifacts.find(name => /-mac-arm64\.zip$/.test(name))
if (!dmg || !zip) throw new Error(`DMG/ZIP arm64 не найдены: ${artifacts.join(', ')}`)

console.log(JSON.stringify({ appDir, executable, dmg, zip, nativeModules: { sqlite, pty } }, null, 2))
