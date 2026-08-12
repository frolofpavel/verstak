#!/usr/bin/env node
/**
 * ЖИВОЙ СМОУК: отрисовывает ли встроенный браузер выдачу SPA, пока его вкладка ЗАКРЫТА.
 *
 * Зачем отдельно от vitest: дефект не виден в jsdom ПО ПОСТРОЕНИЮ — там нет ни вьюпорта,
 * ни кадров, ни настоящего IntersectionObserver. Измеряется он только в настоящем
 * Chromium внутри <webview>, поэтому смоук живёт рядом с `smoke:agency-ui`, а не в гейте.
 *
 * Стиль слота берётся ИЗ ПРОДУКТА (`shared/browser-slot-style.ts`, транспиляция esbuild
 * на лету). Копии стиля здесь нет намеренно: копия была бы зелёной при сломанном
 * продукте (CLAUDE.md §3.1 — фикстура обязана совпадать с продовой формой).
 *
 * Запуск: npm run smoke:browser-spa
 * Итог: таблица по трём состояниям слота + вердикт.
 *   PASS — при ЗАКРЫТОЙ вкладке фикстура отдала результаты;
 *   FAIL — выдачи нет (ровно наблюдение Павла 10.08).
 * Строка `display:none` в таблице — КОНТРОЛЬНЫЙ случай: он обязан остаться нулевым,
 * иначе замер ничего не измеряет (§3.1 — рядом с «не произошло» нужен случай, где
 * то же самое ПРОИСХОДИТ, и наоборот).
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const fixtures = path.join(root, 'scripts', 'fixtures')
const CASE_TIMEOUT_MS = 90_000

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => (port ? resolve(port) : reject(new Error('нет свободного порта'))))
    })
  })
}

/** Стиль слота — из продукта, а не из копии. */
async function loadSlotStyle(tmp) {
  const esbuild = await import('esbuild')
  const outfile = path.join(tmp, 'browser-slot-style.mjs')
  await (esbuild.default ?? esbuild).build({
    entryPoints: [path.join(root, 'shared', 'browser-slot-style.ts')],
    outfile, format: 'esm', platform: 'neutral', bundle: true, logLevel: 'silent',
  })
  return import(pathToFileURL(outfile).href)
}

function runCase(dir, url, css) {
  return new Promise((resolve, reject) => {
    const electron = createRequire(path.join(root, 'package.json'))('electron')
    const child = spawn(electron, [dir], {
      env: { ...process.env, SMOKE_URL: url, SMOKE_CSS: css },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`случай не ответил за ${CASE_TIMEOUT_MS / 1000} с`))
    }, CASE_TIMEOUT_MS)
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    child.on('exit', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const line = out.split(/\r?\n/).find(l => l.startsWith('SMOKE '))
      if (!line) return reject(new Error('нет строки замера SMOKE:\n' + out.slice(0, 2000)))
      try { resolve(JSON.parse(line.slice(6))) } catch (e) { reject(e) }
    })
  })
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vsk-spa-smoke-'))
  const { browserSlotCssText } = await loadSlotStyle(tmp)

  fs.writeFileSync(path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'vsk-spa-smoke', version: '1.0.0', main: 'smoke-browser-spa-main.cjs' }))
  for (const f of ['smoke-browser-spa-main.cjs', 'smoke-browser-spa-host.html']) {
    fs.copyFileSync(path.join(fixtures, f), path.join(tmp, f))
  }

  const fixture = fs.readFileSync(path.join(fixtures, 'spa-lazy-search.html'), 'utf8')
  const port = await findFreePort()
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(fixture)
  })
  await new Promise(r => server.listen(port, '127.0.0.1', r))
  const url = `http://127.0.0.1:${port}/`

  // `open` — контроль работоспособности фикстуры: без него «выдачи нет» зелено и
  // тогда, когда её не бывает ни при каких условиях. `displaynone` — контроль в
  // обратную сторону: состояние, которое обязано остаться сломанным.
  const cases = [
    { id: 'open', title: 'вкладка ОТКРЫТА (контроль «работает»)', css: browserSlotCssText(true) },
    { id: 'closed', title: 'вкладка ЗАКРЫТА (продукт сейчас)', css: browserSlotCssText(false) },
    { id: 'displaynone', title: 'вкладка ЗАКРЫТА через display:none (контроль «ломается»)', css: 'display:none' },
  ]

  const results = []
  for (const c of cases) results.push({ ...c, ...(await runCase(tmp, url, c.css)) })
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })

  const pad = (s, n) => String(s).padEnd(n)
  console.log(`\nЗАМЕР: отрисовка SPA-выдачи во встроенном браузере (фикстура ${url})\n`)
  console.log(pad('состояние слота', 56), pad('вьюпорт', 12), pad('rAF/с', 7), pad('IO', 5), 'результатов')
  console.log('-'.repeat(100))
  for (const r of results) {
    console.log(pad(r.title, 56), pad(`${r.innerW}x${r.innerH}`, 12), pad(r.rafPerSec, 7), pad(r.ioFired ? 'да' : 'нет', 5), r.results)
  }
  console.log('')

  const open = results.find(r => r.id === 'open')
  const closed = results.find(r => r.id === 'closed')
  const none = results.find(r => r.id === 'displaynone')

  if (!open || open.results === 0) {
    console.log('НЕВАЛИДНЫЙ ПРОГОН: фикстура не отдала выдачу даже при открытой вкладке — мерить нечего.')
    process.exit(3)
  }
  if (none.results > 0) {
    console.log('НЕВАЛИДНЫЙ ПРОГОН: display:none тоже отдал выдачу — фикстура перестала ловить класс дефекта.')
    process.exit(3)
  }
  if (closed.results === 0) {
    console.log('FAIL: при ЗАКРЫТОЙ вкладке выдачи НЕТ — страница живёт с нулевым вьюпортом. Это дефект P3.')
    process.exit(1)
  }
  console.log(`PASS: при ЗАКРЫТОЙ вкладке выдача отрисована (${closed.results} результатов), первый — «${closed.first}».`)
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
