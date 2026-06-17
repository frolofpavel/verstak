#!/usr/bin/env node
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const payload = path.join(ROOT, 'release', 'win-unpacked')

if (!fs.existsSync(path.join(payload, 'Verstak.exe'))) {
  console.error('[dev-installer] Нет release/win-unpacked — сначала: npm run build && npx electron-builder --win --x64 --dir')
  process.exit(1)
}

process.env.VERSTAK_INSTALLER = '1'
process.env.VERSTAK_INSTALLER_PAYLOAD = payload

const result = spawnSync(
  'npx',
  ['electron-vite', 'dev', '--config', 'electron.vite.installer.config.ts'],
  { cwd: ROOT, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' },
)
process.exit(result.status ?? 1)