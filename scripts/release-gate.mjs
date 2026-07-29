#!/usr/bin/env node
// РЕЛИЗНЫЙ ГЕЙТ — машина решает, можно ли публиковать. Никаких мнений, только факты.
//
// Зачем: владелец продукта не программист и не может (и не должен) оценивать «правильный
// ли код». Решение «публиковать» обязано приниматься проверяемыми фактами, а не чьей-то
// подписью вслепую. Гейт зелёный → публиковать МОЖНО. Красный → НЕЛЬЗЯ, и печатается почему.
//
// Запуск: node scripts/release-gate.mjs   (exit 0 = зелёный, exit 1 = красный)
// Используется внутри release:publish — опубликовать в обход гейта нельзя.
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const ROOT = process.cwd()
const failures = []
const notes = []

const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim()
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`)
  else { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); failures.push(`${name}${detail ? ': ' + detail : ''}`) }
  return ok
}

console.log('\n=== РЕЛИЗНЫЙ ГЕЙТ ===\n')

// ─── 1. Версия и её новизна ──────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
console.log(`Версия к публикации: ${version}\n`)

console.log('[1] Код и провенанс')

// HEAD == origin/main: публикуем только то, что запушено (иначе исходников релиза нет ни у кого).
let head = ''
try {
  sh('git fetch -q origin')
  head = sh('git rev-parse HEAD')
  const originMain = sh('git rev-parse origin/main')
  check('весь код запушен (HEAD == origin/main)', head === originMain, head === originMain ? head.slice(0, 8) : `HEAD ${head.slice(0, 8)} ≠ origin/main ${originMain.slice(0, 8)}`)
} catch (e) {
  check('git доступен и origin достижим', false, String(e).slice(0, 120))
}

// ПРОВЕНАНС: артефакт обязан быть собран ИЗ ЗАКОММИЧЕННОГО кода этого же коммита.
// Иначе в .exe пользователей может уехать незакоммиченный локальный код, который никто
// не ревьюил (реальный случай: чужая правка в electron/ai/ попала в сборку 2.0.6).
const provPath = join(ROOT, 'release', 'BUILD_PROVENANCE.json')
if (check('есть паспорт сборки (release/BUILD_PROVENANCE.json)', existsSync(provPath), 'пишется scripts/release-build.mjs')) {
  const prov = JSON.parse(readFileSync(provPath, 'utf8'))
  check('артефакт собран из ЭТОГО коммита', prov.commit === head, prov.commit === head ? prov.commit.slice(0, 8) : `собрано из ${String(prov.commit).slice(0, 8)}, а HEAD ${head.slice(0, 8)}`)
  check('версия артефакта == версии в package.json', prov.version === version, `${prov.version} vs ${version}`)
  check('сборка шла из чистой копии git (не из рабочего дерева)', prov.fromCleanWorktree === true, prov.fromCleanWorktree ? '' : 'НЕТ: в бинарь мог попасть незакоммиченный код')
}

// ─── 2. Версия новее опубликованной ──────────────────────────────────────────
console.log('\n[2] Версия')
const cmpSemver = (a, b) => {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) { if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0) }
  return 0
}
let published = null
{
  // Запрос АВТОРИЗОВАННЫЙ: анонимный лимит GitHub — 60/час на IP, и гейт (который
  // гоняется многократно) на нём падал бы «GitHub API недоступен» на ровном месте.
  // С токеном лимит 5000/час. Токен берём из Git Credential Manager и НЕ печатаем.
  const cred = spawnSync('git', ['credential', 'fill'], { cwd: ROOT, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' })
  const token = /^password=(.+)$/m.exec(cred.stdout || '')?.[1]
  const headers = { 'User-Agent': 'verstak-release-gate', 'X-GitHub-Api-Version': '2022-11-28' }
  if (token) headers.Authorization = `Bearer ${token}`
  // Ретраи: сетевой блип не должен блокировать релиз (fail-closed только по сути, не по связи).
  for (let attempt = 1; attempt <= 3 && !published; attempt++) {
    try {
      const res = await fetch('https://api.github.com/repos/frolofpavel/verstak/releases/latest', {
        headers, signal: AbortSignal.timeout(20_000)
      })
      const d = await res.json()
      if (typeof d.tag_name === 'string') published = d.tag_name
      else if (typeof d.message === 'string') notes.push(`GitHub API: ${d.message.slice(0, 60)}`)
    } catch { /* следующая попытка */ }
    if (!published && attempt < 3) await new Promise(r => setTimeout(r, 3000))
  }
}
if (check('узнали последний опубликованный релиз', !!published, published ?? 'GitHub API недоступен')) {
  check(`версия НОВЕЕ опубликованной (${published})`, cmpSemver(version, published) > 0, `${version} > ${published.replace(/^v/, '')}`)
}

// CHANGELOG обязан описывать эту версию — иначе люди получат обновление без объяснения.
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
check('CHANGELOG описывает эту версию', changelog.includes(`## ${version}`), `## ${version}`)

