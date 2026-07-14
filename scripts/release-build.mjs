#!/usr/bin/env node
// СБОРКА РЕЛИЗА ИЗ ЗАКОММИЧЕННОГО КОДА (а не из рабочего дерева).
//
// Зачем: `npm run dist:win` собирает из рабочего дерева. Любая НЕзакоммиченная правка
// (чужая, отладочная, забытая) молча уезжает в .exe пользователей — при том, что ревью
// её не видело и в git её нет. Реальный случай: чужая правка в `electron/ai/` попала в
// сборку 2.0.6, хотя все проверки были «зелёные».
//
// Здесь сборка идёт в ЧИСТОЙ копии текущего коммита (git worktree). Рабочее дерево не
// трогается вообще: чужие незакоммиченные файлы остаются как есть, но в релиз попасть
// не могут физически. На выходе — артефакты + паспорт сборки (BUILD_PROVENANCE.json),
// который проверяет релизный гейт.
//
// Запуск: node scripts/release-build.mjs
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = process.cwd()
const sh = (cmd, cwd = ROOT) => execSync(cmd, { cwd, encoding: 'utf8' }).trim()

const head = sh('git rev-parse HEAD')
const short = head.slice(0, 8)
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version

console.log(`\n=== СБОРКА РЕЛИЗА ИЗ ГИТА ===\nкоммит: ${short}\nверсия (рабочее дерево): ${version}\n`)

// Публикуем только запушенное — иначе исходников релиза нет ни у кого, кроме этой машины.
sh('git fetch -q origin')
const originMain = sh('git rev-parse origin/main')
if (head !== originMain) {
  console.error(`✗ HEAD (${short}) ≠ origin/main (${originMain.slice(0, 8)}). Сначала запушь код — собирать неопубликованный коммит нельзя.`)
  process.exit(1)
}

const wt = join(tmpdir(), `verstak-release-${short}`)
const nm = join(wt, 'node_modules')

function cleanup() {
  // Снять junction (именно junction, НЕ его цель — иначе снесёт общий node_modules).
  try { if (existsSync(nm)) spawnSync('cmd', ['/c', 'rmdir', nm], { stdio: 'ignore' }) } catch { /* ignore */ }
  try { sh(`git worktree remove --force "${wt}"`) } catch { /* ignore */ }
}

process.on('exit', cleanup)

try {
  if (existsSync(wt)) cleanup()
  console.log(`[1/4] чистая копия коммита → ${wt}`)
  sh(`git worktree add --detach -q "${wt}" ${head}`)

  // Версия в чистой копии — источник истины (в рабочем дереве её могли не закоммитить).
  const wtPkg = JSON.parse(readFileSync(join(wt, 'package.json'), 'utf8'))
  if (wtPkg.version !== version) {
    console.error(`✗ версия в коммите (${wtPkg.version}) ≠ версии в рабочем дереве (${version}). Закоммить bump.`)
    process.exit(1)
  }

  console.log('[2/4] подключаю node_modules (junction, без копирования гигабайтов)')
  const link = spawnSync('cmd', ['/c', 'mklink', '/J', nm, join(ROOT, 'node_modules')], { encoding: 'utf8' })
  if (link.status !== 0) {
    console.error('✗ не удалось создать junction на node_modules:', (link.stdout || '') + (link.stderr || ''))
    process.exit(1)
  }

  console.log('[3/4] npm run dist:win в чистой копии (10-15 мин)…')
  const build = spawnSync('npm', ['run', 'dist:win'], { cwd: wt, encoding: 'utf8', shell: true, maxBuffer: 256 * 1024 * 1024 })
  if (build.status !== 0) {
    const out = (build.stdout || '') + (build.stderr || '')
    console.error('✗ сборка упала:\n' + out.slice(-3000))
    process.exit(1)
  }

  console.log('[4/4] переношу артефакты + пишу паспорт сборки')
  const outDir = join(ROOT, 'release')
  mkdirSync(outDir, { recursive: true })
  const wanted = [
    `Verstak-Setup-${version}-x64.exe`,
    `Verstak-Portable-${version}-x64.exe`,
    'latest.yml'
  ]
  const wtRelease = join(wt, 'release')
  const present = existsSync(wtRelease) ? readdirSync(wtRelease) : []
  for (const f of wanted) {
    if (!present.includes(f)) {
      console.error(`✗ сборка не дала артефакт: ${f}`)
      process.exit(1)
    }
    copyFileSync(join(wtRelease, f), join(outDir, f))
    console.log(`   ✓ ${f}`)
  }

  // Паспорт: чем именно является этот .exe. Гейт сверяет его с HEAD.
  writeFileSync(join(outDir, 'BUILD_PROVENANCE.json'), JSON.stringify({
    version,
    commit: head,
    fromCleanWorktree: true,
    builtAt: new Date().toISOString()
  }, null, 2), 'utf8')

  console.log(`\n🟢 Готово. Артефакты ${version} собраны ИЗ КОММИТА ${short} (рабочее дерево не участвовало).\n`)
} finally {
  cleanup()
}
