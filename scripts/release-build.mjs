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
import { existsSync, mkdirSync, copyFileSync, cpSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { classifyBetterSqlite3Abi } = require('./native-abi.cjs')
// Список промежуточных стадий сборки — ОДИН на весь релизный конвейер: сборщик
// установщика их создаёт и убирает, а здесь мы сносим их в упавшей сборке, до
// того как git попробует удалить дерево (см. cleanup).
const { INTERMEDIATE } = require('./build-setup.cjs')

const ROOT = process.cwd()
const sh = (cmd, cwd = ROOT) => execSync(cmd, { cwd, encoding: 'utf8' }).trim()

// Путь better_sqlite3.node внутри произвольного дерева node_modules.
const betterSqlite3Node = base =>
  join(base, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')

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

// ПРЕДУПРЕЖДЕНИЕ (не стоп): состояние ABI в рабочем дереве. Тесты (safe-rebuild /
// tests/global-setup ensureNodeAbi) переводят better_sqlite3.node под Node ABI; но
// `dist:win` в чистой копии сам гонит electron-rebuild ПЕРЕД упаковкой, поэтому Node ABI
// источника до артефакта НЕ доживает. Замер штаба (09.08): и в сломанной 2.4.5, и в
// рабочей 2.4.6 обе копии .node (app.asar.unpacked + native-fix) — под Electron ABI.
// Значит fail-closed ЗДЕСЬ давал бы ложный отказ после каждого прогона тестов. Настоящий
// fail-closed — на ВЫХОДЕ (post-build ниже) и в afterPack (гард источника native-fix).
const rootAbi = classifyBetterSqlite3Abi(betterSqlite3Node(ROOT))
if (rootAbi !== 'electron') {
  console.warn(`⚠ better_sqlite3.node в рабочем node_modules под «${rootAbi}» ABI (не Electron) —`)
  console.warn('  норм: dist:win пересоберёт копию под Electron; ABI артефакта проверю после сборки.')
}

const wt = join(tmpdir(), `verstak-release-${short}`)
const nm = join(wt, 'node_modules')

function cleanup() {
  // ИДЕМПОТЕНТНОСТЬ — не гигиена, а условие правдивости следа ниже. cleanup()
  // зовётся ДВАЖДЫ на успешном пути: из finally и из process.on('exit'). Второй
  // вызов всегда падает `fatal: … is not a working tree`, и след, повешенный на
  // код возврата, кричал бы «не убралось» на КАЖДОЙ здоровой сборке. Сигнал,
  // который врёт на норме, люди перестают читать — и §3.1 отключается ровно там,
  // где он нужен.
  //
  // Признак «убирать нечего» — САМ КАТАЛОГ, а не флаг «мы уже вызывались»:
  // cleanup() зовётся ещё и ДО сборки (снять остаток прошлого прогона), и флаг
  // погасил бы финальную уборку целиком. Вопрос «каталог на диске есть?» верен
  // во всех трёх точках вызова.
  if (!existsSync(wt)) return

  // Сначала снимаем ПРИЧИНУ отказа, а не боремся с последствиями. Уборка падала
  // на «Filename too long»: самый длинный путь внутри release/app-payload-staging
  // даёт 263 символа под временным префиксом при MAX_PATH 260. Node сносит их
  // спокойно, git — нет, поэтому убираем стадии сами и только потом отдаём
  // дерево git'у. Список берём ОДИН, из сборщика установщика, — иначе он
  // разъедется с тем, что реально создаётся.
  for (const name of INTERMEDIATE) {
    try { rmSync(join(wt, 'release', name), { recursive: true, force: true }) } catch { /* уже нет — хорошо */ }
  }

  try {
    sh(`git worktree remove --force "${wt}"`)
  } catch { /* судим по диску ниже, а не по коду возврата */ }

  // СЛЕД ПО ФАКТУ. Код возврата здесь обманчив дважды: git может вернуть ошибку,
  // сняв при этом регистрацию (тогда каталог с гигабайтами остаётся, но из
  // `git worktree list` пропадает — мусор становится невидимым), а может
  // «упасть» просто потому, что убирать уже нечего. Единственный честный
  // вопрос — остался ли каталог на диске.
  if (existsSync(wt)) {
    console.warn(`\n⚠ временную копию убрать не удалось: ${wt}`)
    console.warn('  она весит гигабайты и из `git worktree list` могла уже пропасть.')
    console.warn('  удалите каталог вручную, затем выполните `git worktree prune`.')
  }
}

process.on('exit', cleanup)

try {
  if (existsSync(wt)) cleanup()
  // Запись-призрак того же коммита блокирует пересборку: `git worktree add`
  // отвечает «missing but already registered worktree», даже когда каталога нет
  // и следа. Ровно это сейчас висит от 2.4.7 (verstak-release-4702c5da). prune
  // снимает ТОЛЬКО записи без каталога — чужие рабочие деревья не затрагивает.
  try { sh('git worktree prune') } catch { /* не критично: add ниже скажет прямо */ }
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

  // FAIL-CLOSED НА ВЫХОДЕ: сверяем ABI в СОБРАННОМ артефакте. Если по любой причине
  // (пропущенный/упавший electron-rebuild, кэш пребилда, /MIR) в win-unpacked оказался
  // Node ABI — отклоняем сборку, а не публикуем её. Это ЛАТЕНТНЫЙ риск: замер штаба
  // показал, что в реально сломанной 2.4.5 артефакт был Electron ABI (значит настоящая
  // причина 2.4.5 иная и НЕИЗВЕСТНА) — но защита от Node ABI на выходе всё равно нужна.
  // Проба в дочернем процессе (native-abi.cjs) — не лочит файл, worktree корректно удалится.
  const unpacked = join(wt, 'release', 'win-unpacked', 'resources')
  const builtChecks = [
    ['app.asar.unpacked', betterSqlite3Node(join(unpacked, 'app.asar.unpacked'))],
    ['native-fix', join(unpacked, 'native-fix', 'better_sqlite3.node')],
  ]
  for (const [label, p] of builtChecks) {
    const abi = classifyBetterSqlite3Abi(p)
    if (abi !== 'electron') {
      console.error(`✗ собранный better_sqlite3.node (${label}) под «${abi}» ABI, а не Electron — установленное приложение не откроет БД (инцидент 2.4.5). Сборка отклонена.`)
      process.exit(1)
    }
  }
  console.log('   ✓ ABI better_sqlite3.node в сборке — Electron (app.asar.unpacked + native-fix)')

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

  // win-unpacked — ЗАПУСКАЕМОЕ дерево приложения для install smoke-теста гейта. Из worktree
  // оно удаляется вместе с ним (cleanup), поэтому сохраняем копию в release/. Гейт [3.6]
  // запускает Verstak.exe отсюда и проверяет, что приложение ЖИВЁТ, а не просто распаковано.
  const wtUnpacked = join(wtRelease, 'win-unpacked')
  const outUnpacked = join(outDir, 'win-unpacked')
  if (existsSync(join(wtUnpacked, 'Verstak.exe'))) {
    rmSync(outUnpacked, { recursive: true, force: true })
    cpSync(wtUnpacked, outUnpacked, { recursive: true })
    console.log('   ✓ win-unpacked (для smoke-теста гейта)')
  } else {
    console.warn('   ⚠ win-unpacked не найден в сборке — гейт пропустит install smoke')
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