// package-lock обязан идти синком с package.json: реальный инцидент — lock остался на 2.0.8
// при package.json 2.0.11 (npm version бампит оба, но ручной bump package.json — нет).
// Рассинхрон = в релиз уезжает дерево зависимостей, собранное под другую версию.
const lockPath = join(ROOT, 'package-lock.json')
if (check('package-lock.json существует', existsSync(lockPath))) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const lockVersion = lock.version
  const lockRootVersion = lock.packages?.['']?.version
  check(
    'package-lock синком с package.json (version + packages[""])',
    lockVersion === version && lockRootVersion === version,
    `lock: ${lockVersion}/${lockRootVersion} vs package.json: ${version}`,
  )
}

// ─── 3. Артефакты и целостность latest.yml ───────────────────────────────────
console.log('\n[3] Артефакты')
const setup = join(ROOT, 'release', `Verstak-Setup-${version}-x64.exe`)
const portable = join(ROOT, 'release', `Verstak-Portable-${version}-x64.exe`)
const ymlPath = join(ROOT, 'release', 'latest.yml')

const haveSetup = check('Setup.exe собран', existsSync(setup), existsSync(setup) ? `${statSync(setup).size} байт` : '')
check('Portable.exe собран', existsSync(portable), existsSync(portable) ? `${statSync(portable).size} байт` : '')

if (check('latest.yml собран (триггер автообновления)', existsSync(ymlPath)) && haveSetup) {
  const yml = readFileSync(ymlPath, 'utf8')
  const ymlVersion = /^version:\s*(.+)$/m.exec(yml)?.[1]?.trim()
  const ymlSize = Number(/size:\s*(\d+)/.exec(yml)?.[1] ?? 0)
  const ymlSha = /sha512:\s*(\S+)/.exec(yml)?.[1] ?? ''

  check('версия в latest.yml == версии релиза', ymlVersion === version, `${ymlVersion} vs ${version}`)

  const buf = readFileSync(setup)
  const realSize = buf.length
  const realSha = createHash('sha512').update(buf).digest('base64')
  // Если размер/хеш не сойдутся — электрон-апдейтер у пользователя откажется ставить
  // обновление (или поставит битое). Это самая частая причина «обновление не приходит».
  check('размер в latest.yml == реальному Setup.exe', ymlSize === realSize, `${ymlSize} vs ${realSize}`)
  check('sha512 в latest.yml == реальному Setup.exe', ymlSha === realSha, ymlSha === realSha ? 'совпал' : 'НЕ совпал')
}

// ─── 4. Объективные проверки кода ────────────────────────────────────────────
console.log('\n[4] Проверки кода (типы / тесты)')
const run = (label, cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 })
  const out = (r.stdout || '') + (r.stderr || '')
  return { ok: r.status === 0, out }
}

const type = run('type', 'npm', ['run', 'type'])
check('проверка типов без ошибок', type.ok)

// ПАРАЛЛЕЛИЗМ ТЕСТОВ — ЗАМЕРЕН, НЕ ПОДОБРАН НА ГЛАЗ (29.07).
//
// Ограничивает НЕ процессор, а ПАМЯТЬ. На этой машине 16 ГБ, из них свободно ~2:
// остальное держат редакторы, браузеры и сам агент. Полный прогон при разном
// maxWorkers — минимум свободной ОЗУ за прогон / время (json-отчёты, 4 прогона):
//   default (11) — 129 МБ / 108 с  ← запаса нет вовсе
//   6            — 1361 МБ / 118 с
//   4            — 2371 МБ / 142 с ← колено: ниже запас уже не растёт
//   3            — 2261 МБ / 150 с
// Набор во всех четырёх собрался ПОЛНОСТЬЮ (4212) и без падений: на разгруженной
// машине число воркеров не решает ничего. Ограничение нужно ради ЗАПАСА под
// нагрузкой — при 11 воркерах прогон упирается в остаток памяти, Windows уходит в
// пейджинг, тесты массово выбивает глобальным таймаутом 20 000, а часть файлов не
// доходит до сбора. Так дважды отменялась публикация 2.2.21 (4179 и 4172 теста
// вместо 4212). Четыре воркера покупают ~2.2 ГБ форы ценой +34 с.
const GATE_MAX_WORKERS = 4

// Эталон полноты набора: столько тестов собирает ПОЛНЫЙ прогон. Сверка на «не
// меньше», поэтому новые тесты её не ломают; уменьшать число можно только вместе
// с осознанным удалением тестов. Но и оставлять его протухшим нельзя: чем сильнее
// эталон отстал, тем более обрезанный прогон проедет как полный.
// 29.07, после починок живой приёмки: 4237 = 4223 passed + 14 skipped
// (предыдущее значение 4212 = 4198 + 14).
const EXPECTED_TOTAL_TESTS = 4237

