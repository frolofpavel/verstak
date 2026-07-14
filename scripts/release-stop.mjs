#!/usr/bin/env node
// АВАРИЙНЫЙ СТОП РАЗДАЧИ — если выложенное обновление оказалось плохим.
//
// Что делает: удаляет `latest.yml` из опубликованного релиза. Именно этот файл —
// триггер автообновления. Без него апдейтер у пользователей НИЧЕГО не видит и не качает.
// Те, кто ещё не обновился, останутся на прошлой версии.
//
// Чего НЕ делает (честно): у тех, кто УЖЕ обновился, версию назад не откатывает —
// electron-updater не понижает версии. Чтобы вернуть их, нужен новый патч-релиз с
// откаченным кодом (`git revert` → `npm run release:build` → `npm run release:publish`).
//
// Запуск: node scripts/release-stop.mjs [версия]   (по умолчанию — из package.json)
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const REPO = 'frolofpavel/verstak'
const API = `https://api.github.com/repos/${REPO}`

const version = process.argv[2] ?? JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const tag = `v${version}`

const cred = spawnSync('git', ['credential', 'fill'], { cwd: ROOT, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' })
const token = /^password=(.+)$/m.exec(cred.stdout || '')?.[1]
if (!token) { console.error('✗ нет GitHub-токена'); process.exit(1) }

function curl(args) {
  const cfg = `header = "Authorization: Bearer ${token}"\nheader = "X-GitHub-Api-Version: 2022-11-28"\n`
  const r = spawnSync('curl', ['-sS', '-K', '-', ...args], { input: cfg, encoding: 'utf8' })
  return r.stdout || ''
}
const json = (s) => { try { return JSON.parse(s) } catch { return {} } }

console.log(`\n=== АВАРИЙНЫЙ СТОП РАЗДАЧИ ${tag} ===\n`)
const rel = json(curl([`${API}/releases/tags/${tag}`]))
if (!rel.id) { console.error(`✗ релиз ${tag} не найден`); process.exit(1) }

const assets = json(curl([`${API}/releases/${rel.id}/assets?per_page=100`]))
const yml = Array.isArray(assets) ? assets.find((a) => a.name === 'latest.yml') : null
if (!yml) {
  console.log('latest.yml уже отсутствует — обновление и так НЕ раздаётся. Ничего делать не нужно.\n')
  process.exit(0)
}

curl(['-X', 'DELETE', `${API}/releases/assets/${yml.id}`])
const after = json(curl([`${API}/releases/${rel.id}/assets?per_page=100`]))
const gone = Array.isArray(after) && !after.some((a) => a.name === 'latest.yml')

if (gone) {
  console.log('🟢 Раздача ОСТАНОВЛЕНА: latest.yml удалён из релиза.')
  console.log('   Кто не обновился — останется на прошлой версии.')
  console.log('   Кто уже обновился — вернуть можно только новым патч-релизом с откаченным кодом.\n')
  process.exit(0)
}
console.error('✗ не удалось удалить latest.yml — проверь права токена\n')
process.exit(1)
