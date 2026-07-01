#!/usr/bin/env node
/**
 * Локальный деплой win-unpacked → %LOCALAPPDATA%\Programs\Verstak.
 *
 * Перед robocopy удаляет resources\app.asar.unpacked — иначе /MIR может
 * оставить старый better_sqlite3.node (Node ABI 137) поверх свежей сборки
 * (Electron ABI 143) и приложение не откроет verstak.db.
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'release', 'win-unpacked')
const DEST = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Verstak')
const UNPACKED = path.join(DEST, 'resources', 'app.asar.unpacked')
const RELEASE_NODE = path.join(
  SRC,
  'resources',
  'app.asar.unpacked',
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node'
)

function die(msg) {
  console.error(`[deploy-local] ${msg}`)
  process.exit(1)
}

function probeElectronAbi(nodePath) {
  try {
    process.dlopen({ exports: {} }, nodePath)
    return 'node'
  } catch (err) {
    const text = String((err && err.message) || err)
    if (/NODE_MODULE_VERSION 143/.test(text) && /requires\s+NODE_MODULE_VERSION 137/.test(text)) {
      return 'electron'
    }
    if (/NODE_MODULE_VERSION 137/.test(text) && /requires\s+NODE_MODULE_VERSION 143/.test(text)) {
      return 'node'
    }
    return 'unknown'
  }
}

const running = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Verstak.exe', '/NH'], {
  encoding: 'utf8',
  shell: true,
})
if (/Verstak\.exe/i.test(running.stdout || '')) {
  die('Verstak запущен — закрой приложение и повтори деплой.')
}

if (!fs.existsSync(path.join(SRC, 'Verstak.exe'))) {
  die('Нет release\\win-unpacked — сначала: npm run dist:win')
}

if (!fs.existsSync(RELEASE_NODE)) {
  die(`Нет ${RELEASE_NODE} — пересобери dist:win`)
}

const abi = probeElectronAbi(RELEASE_NODE)
if (abi !== 'electron') {
  die(
    `better_sqlite3.node в release не под Electron ABI 143 (сейчас: ${abi}). ` +
      'Запусти: npm run electron-rebuild && npm run dist:win'
  )
}

if (fs.existsSync(UNPACKED)) {
  fs.rmSync(UNPACKED, { recursive: true, force: true })
  console.log('[deploy-local] Удалён stale app.asar.unpacked')
}

// ВАЖНО: locales ОБЯЗАТЕЛЬНО зеркалим (раньше был /XD locales для скорости). При
// апгрейде Electron старые locales/*.pak оставались в install-папке и мисматчились
// с новым бинарём → «locale resources are not loaded» → нативный краш рендерера
// (0xC0000005), окно не открывалось. /MIR без исключения locales держит их в синке.
const robocopy = spawnSync(
  'robocopy',
  [SRC, DEST, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS'],
  { stdio: 'inherit', shell: true }
)
const code = robocopy.status ?? 1
if (code >= 8) {
  die(`robocopy завершился с кодом ${code}`)
}

if (process.platform === 'win32') {
  const sync = spawnSync('node', [path.join(ROOT, 'scripts', 'sync-windows-shortcuts.cjs'), path.join(DEST, 'Verstak.exe')], {
    stdio: 'inherit',
    shell: false,
  })
  if (sync.status !== 0) {
    die('sync-windows-shortcuts завершился с ошибкой — ярлыки/иконка не обновлены')
  }
}

console.log('[deploy-local] Готово →', DEST)