// Тесты: известный флейк verstak-cli-toolname виснет, когда порт 11434 СВОБОДЕН
// (Node 24 × undici, см. память проекта). Гейт обязан быть ДЕТЕРМИНИРОВАННЫМ, иначе он
// бесполезен → держим порт ОТДЕЛЬНЫМ процессом (в самом гейте spawnSync блокирует
// event loop, поэтому внутрипроцессный держатель ненадёжен), и тест уходит в skip.
const { spawn } = await import('node:child_process')
const holderProc = spawn('node', ['-e', 'require("http").createServer((q,r)=>r.end("busy")).listen(11434,"127.0.0.1")'], { detached: false, stdio: 'ignore' })
await new Promise(r => setTimeout(r, 800)) // дать порту забиндиться (или упасть на EADDRINUSE — тоже ок)

const reportPath = join(ROOT, 'release', 'gate-tests.json')
mkdirSync(join(ROOT, 'release'), { recursive: true })
// Сносим отчёт прошлого прогона: иначе прогон, который до записи отчёта не дожил,
// сверялся бы по ЧУЖИМ числам — ровно тот класс ошибки, ради которого проверка и
// заводится.
rmSync(reportPath, { force: true })
const tests = run('tests', 'npm', [
  'run', 'test:fast', '--',
  `--maxWorkers=${GATE_MAX_WORKERS}`,
  '--reporter=default', '--reporter=json', `--outputFile=${reportPath}`,
])
try { holderProc.kill() } catch { /* уже мёртв */ }
const failedLine = /Tests\s+(\d+)\s+failed/.exec(tests.out)
const passedLine = /Tests\s+.*?(\d+)\s+passed/.exec(tests.out)
const zeroFailed = !failedLine

// УЛИКА СОХРАНЯЕТСЯ НА ДИСК (29.07). Гейт печатал только сводку «N failed», а
// полный вывод vitest держал в памяти — имя упавшего теста терялось безвозвратно,
// и разобрать падение можно было только повторным прогоном, который его же и
// затирал. Дважды за релиз 2.2.21 это стоило получаса каждый раз.
//
// Пишем ВЕСЬ вывод в файл и печатаем путь. Правило «личность фиксируется ДО
// перезапуска» перестаёт зависеть от того, догадался ли исполнитель.
if (!zeroFailed) {
  const logPath = join(ROOT, 'release', 'gate-tests-failure.log')
  try {
    mkdirSync(join(ROOT, 'release'), { recursive: true })
    writeFileSync(logPath, tests.out, 'utf8')
    // Имена падений вытаскиваем сразу: в выводе vitest они идут строками «× имя».
    const names = [...tests.out.matchAll(/^\s*×\s+(.+?)\s*$/gm)].map(m => m[1])
    console.log(`  ℹ полный вывод тестов сохранён: ${logPath}`)
    if (names.length > 0) {
      console.log('  ℹ упавшие тесты:')
      for (const n of [...new Set(names)]) console.log(`      × ${n}`)
    }
  } catch (err) {
    console.log(`  ℹ не удалось сохранить вывод тестов: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ПОЛНОТА НАБОРА — отдельная проверка, ПЕРЕД вердиктом о падениях (29.07).
//
// Прогон, собравший меньше тестов, чем эталон, ничего не говорит о коде: часть
// файлов до сбора не дошла. Раньше такой прогон читался как обычный красный —
// и полдня ушло на поиск «дефекта», которого не было. Хуже другое: оборванный
// прогон, где всё собранное прошло, гейт объявил бы ЗЕЛЁНЫМ и выпустил недо-
// проверенную сборку. Обе дыры закрывает одна сверка.
let collected = null
try { collected = JSON.parse(readFileSync(reportPath, 'utf8')).numTotalTests } catch { /* отчёта нет */ }
if (typeof collected === 'number') {
  check(
    `набор собран полностью (эталон ${EXPECTED_TOTAL_TESTS})`,
    collected >= EXPECTED_TOTAL_TESTS,
    collected >= EXPECTED_TOTAL_TESTS
      ? `${collected} тестов`
      : `собрано ${collected} из ${EXPECTED_TOTAL_TESTS} — ЭТО ОБОРВАННЫЙ ЗАПУСК, а не вердикт о коде: разгрузи машину и прогони заново`,
  )
} else {
  notes.push('json-отчёт тестов не прочитан — полнота набора не проверена')
}

check('все тесты зелёные (0 падений)', tests.ok && zeroFailed, zeroFailed ? `${passedLine?.[1] ?? '?'} passed` : `${failedLine[1]} failed`)

// ─── Вердикт ─────────────────────────────────────────────────────────────────
console.log('\n=== ВЕРДИКТ ===')
if (failures.length === 0) {
  console.log('🟢 ЗЕЛЁНЫЙ — публиковать МОЖНО.\n')
  for (const n of notes) console.log('  · ' + n)
  process.exit(0)
} else {
  console.log(`🔴 КРАСНЫЙ — публиковать НЕЛЬЗЯ. Провалено проверок: ${failures.length}\n`)
  for (const f of failures) console.log('  ✗ ' + f)
  console.log('\nПубликация заблокирована. Почини причины выше и прогони гейт заново.\n')
  process.exit(1)
}
