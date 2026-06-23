/**
 * Пересборка нативных модулей под Electron с обходом двух Windows-граблей,
 * из-за которых node-pty не собирался и терминал был мёртв (см. memory
 * verstak-nodepty-windows-build):
 *   1) NoDefaultCurrentDirectoryInExePath=1 → winpty.gyp не находит GetCommitHash.bat.
 *   2) Нет Spectre-mitigated VS-библиотек → MSB8040 в conpty/winpty.
 *
 * better-sqlite3 пересобираем всегда (быстро; тесты переключают его ABI на Node).
 * node-pty — ТОЛЬКО когда бинаря нет или сменился Electron (компиляция C++ долгая,
 * иначе каждый `npm run dev` висел бы минуту на пересборке winpty).
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const ptyDir = path.join(root, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch')
const ptyBinary = path.join(ptyDir, 'build', 'Release', 'pty.node')
const marker = path.join(ptyDir, '.verstak-built-for')

// Снимаем env-переменную, ломающую поиск GetCommitHash.bat в winpty-сборке.
const env = { ...process.env }
delete env.NoDefaultCurrentDirectoryInExePath

let electronVer = ''
try { electronVer = require(path.join(root, 'node_modules', 'electron', 'package.json')).version } catch { /* ignore */ }

function rebuild(target) {
  console.log('[rebuild-native] electron-rebuild -f -o', target)
  try {
    execFileSync('npx', ['electron-rebuild', '-f', '-o', target], { cwd: root, env, stdio: 'inherit', shell: true })
  } catch {
    // execFileSync иначе бросает голый Node-стектрейс. Самая частая причина
    // провала на Windows — ОТКРЫТО приложение Verstak (или `npm run dev`): оно
    // лочит .node-файл, unlink падает EPERM/EBUSY. Даём внятную подсказку вместо
    // криптового дампа (safe-rebuild.cjs детектит лок симметрично).
    console.error(`\n[rebuild-native] ✖ Пересборка "${target}" провалилась.`)
    console.error('[rebuild-native] Частая причина — открыто приложение Verstak (или npm run dev): оно лочит .node (EPERM/EBUSY на unlink).')
    console.error('[rebuild-native] Закрой приложение Verstak ПОЛНОСТЬЮ и запусти сборку заново.')
    process.exit(1)
  }
}

// 1) better-sqlite3 — всегда (быстрая компиляция, тесты флипают его ABI).
rebuild('better-sqlite3')

// 2) node-pty — только при необходимости (долгая C++ сборка winpty/conpty).
const ptyReady = fs.existsSync(ptyBinary)
  && fs.existsSync(marker)
  && fs.readFileSync(marker, 'utf8').trim() === electronVer
if (ptyReady) {
  console.log('[rebuild-native] node-pty уже собран под Electron', electronVer, '— пропускаю')
} else {
  // Отключаем SpectreMitigation в gyp node-pty (нет Spectre-libs) — идемпотентно.
  for (const rel of ['binding.gyp', path.join('deps', 'winpty', 'src', 'winpty.gyp')]) {
    const f = path.join(ptyDir, rel)
    if (!fs.existsSync(f)) continue
    const before = fs.readFileSync(f, 'utf8')
    const after = before.replace(/'SpectreMitigation':\s*'Spectre'/g, "'SpectreMitigation': 'false'")
    if (after !== before) { fs.writeFileSync(f, after); console.log('[rebuild-native] SpectreMitigation off →', rel) }
  }
  rebuild('@homebridge/node-pty-prebuilt-multiarch')
  if (electronVer) fs.writeFileSync(marker, electronVer)
}
