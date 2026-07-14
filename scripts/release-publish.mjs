#!/usr/bin/env node
// ПУБЛИКАЦИЯ РЕЛИЗА — только через гейт. Обойти гейт нельзя.
//
// Порядок: гейт → создать GitHub Release → залить Setup + Portable → latest.yml ПОСЛЕДНИМ
// (пока его нет, апдейтер у пользователей ничего не видит и не качает битый фид) →
// проверить публичные ссылки → если публичная проверка не сошлась, САМ снять раздачу.
//
// Токен берётся из Git Credential Manager и НИКОГДА не печатается.
// Запуск: node scripts/release-publish.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = process.cwd()
const REPO = 'frolofpavel/verstak'
const API = `https://api.github.com/repos/${REPO}`
const UP = `https://uploads.github.com/repos/${REPO}`

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const tag = `v${version}`

// ─── 1. ГЕЙТ. Красный → выход. Публикация в обход невозможна. ────────────────
console.log('\n=== ПУБЛИКАЦИЯ ' + tag + ' ===\nСначала гейт — если он красный, публикации не будет.\n')
const gate = spawnSync('node', ['scripts/release-gate.mjs'], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' })
if (gate.status !== 0) {
  console.error('\n🔴 Гейт красный → публикация ОТМЕНЕНА. Ничего не выложено.\n')
  process.exit(1)
}

// ─── 2. Токен (не печатается) ────────────────────────────────────────────────
const cred = spawnSync('git', ['credential', 'fill'], { cwd: ROOT, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' })
const token = /^password=(.+)$/m.exec(cred.stdout || '')?.[1]
if (!token) { console.error('✗ нет GitHub-токена в Git Credential Manager'); process.exit(1) }

/** curl с авторизацией через stdin-конфиг: токен не попадает в argv/ps. */
function curl(args, { input } = {}) {
  const cfg = `header = "Authorization: Bearer ${token}"\nheader = "X-GitHub-Api-Version: 2022-11-28"\n`
  const r = spawnSync('curl', ['-sS', '-K', '-', ...args], { cwd: ROOT, input: input ?? cfg, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' }
}
const json = (s) => { try { return JSON.parse(s) } catch { return {} } }

// ─── 3. Релиз (идемпотентно: если уже есть — дозаливаем недостающее) ─────────
let rel = json(curl([`${API}/releases/tags/${tag}`]).out)
let releaseId = rel.id
if (!releaseId) {
  const notesPath = join(ROOT, 'docs', `RELEASE-${tag}.md`)
  const body = existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : `Verstak ${version}`
  const payload = JSON.stringify({ tag_name: tag, name: `Verstak ${version}`, body, draft: false, prerelease: false })
  // Тело релиза (переносы строк, эмодзи, кириллица) НЕЛЬЗЯ передавать аргументом
  // командной строки: Windows-argv его калечит → GitHub отвечает «Problems parsing JSON».
  // Кладём JSON во временный файл и скармливаем curl'у как @file.
  const tmpBody = join(tmpdir(), `verstak-release-${version}.json`)
  writeFileSync(tmpBody, payload, 'utf8')
  const created = json(curl(['-X', 'POST', `${API}/releases`, '-H', 'Content-Type: application/json', '--data-binary', `@${tmpBody}`]).out)
  try { unlinkSync(tmpBody) } catch { /* best-effort */ }
  releaseId = created.id
  if (!releaseId) { console.error('✗ не удалось создать релиз:', JSON.stringify(created).slice(0, 300)); process.exit(1) }
  console.log(`\n[создан релиз ${tag}, id=${releaseId}]`)
} else {
  console.log(`\n[релиз ${tag} уже есть, id=${releaseId} — дозаливаю недостающее]`)
}

const assets = () => json(curl([`${API}/releases/${releaseId}/assets?per_page=100`]).out)
const uploaded = (name, list) => list.some?.((a) => a.name === name && a.state === 'uploaded')

/** Заливка с ретраями: РФ→GitHub рвёт крупные тела. Неполный ассет удаляем перед повтором. */
function upload(file, name) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const list = assets()
    if (uploaded(name, list)) { console.log(`  ✓ ${name} уже загружен`); return true }
    const dead = Array.isArray(list) ? list.find((a) => a.name === name && a.state !== 'uploaded') : null
    if (dead) curl(['-X', 'DELETE', `${API}/releases/assets/${dead.id}`])
    const size = statSync(file).size
    console.log(`  … ${name} (${size} байт), попытка ${attempt}/6`)
    const r = curl(['--max-time', '1800', '--connect-timeout', '60', '-X', 'POST',
      `${UP}/releases/${releaseId}/assets?name=${name}`,
      '-H', 'Content-Type: application/octet-stream', '--data-binary', `@${file}`])
    if (json(r.out).state === 'uploaded') { console.log(`  ✓ ${name}`); return true }
    console.log('    обрыв, повтор через 8с…')
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},8000)'])
  }
  return false
}

console.log('\n[заливка: Setup → Portable → latest.yml ПОСЛЕДНИМ]')
const setup = join(ROOT, 'release', `Verstak-Setup-${version}-x64.exe`)
const portable = join(ROOT, 'release', `Verstak-Portable-${version}-x64.exe`)
const yml = join(ROOT, 'release', 'latest.yml')

if (!upload(setup, `Verstak-Setup-${version}-x64.exe`)) { console.error('✗ Setup.exe не залился — latest.yml НЕ выкладываю, обновление не пойдёт.'); process.exit(1) }
upload(portable, `Verstak-Portable-${version}-x64.exe`) // не критичен для автообновления
if (!upload(yml, 'latest.yml')) { console.error('✗ latest.yml не залился — обновление людям НЕ раздаётся (это безопасное состояние).'); process.exit(1) }

// ─── 4. Публичная проверка — глазами пользователя, а не по нашему слову ──────
console.log('\n[публичная проверка]')
const dl = `https://github.com/${REPO}/releases/download/${tag}`
const pub = spawnSync('curl', ['-sSL', `${dl}/latest.yml`], { encoding: 'utf8' }).stdout || ''
const pubVersion = /^version:\s*(.+)$/m.exec(pub)?.[1]?.trim()
const okVersion = pubVersion === version
console.log(`  ${okVersion ? '✓' : '✗'} публичный latest.yml отдаёт версию ${pubVersion}`)

const head = spawnSync('curl', ['-sSIL', `${dl}/Verstak-Setup-${version}-x64.exe`], { encoding: 'utf8' }).stdout || ''
const code200 = /HTTP\/[\d.]+ 200/.test(head)
// Берём ПОСЛЕДНИЙ Content-Length: у GitHub первый ответ — 302-редирект (длина 0),
// реальный размер приходит с финального 200 от CDN.
const lenMatch = [...head.matchAll(/[Cc]ontent-[Ll]ength:\s*(\d+)/g)].pop()
const len = Number(lenMatch?.[1] ?? 0)
const realSize = statSync(setup).size
const okSetup = code200 && len === realSize
console.log(`  ${okSetup ? '✓' : '✗'} Setup.exe качается (200, ${len} байт == ${realSize})`)

if (!okVersion || !okSetup) {
  console.error('\n🔴 Публичная проверка НЕ сошлась → снимаю раздачу (люди не получат битое обновление).')
  const list = assets()
  const y = Array.isArray(list) ? list.find((a) => a.name === 'latest.yml') : null
  if (y) curl(['-X', 'DELETE', `${API}/releases/assets/${y.id}`])
  console.error('latest.yml снят. Обновление НЕ раздаётся. Разберись и запусти публикацию заново.\n')
  process.exit(1)
}

console.log(`\n🟢 ОПУБЛИКОВАНО: ${tag}. Автообновление пошло.`)
console.log(`   Откат (остановить раздачу): npm run release:stop\n`)
