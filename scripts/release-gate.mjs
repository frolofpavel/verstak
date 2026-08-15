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
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import asar from '@electron/asar'

const require = createRequire(import.meta.url)
const { comparePayloadTrees, describeCompareResult } = require('./payload-compare.cjs')
const { buildReleaseBody } = require('./changelog-notes.cjs')

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
// Проверяем ТЕМ ЖЕ извлекателем, которым публикация берёт тело GitHub Release
// (scripts/changelog-notes.cjs): раньше здесь стоял `includes('## X')`, и секция
// с заголовком, но без текста, гейт проходила — а на странице релиза выходила
// пустота. Одна проверка и один источник: что гейт признал нотами, то и уедет
// на страницу, буква в букву.
const releaseNotes = buildReleaseBody(join(ROOT, 'CHANGELOG.md'), version)
check('CHANGELOG описывает эту версию (непустая секция)', !!releaseNotes,
  releaseNotes ? `## ${version}, ${releaseNotes.length} символов` : `нет непустой секции «## ${version}» — страница релиза выйдет пустой`)

// ВСТРОЕННЫЙ каталог «Что нового» — ТРЕТИЙ источник того же текста, и он отставал
// молча ровно так же, как ноты GitHub: и docs/RELEASE-v*.md, и ENTRIES в
// scripts/sync-verstak-changelog.cjs оборвались на 2.4.2. Следствие было хуже
// пустой страницы: для 2.4.3…2.4.9 описания не осталось НИГДЕ, доступном
// пользователю, — модалка «Что нового» мержит тело с GitHub (там была заглушка)
// со встроенным каталогом (там записи нет) и показывала «описание недоступно».
// Проверка держит третий источник в строю: забыли обновить — релиз не выйдет.
{
  const embedded = readFileSync(join(ROOT, 'electron', 'official-changelog.ts'), 'utf8')
  check('встроенный каталог «Что нового» знает эту версию', embedded.includes(`version: '${version}'`),
    `version: '${version}' в electron/official-changelog.ts (обнови ENTRIES в scripts/sync-verstak-changelog.cjs и прогони node scripts/generate-official-changelog.cjs)`)
}

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

