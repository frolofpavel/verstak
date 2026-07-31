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
  // node_modules теперь РЕАЛЬНАЯ КОПИЯ (не junction) — удаляем весь worktree
  // целиком одной командой; отдельного снятия junction больше нет.
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

  // node_modules — РЕАЛЬНОЙ КОПИЕЙ, а НЕ junction'ом. Junction ломал упаковку:
  // electron-builder, обходя node_modules через reparse-point, брал только
  // зависимости ГЛУБИНЫ 1 (34 пакета вместо 324) — транзитивные (p-retry и др.)
  // в asar не попадали, приложение падало на старте `ERR_MODULE_NOT_FOUND:
  // Cannot find package 'p-retry'`. Гейт этого не ловил (тестирует исходники, а
  // не asar), поймал человек на установке (2.3.0, 31.07). Замер при СТАБИЛЬНОМ
  // node_modules: тот же каталог через junction → 34 пакета, реальным деревом →
  // 324. Копируем robocopy'ем: он тянет длинные пути (cmd rmdir/glob — нет) и
  // переиспользует уже скачанные пребилды, без обращения к сети (в отличие от
  // npm ci). Провенанс не страдает: исходники worktree — из коммита, копируется
  // лишь gitignored-дерево зависимостей.
  console.log('[2/4] копирую node_modules в чистую копию (robocopy, реальное дерево; 2-3 мин)…')
  const copy = spawnSync('robocopy', [join(ROOT, 'node_modules'), nm, '/E', '/MT', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS', '/NP'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  // robocopy: коды выхода 0-7 — успех (битовые флаги «скопировано/пропущено»),
  // >=8 — реальная ошибка. null (не запустился) трактуем как ошибку.
  if ((copy.status ?? 8) >= 8) {
    console.error('✗ robocopy node_modules упал (код ' + copy.status + '):\n' + ((copy.stdout || '') + (copy.stderr || '')).slice(-2000))
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
