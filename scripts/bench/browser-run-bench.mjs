// P3 кусок 2, вторая ось: ЖИВОЙ ПРОГОН браузерной задачи на дешёвых провайдерах.
//
// ЧТО МЕРИТ: чего стоит браузерная задача целиком — сколько ходов, чем модель
// ориентируется на странице (find против snapshot — считаем ФАКТИЧЕСКИЕ вызовы),
// сколько входных токенов накопилось ЗА ПРОГОН (Д6), сколько это стоит по прайсу
// продукта, дошла ли работа до результата (readback снимается замером, а не со слов
// модели). Провайдер настоящий, страница настоящая, снимок — прод-код.
//
// ЧЕГО НЕ МЕРИТ: полный agent-loop продукта. Здесь цикл сокращён до браузерной оси —
// свой набор инструментов (только browser_*), нет гейтов режима, подтверждений,
// компакции и планов. Это сознательная изоляция: с полным набором дешёвая модель
// уходит в файлы и команды, и замер перестаёт быть о браузере. Значит цифры отвечают
// на вопрос «сколько стоит браузерная работа», а не «сколько стоит задача в продукте».
//
// Запуск: node scripts/bench/browser-run-bench.mjs --project <путь>
//         [--providers deepseek,verstak-gateway] [--tasks habr-search] [--json <файл>]
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const CANDIDATES = [
  { id: 'deepseek', secretKey: 'deepseek_api_key' },
  { id: 'verstak-gateway', secretKey: 'verstak_gateway_api_key' },
  { id: 'zai-coding', secretKey: 'zai_coding_api_key' },
  { id: 'kimi-coding', secretKey: 'kimi_coding_api_key' },
  { id: 'custom-openai', secretKey: 'custom_openai_api_key' },
]

// Три класса страниц — по одной задаче на класс. Формулировки короткие и
// проверяемые: у каждой есть readback, который замер снимает сам.
const TASKS = [
  {
    // Форма без JS-фреймворка. Была на httpbin.org — в день замера он отдавал 503,
    // и каждый ход упирался в таймаут вместо работы. Замер не должен зависеть от
    // аптайма одного чужого сервиса (та же замена сделана в page-bench).
    id: 'static-form', klass: 'static',
    url: 'https://html.duckduckgo.com/html/?q=electron',
    prompt: 'Страница поиска уже открыта в браузере. Найди на ней поле ввода запроса, введи туда «verstak ide» и отправь форму. Потом скажи одной строкой заголовок первого результата.',
  },
  {
    id: 'spa-search', klass: 'spa',
    url: 'https://habr.com/ru/search/?q=electron&target_type=posts&order=relevance',
    prompt: 'Страница поиска Хабра уже открыта в браузере по запросу «electron». Дойди до списка найденных статей и назови три первых заголовка. Если списка не видно — найди на странице элемент поиска и нажми его.',
  },
  {
    id: 'heavy-catalog', klass: 'heavy',
    url: 'https://www.mvideo.ru/noutbuki-planshety-komputery-8/noutbuki-118',
    prompt: 'Каталог ноутбуков М.Видео уже открыт в браузере. Назови три первых товара из списка и цену первого из них.',
  },
]

// Ровно браузерный набор — изоляция оси (см. шапку).
const TOOL_NAMES = [
  'browser_navigate', 'browser_read_page', 'browser_snapshot', 'browser_find',
  'browser_click_by_number', 'browser_type_by_number', 'browser_press_key', 'browser_wait_for',
]

function parseArgs(argv) {
  const args = { project: null, providers: null, tasks: null, json: null, maxTurns: 12, progress: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--project') args.project = resolve(argv[++i])
    else if (a === '--providers') args.providers = argv[++i].split(',')
    else if (a === '--tasks') args.tasks = argv[++i].split(',')
    else if (a === '--json') args.json = resolve(argv[++i])
    else if (a === '--max-turns') args.maxTurns = Number(argv[++i])
    else if (a === '--progress') args.progress = resolve(argv[++i])
    else throw new Error(`Unknown argument: ${a}`)
  }
  if (!args.project) throw new Error('--project <путь> обязателен')
  return args
}

const mods = p => JSON.stringify(join(ROOT, p)).slice(1, -1).replace(/\\\\/g, '/')
const ENTRY = `
export { prepareSystemContext } from '${mods('electron/ai/compose-system.ts')}'
export { systemForProvider } from '${mods('electron/ai/compose-prompt.ts')}'
export { createProvider, PROVIDERS } from '${mods('electron/ai/registry.ts')}'
export { TOOL_DEFS } from '${mods('electron/ai/tools.ts')}'
export { selectAllowedToolDefs } from '${mods('electron/ai/runner-util.ts')}'
export { loadCoreMemory } from '${mods('electron/ai/core-memory.ts')}'
export { PRICES, normalizeModelId } from '${mods('shared/contracts/pricing.ts')}'
export { VSK_SNAPSHOT_TOP_N } from '${mods('shared/browser-snapshot.ts')}'
`

async function bundleAll() {
  const dir = join(dirname(require.resolve('esbuild/package.json')), '..', '.verstak-run-bench')
  mkdirSync(dir, { recursive: true })
  const entry = join(dir, 'entry.mjs')
  writeFileSync(entry, ENTRY, 'utf8')
  const outfile = join(dir, 'bundle.mjs')
  await build({
    entryPoints: [entry], outfile, bundle: true, platform: 'node', target: 'node22', format: 'esm',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
    external: ['better-sqlite3', 'electron', '@homebridge/node-pty-prebuilt-multiarch', '@huggingface/transformers', 'unpdf', 'mammoth', 'exceljs', 'sharp'],
    logLevel: 'silent',
  })
  // Модуль снимка отдельным CJS — его require'ит Electron-раннер для .toString().
  const snapOut = join(dir, 'browser-snapshot.cjs')
  await build({
    entryPoints: [join(ROOT, 'shared', 'browser-snapshot.ts')], outfile: snapOut,
    bundle: true, platform: 'node', target: 'node22', format: 'cjs', logLevel: 'silent',
  })
  return { bundlePath: outfile, snapshotBundlePath: snapOut }
}

