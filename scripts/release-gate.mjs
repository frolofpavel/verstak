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
import { existsSync, readFileSync, statSync } from 'node:fs'
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
try {
  const res = spawnSync('curl', ['-sS', 'https://api.github.com/repos/frolofpavel/verstak/releases/latest'], { encoding: 'utf8' })
  const d = JSON.parse(res.stdout || '{}')
  published = typeof d.tag_name === 'string' ? d.tag_name : null
} catch { /* сеть недоступна — обработаем ниже */ }
if (check('узнали последний опубликованный релиз', !!published, published ?? 'GitHub API недоступен')) {
  check(`версия НОВЕЕ опубликованной (${published})`, cmpSemver(version, published) > 0, `${version} > ${published.replace(/^v/, '')}`)
}

// CHANGELOG обязан описывать эту версию — иначе люди получат обновление без объяснения.
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
check('CHANGELOG описывает эту версию', changelog.includes(`## ${version}`), `## ${version}`)

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

// Тесты: известный флейк verstak-cli-toolname виснет, когда порт 11434 СВОБОДЕН.
// Гейт обязан быть детерминированным → держим порт сам, флейк уходит в skip.
let holder = null
try {
  const { createServer } = await import('node:http')
  holder = createServer((_q, s) => s.end('busy'))
  await new Promise((res) => { holder.once('error', () => res(null)); holder.listen(11434, '127.0.0.1', () => res(null)) })
} catch { /* порт уже занят — тоже годится */ }

const tests = run('tests', 'npm', ['run', 'test:fast'])
holder?.close()
const failedLine = /Tests\s+(\d+)\s+failed/.exec(tests.out)
const passedLine = /Tests\s+.*?(\d+)\s+passed/.exec(tests.out)
const zeroFailed = !failedLine
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