// ─── 3.5 Полнота собранного asar (31.07) ─────────────────────────────────────
// Гейт тестирует ИСХОДНИКИ, а не собранный артефакт, и дважды подряд пропустил
// сборку, где node_modules недоупаковался в asar: 34 пакета вместо 324, транзитив
// `p-retry` отсутствовал, приложение падало на старте `ERR_MODULE_NOT_FOUND:
// Cannot find package 'p-retry'`. Причина — junction в release-build.mjs
// (electron-builder обходил node_modules через reparse-point только на глубину 1).
// ОБА раза гейт был ЗЕЛЁНЫМ, а артефакт нерабочим — ловил только человек на
// установке (шаг update-path). Тесты по исходникам этого класса не видят по
// построению. Поэтому гейт теперь смотрит В САМ asar готового установщика.
console.log('\n[3.5] Полнота собранного asar')
// Порог — из РАБОЧЕЙ сборки: 2.2.21 и починенная 2.3.0 дают 324 уникальных пакета
// node_modules в asar. Берём 300 с запасом на дедуп/разброс версий между сборками
// — и это заведомо выше 34, которые давал junction. Маркер `p-retry` — ровно та
// транзитивная зависимость (@google/genai → p-retry), на которой падало: junction
// её отсекал, полная упаковка включает.
const MIN_ASAR_PACKAGES = 300
if (haveSetup) {
  const asarTmp = join(tmpdir(), `verstak-gate-asar-${version}`)
  try {
    rmSync(asarTmp, { recursive: true, force: true })
    mkdirSync(asarTmp, { recursive: true })
    const sevenZip = join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
    const un = (archive, name) => spawnSync(sevenZip, ['e', archive, `-o${asarTmp}`, name, '-y'], { encoding: 'utf8' })
    // Кастомный установщик (build-setup.cjs) прячет реальный app.asar во вложенный
    // resources/app-payload.7z; у стандартного он лежит в Setup напрямую. Пробуем
    // сперва payload, иначе — asar из Setup напрямую.
    // Паттерн 7za — с ПРЯМЫМИ слэшами: через spawnSync без shell обратный слэш
    // не матчит записи NSIS-архива (проверено: `resources\app…` даёт 0 файлов,
    // `resources/app…` — извлекает).
    un(setup, 'resources/app-payload.7z')
    const payload = join(asarTmp, 'app-payload.7z')
    if (existsSync(payload)) un(payload, 'resources/app.asar')
    else un(setup, 'resources/app.asar')
    const asarPath = join(asarTmp, 'app.asar')
    if (check('app.asar извлечён из установщика', existsSync(asarPath))) {
      const files = asar.listPackage(asarPath).map(f => f.split('\\').join('/'))
      const pkgs = new Set()
      for (const f of files) {
        const i = f.indexOf('node_modules/')
        if (i === -1) continue
        const parts = f.slice(i + 'node_modules/'.length).split('/')
        const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1] ?? ''}` : parts[0]
        if (name) pkgs.add(name)
      }
      check(`в asar не меньше ${MIN_ASAR_PACKAGES} пакетов`, pkgs.size >= MIN_ASAR_PACKAGES, `${pkgs.size} пакетов`)
      check('транзитивная p-retry в asar (маркер полноты)', pkgs.has('p-retry'), pkgs.has('p-retry') ? 'на месте' : 'ОТСУТСТВУЕТ — node_modules недоупакован (junction?)')
    }
  } catch (e) {
    check('asar проверен на полноту', false, String(e).slice(0, 120))
  } finally {
    try { rmSync(asarTmp, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

// ─── 3.55 Пейлоад установщика == win-unpacked (что РЕАЛЬНО ставится) ──────────
// Гейт до 09.08 проверял ЭТАЛОН (win-unpacked), а установщик кладёт пользователю
// содержимое app-payload.7z — и сборщик пейлоада (build-setup.cjs) три версии подряд
// (2.4.5–2.4.7) фильтровал locales\: рендер у установивших падал access violation в
// вечное серое окно, гейт при этом был зелёным — он смотрел не на то дерево.
// Теперь пейлоад извлекается из САМОГО Setup.exe и сверяется с win-unpacked пофайлово
// (имена + размеры; недостающий, обрезанный или лишний файл роняет). Контрольный кейс
// «пейлоад без locales → красный» — tests/scripts/payload-compare.test.ts.
// Именно СВЕРКА, а не smoke, ловит этот класс: живой прогон 09.08 показал, что без
// locales на чистом userData приложение доходит до startup.ok без краша — access
// violation установленных 2.4.5–2.4.7 зависел от состояния реального профиля.
console.log('\n[3.55] Пейлоад установщика == win-unpacked (пофайлово)')
const smokeUnpacked = join(ROOT, 'release', 'win-unpacked')
const payloadTmp = join(tmpdir(), `verstak-gate-payload-${version}`)
let payloadTreeDir = null
if (haveSetup && existsSync(join(smokeUnpacked, 'Verstak.exe'))) {
  try {
    rmSync(payloadTmp, { recursive: true, force: true })
    mkdirSync(payloadTmp, { recursive: true })
    const sevenZip = join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
    // Паттерн с ПРЯМЫМИ слэшами — как в [3.5]: обратный слэш не матчит записи NSIS-архива.
    spawnSync(sevenZip, ['e', setup, `-o${payloadTmp}`, 'resources/app-payload.7z', '-y'], { encoding: 'utf8' })
    const payloadArchive = join(payloadTmp, 'app-payload.7z')
    if (check('app-payload.7z извлечён из Setup.exe', existsSync(payloadArchive))) {
      const treeDir = join(payloadTmp, 'tree')
      const x = spawnSync(sevenZip, ['x', payloadArchive, `-o${treeDir}`, '-y', '-bso0', '-bsp0'], { encoding: 'utf8' })
      if (check('пейлоад распакован полностью', x.status === 0, x.status === 0 ? '' : (x.stderr || '').trim().slice(0, 120))) {
        // smoke [3.6] дальше гоняется на ЭТОМ дереве даже при расхождении сверки:
        // красный от сверки уже есть, а smoke даст вторую улику — как именно умирает.
        payloadTreeDir = treeDir
        const cmp = comparePayloadTrees(smokeUnpacked, treeDir)
        check('пейлоад == win-unpacked пофайлово (имена + размеры)', cmp.ok, describeCompareResult(cmp))
      }
    }
  } catch (e) {
    check('пейлоад сверен с win-unpacked', false, String(e).slice(0, 120))
  }
} else if (!haveSetup) {
  notes.push('[3.55] сверка пейлоада пропущена: Setup.exe не собран')
} else {
  notes.push('[3.55] сверка пейлоада пропущена: release/win-unpacked отсутствует (release-build.mjs должен его сохранять)')
}

// ─── 3.6 Install smoke: приложение ЖИВЁТ, а не просто распаковано ─────────────
// Шаг [3.5] считает пакеты в asar, но не запускает приложение — и гейт дважды был
// зелёным на нежизнеспособной сборке (31.07 недоупакованный asar; 08.08 серое окно
// 2.4.5, render_process_gone), ловил человек постфактум. Теперь запускаем собранное
// приложение в ИЗОЛЯЦИИ (свой userData) и проверяем, доходит ли оно до маркера
// готовности. Источник — дерево пейлоада из Setup.exe ([3.55]), т.е. РОВНО то, что
// получает пользователь; fallback — release/win-unpacked, если Setup не собран.
// settle 8000: render_process_gone установленной 2.4.5–2.4.7 приходил ~0.5 с ПОСЛЕ
// позитивного маркера (did_finish_load) — окно наблюдения после позитива обязано
// накрывать этот класс с запасом. Харнесс доказан на изготовленном мёртвом артефакте
// (scripts/smoke-install.mjs, --break db|renderer --expect FAIL; класс locales smoke
// не ловит — см. [3.55]).
console.log('\n[3.6] Install smoke (приложение живёт)')
const smokeSource = payloadTreeDir ?? smokeUnpacked
if (existsSync(join(smokeSource, 'Verstak.exe'))) {
  const r = spawnSync(
    'node',
    [join(ROOT, 'scripts', 'smoke-install.mjs'), '--source', smokeSource, '--break', 'none', '--expect', 'PASS', '--timeout', '45000', '--settle', '8000'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  const out = (r.stdout || '') + (r.stderr || '')
  // Гейт ОБЯЗАН называть, ЧТО не завелось (маркер/фатал/ранний выход), а не «smoke failed».
  const m = out.match(/→\s*(PASS|FAIL|INCONCLUSIVE)\s*\(([^)]*)\)/)
  const reason = m ? `${m[1]}: ${m[2]}` : (out.trim().split('\n').filter(Boolean).pop() || `exit ${r.status}`)
  check(
    `установленное приложение ЖИВЁТ (smoke на ${payloadTreeDir ? 'пейлоаде из Setup.exe' : 'win-unpacked'})`,
    r.status === 0,
    reason,
  )
} else {
  notes.push('[3.6] install smoke пропущен: нет дерева с Verstak.exe (ни пейлоада, ни win-unpacked)')
}
try { rmSync(payloadTmp, { recursive: true, force: true }) } catch { /* ignore */ }

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
// 30.07, после наследования модели суб-агента (custom-openai 503): 4497 = 4483
// passed + 14 skipped (предыдущие: 4487, 4479, 4469, 4448, 4426, 4418, 4406,
// 4400, 4395, 4385, 4377, 4370, 4364, 4358, 4353, 4348, 4321, 4310, 4290, 4285,
// 4278, 4274, 4267, 4256, 4237, 4212).
// 01.08, браузер этап 1 A: ввод по номеру (browser_type_by_number, мутация) +
// ожидание элемента (browser_wait_for, чтение, честный таймаут) — +9 пинов → 4567.
// 02.08, домашняя страница браузера → about:blank (снят стартовый Google): +4 пина
// на поведение снимок/клик/ввод-по-номеру/ожидание на пустой странице → 4571.
// 02.08, браузер работает БЕЗ открытой вкладки (PersistentBrowser, требование №5/№2):
// +3 пина, что window.verstakBrowser есть при невыбранной вкладке → 4574.
// 02.08, стартовая ГОНКА браузера (честное ожидание готовности, browser-ready.ts):
// +3 пина, что вызов раньше монтирования ждёт появления API → 4577.
// 03.08, VSK-BROWSER-B2 блок 4: browser_find (основной путь адресации) + top-N
// снимка с truncated: +8 пинов (find 5, cap 2, plan-mode-find 1) → 4585.
// 03.08, VSK-BROWSER-B2 блок 2: чтение консоли+сети с редакцией через scanText
// (маска auth-заголовков, URL-секретов; тела не уходят): +9 пинов (redact 6,
// handler-на-пути 2, plan-mode 1) → 4594.
// 03.08, VSK-BROWSER-B2 блок 3: dev_server по конфигу через gated process-registry:
// +10 пинов (core 7: парс/резолв/URL/реюз; handler 3: SEC-CMD на пути + отказы) → 4604.
// 03.08, VSK п.6: память заводится при создании проекта (ensureCoreMemoryFiles):
// +2 пина (создаёт MEMORY.md+USER.md; идемпотентна — не затирает) → 4606
// = 4592 passed + 14 skipped (эталоны до: 4604, 4594, 4585, 4577, 4574, 4571).
// 04.08, задача W5: ручки /connectors — ключи коннекторов тенанта в облаке. +9 пинов
// (форма ответа без значений; requiresAnyOf; отказы по чужому ключу и по типу значения;
// ssh-периметр; изоляция тенантов; DELETE выборочный/идемпотентный; коды доступа;
// e2e-приёмка «задал → прогон использовал → снял») → 4736 = 4721 passed + 15 skipped.
// --- 4736 — ТОЧКА, ОТ КОТОРОЙ ДВЕ ЛИНИИ РОСЛИ ПАРАЛЛЕЛЬНО (merge-base fcb3efa). ---
// Дальше идут ДВЕ родословные, и каждая считает свой итог ОТ 4736. Складывать их
// «по цепочке» нельзя — только приросты; сводка в конце.
//
// Линия A, десктопная (main), +28:
// 04.08, оркестратор (spawn_task_session + seed + 7-й рантайм-флаг) → 4744.
// 04.08, задача 1 дефект (b): честная карточка прерванного ответа
// (buildInterruptedAnswerProgress не выдумывает причину) +4 пина → 4748.
// 05.08, задача 1 (a)+(в) A2: run-finalized перечитывает resumableRuns без рестарта.
// +2 харнес (mid-stream→finish('failed'); порядок «сигнал после статуса»),
// +2 диспетчер (run-finalized → listResumable проекта / фолбэк на store.path),
// +2 storage findResumable (done не предлагается; упавший в сессии предлагается) → 4754.
// 05.08, задача 2 пункт 1: DOCX «туда, где человек найдёт» (папка→alongside,
// вложения→downloads, явный save_to модели перекрывает) + видимый след пути.
// +5 пинов (3 размещения + контроль явного значения + контроль без материалов) → 4759.
// 05.08, задача 2 пункт 2: набор папки в контекст как ПЕРЕЧЕНЬ-ФАКТ (данные, не
// директива). +4 пина (buildMaterialsManifest ×2, appendMaterialsManifest ×2)
// +1 контрольный пин сводки (5 материалов, прочитано 2 → 3 непрочитанных поимённо) → 4764.
//
// Линия B, облачная (headless-line), +15:
// 04.08, W5 добор: optionalKeys в ответе ручек — без него кабинет не мог предложить ещё
// не заданный НЕобязательный ключ. +2 пина (объявлены именами и на готовность не влияют;
// поле считается по коннектору, а не константа) → 4738 = 4723 passed + 15 skipped.
// 04.08, задача W0: облачная задача стала ТРЕДОМ (продолжение, чтение треда,
// список задач по тредам) → 4746.
// 05.08, graceful shutdown облака. Два соседних дефекта одной семьи:
//   а) host.close() закрывал sqlite, не дождавшись живых прогонов, — на SIGTERM
//      задачи людей оставались 'running' до reconcileStale: +3 пина
//      (дожидается; без прогонов не спит; таймаут ограничивает ожидание);
//   б) остановка сервиса ждала ДРЕНАЖ соединений первым, а живой SSE-подписчик
//      держит его вечно — до ожидания прогонов очередь не доходила вовсе: +2 пина
//      (shutdownService завершается при живом стриме; контрольный — стрим реально
//      держит дренаж) → 4751.
//
// 05.08, СЛИЯНИЕ линий перед деплоем облачного ядра. Пересечений по файлам тестов
// между линиями нет, поэтому приросты складываются: 4736 + 28 + 15 = 4779.
// Число посчитано ВРУЧНУЮ по родословным, а не взято из прогона: прогон подтверждает
// его, но не назначает — иначе оборванный запуск однажды переназначит эталон сам.
// 06.08, задача A (счётчик расхода): правило «неизвестна цена кэша → полная цена
// input, не ноль» (cachedTokenRate в shared, единое на renderer+main) +6 пинов
// (3 unit + 3 estimateCost с контролем known/unknown); синхронизация состава таблиц
// цен renderer↔main (+3 записи в cost-guard) + анти-дрейф-пин +3 → 4788.
// 07.08, задача 10 (ФРОНТ оркестратора): spawnChildSession + карточка-след +
// settleSpawnCard (видимая дочерняя сессия, возврат = статус карточки, смерть
// mid-stream по run-finalized) → +8 store-пинов + 6 компонентных пинов = +14.
// 07.08, задача B (первый файл правил выигрывает — МОЛЧА): loadUserLayer теперь
// сообщает проигнорированные проектные файлы правил (поле ignored), прогон предупреждает
// поимённо. +11 пинов (5 loadUserLayer.ignored + 4 buildRuleConflictWarning + 2 проброса
// assembleSendSystem.ruleConflictWarning).
// СЛИЯНИЕ двух параллельных линий 07.08: приросты складываются (файлы тестов не
// пересекаются — оркестратор в store/компонентах, задача B в ai/ipc): 4788 + 14 + 11 = 4813.
// 07.08, починка release-inputs.test.ts (walk-up вместо резолва от cwd, чтобы тест не
// краснел в linked worktree): +3 пина (walk-up находит вход в границе + 2 контрольных:
// нет нигде → красный, только в постороннем предке вне репо → красный) → 4816.
// 07.08, честный статус safe-rebuild (не верим коду возврата npm; проверяем ФАКТ
// загрузки свежим процессом → rebuilt/locked/failed, gate трактует locked как среду):
// +5 пинов classifyRebuildOutcome + 3 пина decideTestGate (locked+ABI→не блок,
// locked+не-ABI→блок, rebuilt+ABI→блок) → 4824.
// 08.08, дефект «идёт»+«завершено» разом (AgentProgressPanel, найден Павлом):
// shouldShowLiveState — живой бейдж не переживает конец прогона (isStreaming
// авторитетен; стрим-флаг согласуется без переписи agentProgress). +6 пинов
// (2 контрольных штаба: завершён+running→скрыт, идёт+running→показан; + done/pending/
// error/blocked) → 4830.
// 08.08, задача A (alongside кладёт РЯДОМ С МАТЕРИАЛАМИ, не в корень проекта):
// resolveDocxDir + generateDocx резолвят alongside в папку материалов (materialsCtx.base
// из композера), когда известна; иначе корень проекта. +4 пина (подпапка→туда, без
// папки→корень, downloads не затирается, generateDocx реально пишет в папку) → 4834.
// 08.08, задача B (run_command не называл оболочку → модель гадала, PowerShell на
// cmd.exe): RUN_COMMAND_SHELL_HINT в описании инструмента (cmd.exe на Windows с
// предупреждением про командлеты, /bin/sh на POSIX). +2 пина → 4836.
// 08.08, хвосты дефекта панели: currentEntry не даёт живой «Сейчас»-заголовок у
// завершённого прогона (+2 пина); finish бампает updated_at до момента финализации —
// честная свежесть (fallback в AgentRunsPanel), +1 пин с зазором времени → 4839.
// 08.08, граница A вариант (i): alongside берёт общий каталог РЕАЛЬНО прочитанных за
// прогон файлов (commonReadDir), зажатый в корень проекта — наблюдение факта, не
// толкование текста. +4 пина (одна подпапка; две подпапки→предок; ничего не читали→undef;
// предок вне корня→зажат, мутация клампа краснеет) → 4843.
// 08.08, C(б) часть 1: карточка-след не намекает на успех — spawnCardStatusLabel,
// done → «прогон завершён» (не «готово»); карточка знает наблюдаемое, не выполнение
// задачи. +3 пина (done нейтрально; running; error/terminated) → 4846.
// 08.08, C гард глубины спавна: spawn_task_session даётся только КОРНЮ (не дочерней
// сессии) — offersSpawnTaskSession. Без гарда дерево видимых чатов росло без предела;
// держал случайно лишь малый бюджет ребёнка. +4 пина (родитель→есть; ребёнок→нет;
// флаг выкл→нет у обоих), мутация краснеет → 4850.
// 08.08, ПОЧИНКА сигнала гарда: 1635d48 использовал runner-поле parentChatId (= текущий
// chatId у ЛЮБОГО прогона) → снял бы spawn у всех чатов. Верный сигнал — isChildSession
// (chat_sessions.parent_chat_id, считает main из getChatParentChatId). +2 пина проводки в
// agent-loop (корень→есть; ребёнок→нет), мутация возврата к parentChatId краснеет → 4852.
// 08.08, C(а) бюджет+seed: спавн-сессия получает SPAWN_TASK_TURNS=24 (resolveTurnsBudget
// при isChildSession), seed сообщает бюджет ФАКТОМ. +4 пина resolveTurnsBudget (обычная→
// DEFAULT; дочерняя→SPAWN>DEFAULT; явный побеждает; потолок MAX) + 2 пина seed (факт;
// без бюджета блока нет), мутация fallback краснеет. ЭФФЕКТ (артефакт дошёл) — живая
// проверка вечером. → 4858.
// 08.08, аудит безопасности (свою свежую правку — злее): кламп commonReadDir не
// обходится через `..` в read-пути (resolve нормализует + isWithinKnownRoots realpath
// ловит). +2 пина (одиночный `..`-беглец; смесь легального и беглеца → зажат) → 4860.
// 08.08, СЕДЬМОЙ ОБХОД ГЕЙТА (штаб нашёл): артефакты (generate_docx/html/render_chart)
// писали файл на диск в ЛЮБОМ режиме, включая plan — не были ни в одной категории
// mode-policy, и хендлеры не звали resolveDecision. Закрыто: гейтятся как браузерная
// мутация (block в plan, иначе auto — не isEdit, т.к. модалки confirm нет и она дала бы
// ложный Policy Center), + гейт resolveDecision в трёх хендлерах. +5 пинов mode-policy
// (3 артефакта + симметрия с browser_click + blockReason) + 6 пинов энфорсмента в
// хендлере (plan→блок, auto→проходит), мутация краснит оба слоя → 4871.
// 08.08, семейство артефактов ЗАКРЫТО целиком: + create_proof_video (пишет MP4 через
// ffmpeg, тоже проходил мимо гейта). +1 пин mode-policy + 2 пина хендлера (plan→блок;
// auto→гейт пройден, ошибка про кадры, не про режим) → 4874.
// 08.08, ВОСЬМОЙ ОБХОД (эскалация режима через спавн, в опубликованной 2.4.4): дочерняя
// сессия исполнялась под ГЛОБАЛЬНЫМ режимом, а не режимом родителя → снимала plan/ask.
// Починка: spawnChildSession наследует режим родительского чата (readAgentMode) + spawn_
// task_session под mode-policy (block в plan) + гейт в хендлере. +4 пина (2 mode-policy,
// 1 гейт хендлера, 1 наследование режима), мутация «не наследуем» краснит → 4878.
// 08.08, СЛИЯНИЕ с main: параллельная линия PRICES (разбивка расхода сходится с «Итого»,
// кэш показан при неизвестной цене) дала +3 к общей базе 4860 (см. tests/lib/pricing.test.ts).
// Разрешение конфликта эталона СУММОЙ приростов обеих линий: 4860 + 3 (PRICES) + 18
// (седьмой 11 + create_proof_video 3 + восьмой 4) = 4881.
// 09.08, аудит периметра (линия 1, поверх main 4881): три НОВЫХ обхода утечки —
// (1) чтение файла ВНЕ проекта через инъекцию !`cmd` в слэш-команде недоверенного репо
// (кавычки `type "C:\…"` и Windows backslash/UNC сдвигали путь за якорь сырой регулярки
// OUT_OF_PROJECT_PATH_RE → пер-токенная проверка со снятыми кавычками);
// (2) Authorization/Proxy-Authorization: Basic <base64> мимо scanText (base64 = user:pass;
// сканер знал Bearer/token, не Basic → добавлен basic\s+);
// (3) web_fetch молча вырезал секрет из ИСХОДЯЩЕГО URL (его выбирает модель), пряча САМ
// факт исходящей утечки из аудита → видимый leakNote.
// +2 пина injection (backslash/UNC + кавычки) + 2 пина scanner (Basic/Proxy) + 1 пин
// web-handler (SEC + контроль чистого URL), у каждого мутация фикса краснит → 4886.
// 09.08, СЛИЯНИЕ линии ревью кода в main(5565d14, эталон 4886). Внесены: (A) рефактор —
// CLI_WITH_TIMELINE и secretProtectionLevel+MATRIX сведены в shared/contracts/cli-
// capability.ts (одна правда renderer↔main), тавтологичный анти-дрейф-пин «копия==копия»
// снят и заменён прямыми пинами уровней + референсной идентичностью; (B) починка
// verstak/free — gateway-пресет показывался в пикере сырым id (renderer-карта меток
// разошлась с main), карта вынесена в чистый src/lib/gateway-preset-labels.ts, метка
// добавлена, лживый «Зеркало»-коммент снят, пин «у КАЖДОГО пресета есть метка» красный
// ДО фикса на verstak/free.
// ЭТАЛОН ИЗМЕРЕН, НЕ СУММИРОВАН: полный сбор merged-дерева = 4888 / 0 падений / 1613
// файлов (json-reporter). Наивная сумма (4886 + написанные пины) разошлась, потому что
// provider-model-drift.test.ts генерит тесты ДИНАМИЧЕСКИ — по одному на обнаруженный
// policy-файл, и новый shared/contracts/cli-capability.ts попал под детектор, изменив
// счёт без единого написанного it(). ⇒ правило: при слиянии эталон = ИЗМЕРЕННЫЙ полный
// сбор на слитом дереве, сумма — лишь ожидание для сверки (разошлось → взять факт).
// 09.08, СЛИЯНИЕ линии безопасности (блок 2, девятый обход) поверх main 4888: наследование
// toolsAllow дочерней сессией + гейт tools_allow на исполнении (dispatchToolTurn) +
// общий предикат resolveToolsAllowSet + fail-open trace. +16 написанных it() (7 dispatch-gate,
// 5 предикат, 2 spawn-child, 1 fail-open, 1 spawn-card forward). ИЗМЕРЕНО на слитом дереве:
// полный сбор = 4904 / 0 падений (сумма 4888+16 совпала — новых policy-файлов под
// provider-model-drift не добавлено, все 16 статичны).
// 09.08, блок 3 линии безопасности (тесты, зависящие от живой машины): изоляция
// skills-loader-parse от РЕАЛЬНЫХ домашних деревьев (реальный скан → контролируемые
// temp-корни + пин «посторонний корень не подмешивается») и внутренний бюджет скана
// no-binary-sources (осмысленная ошибка вместо безымянного таймаута под нагрузкой).
// +3 it() (skills: реальный скан 1 → 2 изолированных; no-binary: +2 контроля бюджета).
// ИЗМЕРЕНО на слитом дереве: 4907 / 0 падений (сумма 4904+3 совпала).
// 09.08, блок 4 линии безопасности (последний дубль renderer↔main): PRICES + normalizeModelId
// переехали в shared/contracts/pricing.ts (единый источник, оба слоя ре-экспортируют).
// Анти-дрейф-пин prices-drift.test.ts снят как тавтология (−3), вместо него прямые пины на
// значения pricing-shared.test.ts (+8). Значения цен НЕ тронуты (verbatim, состав 55).
// Характеризация расчёта на обоих слоях (pricing.test + cost-guard.test, 68 пинов) зелена
// БЕЗ правок → поведение не изменилось, это рефактор. ИЗМЕРЕНО: 4912 / 0 (сумма 4907−3+8).
// 09.08, линия native-ABI+smoke: три fail-closed точки класса «native ABI в релизе»
// (обеззараженная самопочинка / гард afterPack / ABI на выходе сборки) + install smoke-тест
// (доказан на ИЗГОТОВЛЕННОМ мёртвом артефакте: целая→PASS, без .node→FAIL, без preload→FAIL
// через render-краш). +20 статичных пинов: native-abi 5, repair 3, afterPack 4, smoke-verdict 8.
// Линия измерила 4927 поверх main 4907 — но пока она мерила, в main лёг блок 4 (4912).
// 09.08, ФИНАЛЬНОЕ СЛИЯНИЕ ночи (штаб): линия безопасности (4912) + линия native-ABI+smoke (+20).
// Разошедшиеся эталоны двух линий НЕ складывались вслепую и не брались по большему —
// пересчитаны ИЗМЕРЕНИЕМ на фактически слитом дереве, ровно по правилу §3.1.
// Промежуточный замер (безопасность + native-ABI/smoke): 4933 / 0 / 1624 файла. Ожидание
// было 4932 (4912 + 20) и разошлось на +1 — записано намеренно: это третий подряд случай,
// когда арифметика приростов не сходится с фактом, и лучшая иллюстрация, зачем правило
// «мерить, а не складывать» появилось.
// 09.08, ЧЕТВЁРТАЯ линия ночи (охота на баги, claude/cranky-dhawan-007a8b): pie-срез 100%,
// осадка карточки-следа по правде БД + след в журнале, версия в карточке обновления,
// и корень «тесты писали в БОЕВОЙ errors.jsonl» (эта улика уже увела штаб на несуществующий
// дефект searchMemories — 336 «прод-записей» оказались все до одной тестовыми).
// ФИНАЛ НОЧИ, ИЗМЕРЕНО на полном слитом дереве: 4948 / 0 падений / 1631 файл
// (json, --maxWorkers=4). Это число — о том дереве, которое реально лежит в main.
// 09.08, установщик терял locales (серые окна 2.4.5–2.4.7): пины на пейлоад-сборщик
// (build-setup-payload 4) + пофайловую сверку пейлоада с win-unpacked (payload-compare 4,
// контрольный «без locales → красный») + watchdog смерти рендера (render-watchdog 5).
// ИЗМЕРЕНО на дереве поверх main 4702c5d: 4961 / 0 падений / 570 файлов
// (json, --maxWorkers=2 — машина под параллельной работой; сумма 4948+13 совпала).
// 09.08 (вечер), подготовка измерителя к baseline Arena (постановка V2 §5): метрика
// «проверил ли себя агент» (eval-self-check 12) + флаг --provider у Arena (2) +
// 4 фикстуры классов задач (тестов не добавляют — генерятся не они, а проверяет их
// harness-пин). ИЗМЕРЕНО на дереве поверх main aeff042: 4975 / 0 падений / 572 файла
// (json, --maxWorkers=2; сумма 4961+14 совпала).
// 09.08 (ночь), фикс скана утечек Arena (живой baseline: имя workspace-каталога
// 'task-refinement' матчило sk-паттерн — детектор резал прогоны за свой путь):
// scanRunnerOutputForSecretLeak + 4 пина. ИЗМЕРЕНО: 4979 / 0 (сумма 4975+4 совпала).
// 09.08 (ночь), ещё два ложных вердикта живого baseline: classify требовал изменённый
// файл у review-фикстуры БЕЗ объявленных правок; «модель недоступна» матчилось на
// имени workspace и контенте задач ПРО модели при exit 0. arena-classify.mjs + 7 пинов.
// ИЗМЕРЕНО: 4986 / 0 (сумма 4979+7 совпала).
// 09.08 (ночь), Agent Runtime V2 — первые два пункта плана §5: V2-1 Focus Chain
// (реинжект по признаку вместо модуля константы; прежнее условие turn % 8 при
// бюджете 8 не срабатывало НИ РАЗУ — 8 пинов) + V2-3 completion gate на чат-пути
// (записи без единой проверки не выпускают финал; bounded, дальше видимое
// «не проверено» — 13 пинов). ИЗМЕРЕНО: 5007 / 0 (сумма 4986+21 совпала).
// 10.08, V2-3 проведён и на CLI-путь: Arena гоняет scripts/verstak-cli.mjs с
// СОБСТВЕННЫМ agent-loop (не импортирует electron/), поэтому правка только в
// runner-api.ts измерителю не видна вовсе. Правило вынесено в ЕДИНЫЙ источник
// scripts/agent-completion-gate.mjs (CLI зовёт напрямую, десктоп ре-экспортирует
// через .d.mts — allowJs не включали); +2 пина (референсная идентичность модулей
// и факт вызова гейта в CLI-цикле). ИЗМЕРЕНО: 5009 / 0.
// 10–11.08 (пакет 2.5.0): A1 5134 → 5140, A2 → 5143, B1 → 5148, C1 → 5166,
// C2 → 5173, D1 → 5180 — каждый раз ИЗМЕРЕНО прогоном слитого дерева.
// 11.08 (волна 2.6.0): V2 скорость 5180 → 5197 (три оси одним замером);
// V5 авто-режим → 5209; V3 автопилот проверок → 5226; V1 чистый подвал → 5231;
// P1 цена принятого результата → 5257; P2 правила проекта → 5267
// (--maxWorkers=4; 5252 passed + 15 skipped).
// 11.08 P1 шаги 1–2 (startTrialRuns + оценка до запуска) → 5309 (измерено,
// --maxWorkers=4; 5294 passed + 15 skipped; +20 новых + 2 динамических у
// bridge-стража result-trials — по тесту на добавленный канал).
// 11.08 P1 шаг 3 (панель состязания в «Истории работы») → 5335 (измерено,
// --maxWorkers=4; 5320 passed + 15 skipped; +20 хелперы trial-view + 6 панель).
// 12.08 пакет багов живой приёмки P1 (Б1 гард главного окна, Б2 авто-отказ
// подтверждений скрытого чата, Б3 ярлык stopped/settings-мусор/401-перевод)
// → 5366 (измерено, --maxWorkers=4; 5351 passed + 15 skipped).
// 12.08 P8 «MCP первоклассный» (каталог серверов, видимость подтверждений,
// честный отказ client.ts, win32 npx-резолв) → 5381 (измерено, --maxWorkers=4;
// 5366 passed + 15 skipped).
// 12.08 P3 кусок 2 «встроенный браузер отрисовывает SPA» (CSP приложения больше не
// штампуется на чужие страницы, слот вне вкладки живой, троттлинг вкладок снят)
// → 5387 на своей ветке.
// 13.08 P3 кусок 2, вторая половина блокера (иконочный контрол без семантики попадает
// в снимок) → 5389 на своей ветке. Две линии закрывали ОДИН блокер с разных сторон:
// первая — «страница не отрисовалась», вторая — «отрисовалась, но нажать не на что».
// Число ниже ИЗМЕРЕНО на слитом дереве, а не сложено из приростов (§3.1).
// 13.08 пакет C (девять мелких правок C1–C9) → 5441 ИЗМЕРЕНО на ветке пакета
// (`npm run test:fast --maxWorkers=4`, 0 падений). ВНИМАНИЕ штабу: это замер
// ОДНОЙ линии, а не слитого дерева. При вливании нескольких линий сразу число
// обязано быть перемерено на слитом дереве — складывать приросты линий нельзя
// (provider-model-drift генерит тесты динамически, §3.1).
// 14.08 «MCP доходит до CLI-провайдеров» (проброс серверов Verstak в claude-cli
// через --mcp-config) → 5460 ИЗМЕРЕНО на ветке линии (`npm run test:fast
// --maxWorkers=4`, 0 падений, +19 пинов моста и состава argv), затем 5463 — там же
// +3 интеграционных пина стыка «подключённый сервер → аргументы claude» (реальный
// дочерний процесс сервера, форма записи берётся из McpClient, а не из фикстуры).
// Та же оговорка, что и у 5441: замер ОДНОЙ линии; при вливании нескольких —
// перемерить на слитом дереве.
// 15.08 P3 кусок 3 «изолированная браузерная сессия (Playwright)» → 5511 ИЗМЕРЕНО на
// ветке линии (`npx vitest run --maxWorkers=4`, 0 падений, 1828 файлов). Прирост +48
// при 47 написанных руками пинах — сорок восьмой РОДИЛСЯ САМ: сетка
// browser-activity-labels перебирает браузерную группу TOOL_DEFS через it.each, и
// новый browser_close_session добавил ей кейс. Ровно тот случай, ради которого
// правило «эталон ИЗМЕРЯЙ, не складывай приросты» и существует: сумма по диффам дала
// бы 5510 и обрезанный прогон проехал бы как полный.
// Та же оговорка: замер ОДНОЙ линии; при вливании нескольких — перемерить на слитом.
// 15.08 «дыры ревизии 15.08» (тесты на БОЕВОЙ путь гейтов, §2 отчёта) → 5520 ИЗМЕРЕНО
// на ветке линии (`npm run test:fast -- --maxWorkers=4`, 0 падений, 1831 файл): +9 пинов
// на `mcpToolHandler` (§2.3 боевой MCP-гейт + §2.11 deny-правило). Файл боевого гейта до
// этого не импортировал ни один тест — любая правка внутри него была для набора невидима.
// Та же оговорка: замер ОДНОЙ линии; при вливании нескольких — перемерить на слитом.
// 15.08 продолжение той же линии → 5526 ИЗМЕРЕНО: +6 пинов на рантайм-гейты API-цикла
// (§2.4 обрыв по лимиту расхода, §2.1 ВТОРОЙ выход гейта завершения, §2.2 реинжект
// Focus Chain). Все три стерегли только чистые функции; вызывается ли решение в бою,
// не проверял никто.
// Та же оговорка: замер ОДНОЙ линии; при вливании нескольких — перемерить на слитом.
// 15.08 та же линия → 5533 ИЗМЕРЕНО: +7 пинов (§2.7 запрет секрето-путей на боевом пути
// артефактов, §2.6 op-политика read-only для расписанных прогонов).
// Та же оговорка: замер ОДНОЙ линии; при вливании нескольких — перемерить на слитом.
const EXPECTED_TOTAL_TESTS = 5533

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