function readEncryptedSettings(keys) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(join(process.env.APPDATA, 'verstak', 'storage', 'verstak.db'), { readOnly: true })
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?')
  const out = {}
  for (const k of keys) { const row = stmt.get(k); if (row && row.value) out[k] = row.value }
  db.close()
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const wanted = args.providers ? CANDIDATES.filter(c => args.providers.includes(c.id)) : CANDIDATES.slice(0, 2)
  const tasks = args.tasks ? TASKS.filter(t => args.tasks.includes(t.id)) : TASKS

  const encrypted = readEncryptedSettings([...wanted.map(c => c.secretKey), 'custom_openai_baseurl', 'custom_openai_models'])
  const available = wanted.filter(c => encrypted[c.secretKey])
  const skipped = wanted.filter(c => !encrypted[c.secretKey]).map(c => c.id)
  if (available.length === 0) throw new Error('Ни одного провайдера с ключом в settings')

  const { bundlePath, snapshotBundlePath } = await bundleAll()
  const mod = await import(`file://${bundlePath.replace(/\\/g, '/')}`)

  const userDataDir = mkdtempSync(join(tmpdir(), 'verstak-run-bench-userdata-'))
  const realLocalState = join(process.env.APPDATA, 'verstak', 'Local State')
  if (existsSync(realLocalState)) copyFileSync(realLocalState, join(userDataDir, 'Local State'))

  const workDir = mkdtempSync(join(tmpdir(), 'verstak-run-bench-'))
  const configPath = join(workDir, 'config.json')
  const resultPath = join(workDir, 'result.json')
  const progressPath = args.progress ?? join(workDir, 'progress.log')
  process.stdout.write(`[run-bench] прогресс: ${progressPath}\n`)
  writeFileSync(configPath, JSON.stringify({
    bundlePath, snapshotBundlePath, userDataDir, resultPath, progressPath,
    projectPath: args.project,
    providers: available.map(c => ({ id: c.id, secretKey: c.secretKey })),
    tasks, toolNames: TOOL_NAMES,
    topN: mod.VSK_SNAPSHOT_TOP_N,
    maxTurns: args.maxTurns, turnTimeoutMs: 180000,
    encrypted,
  }), 'utf8')

  const electronBin = require('electron')
  const runner = join(ROOT, 'scripts', 'bench', 'browser-run-bench-electron.cjs')
  const code = await new Promise((res, rej) => {
    const child = spawn(electronBin, [runner], {
      env: { ...process.env, VERSTAK_RUN_BENCH_CONFIG: configPath },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.on('error', rej)
    child.on('exit', c => res(c ?? 1))
  })
  if (!existsSync(resultPath)) throw new Error(`Electron-раннер завершился с кодом ${code}, результата нет`)

  const raw = JSON.parse(readFileSync(resultPath, 'utf8'))
  raw.partial = raw.complete !== true || code !== 0
  raw.exitCode = code
  raw.skippedNoKey = skipped
  raw.commit = process.env.BENCH_COMMIT ?? null

  // Деньги — по прайсу продукта, а не по чужим оценкам (ограничение постановки).
  for (const r of raw.runs) {
    if (r.fatal) continue
    const price = mod.PRICES[mod.normalizeModelId(r.provider, r.model)] ?? mod.PRICES[r.model] ?? null
    r.price = price
    r.costUsd = price
      ? Number((r.totals.inputTokens / 1e6 * price.input + r.totals.outputTokens / 1e6 * price.output).toFixed(4))
      : null
    r.snapshotCalls = r.toolUse?.browser_snapshot ?? 0
    r.findCalls = r.toolUse?.browser_find ?? 0
  }

  const text = JSON.stringify(raw, null, 2)
  if (args.json) { mkdirSync(dirname(args.json), { recursive: true }); writeFileSync(args.json, text, 'utf8') }

  const pad = (s, n) => String(s).padEnd(n)
  const lines = ['']
  if (raw.partial) lines.push(`ЧАСТИЧНЫЙ ЗАМЕР: код выхода ${raw.exitCode}, прогонов ${raw.runs.length} из ${available.length * tasks.length}.`)
  if (skipped.length) lines.push(`Без ключа, не мерились: ${skipped.join(', ')}`)
  lines.push('провайдер        | задача        | ходов | find | snap | вход. ток. | выход | сек | $ | итог')
  for (const r of raw.runs) {
    if (r.fatal) { lines.push(`${pad(r.provider, 16)} | ${pad(r.task, 13)} | ОТКАЗ: ${r.fatal}`); continue }
    lines.push([
      pad(r.provider, 16), pad(r.task, 13), pad(r.turns.length, 5), pad(r.findCalls, 4), pad(r.snapshotCalls, 4),
      pad((r.totals.inputTokens ?? 0).toLocaleString('ru-RU'), 10), pad(r.totals.outputTokens ?? 0, 5),
      pad(Math.round(r.totals.ms / 1000), 3), pad(r.costUsd ?? '—', 6), r.stoppedBy,
    ].join(' | '))
  }
  lines.push('')
  process.stdout.write(lines.join('\n') + '\n')
}

main().catch(err => { process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`); process.exitCode = 1 })
