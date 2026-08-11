// Ускорение 2.6.x, шаг 2 (модуль 4): что реально держит main-поток.
//
// ЧТО МЕРИТ: длительность И максимальный стоп event-loop'а main-процесса
// (perf_hooks.monitorEventLoopDelay) на операциях-кандидатах ТЗ — диффы,
// secret-scanner, поиск по деревьям, SQLite — исполняя ТОТ ЖЕ код, что в
// проде (реальные модули через esbuild-бандл, приём preflight-bench.mjs).
// «Блокирует ли UI» — это maxStall: у синхронной операции он ≈ её длительности,
// у по-настоящему асинхронной (child-process ripgrep) ≈ 0. Это и есть число
// блокировки, а не список подозреваемых (урок 11.08: ошибка обоснования в
// 600 раз — CLAUDE.md, детали постановки ускорение-2.6.x.md).
//
// ЧЕГО НЕ МЕРИТ: renderer (DiffView, список сообщений — другой процесс),
// сеть/провайдера, IPC-сериализацию.
//
// SQLite меряется на РЕЗЕРВНОЙ КОПИИ живой БД (better-sqlite3 online backup):
// оригинал не трогаем, копия удаляется после прогона.
//
// Запуск: node scripts/bench/main-thread-bench.mjs --project <большой каталог>
//         [--db <verstak.db>] [--json <файл>] [--skip-heavy]
// --skip-heavy: пропустить сборку графа зависимостей (минуты на 45k файлов).
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function parseArgs(argv) {
  const args = { project: null, db: null, json: null, skipHeavy: false, onlyHeavy: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--project') args.project = resolve(argv[++i])
    else if (a === '--db') args.db = resolve(argv[++i])
    else if (a === '--json') args.json = resolve(argv[++i])
    else if (a === '--skip-heavy') args.skipHeavy = true
    // Только граф зависимостей (минуты на 45k файлов) — отдельным запуском,
    // чтобы дешёвые замеры не ждали и не делили процесс с тяжёлым.
    else if (a === '--only-heavy') args.onlyHeavy = true
    else throw new Error(`Unknown argument: ${a}`)
  }
  if (!args.project) throw new Error('--project <путь> обязателен (каталог Downloads-класса)')
  if (!args.db) args.db = join(process.env.APPDATA, 'verstak', 'storage', 'verstak.db')
  return args
}

const mods = p => JSON.stringify(join(ROOT, p)).slice(1, -1).replace(/\\\\/g, '/')
const ENTRY = `
export { scanText, maskSecretsForDiff } from '${mods('electron/ai/secret-scanner.ts')}'
export { applySearchReplaceBlocks, createFileTools } from '${mods('electron/ai/tools.ts')}'
export { getProjectMap, getDependencyMap, invalidateProjectMap, invalidateDependencyMap } from '${mods('electron/ai/project-map.ts')}'
export { compactToolHistory } from '${mods('electron/ai/compact-history.ts')}'
export { loadCoreMemory } from '${mods('electron/ai/core-memory.ts')}'
export { openDb } from '${mods('electron/storage/db.ts')}'
export { createAgentRuns } from '${mods('electron/storage/agent-runs.ts')}'
export { searchMemories } from '${mods('electron/storage/memories.ts')}'
`

async function bundle() {
  const dir = join(dirname(require.resolve('esbuild/package.json')), '..', '.verstak-main-thread-bench')
  mkdirSync(dir, { recursive: true })
  const entry = join(dir, 'entry.mjs')
  writeFileSync(entry, ENTRY, 'utf8')
  const outfile = join(dir, 'bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
    external: ['better-sqlite3', 'electron', '@homebridge/node-pty-prebuilt-multiarch', '@huggingface/transformers', 'unpdf', 'mammoth', 'exceljs', 'sharp'],
    logLevel: 'silent',
  })
  return outfile
}

/**
 * Одно измерение: стена + максимальный стоп event-loop за время работы.
 * После работы даём циклу один тик, чтобы гистограмма увидела задержку
 * (синхронный блок виден только следующему тику таймера).
 */
async function measure(op, fn, iters = 1) {
  const wall = []
  let maxStall = 0
  for (let i = 0; i < iters; i++) {
    const h = monitorEventLoopDelay({ resolution: 5 })
    h.enable()
    // Базовая итерация цикла ДО работы: без неё синхронный блок, начатый в той же
    // итерации, что enable(), не попадает в гистограмму (проверено первым прогоном:
    // sync-операции показывали stall 0 при стене 70-150ms).
    await new Promise(r => setTimeout(r, 0))
    const t0 = process.hrtime.bigint()
    let error = null
    try { await fn() } catch (err) { error = err instanceof Error ? err.message : String(err) }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    await new Promise(r => setTimeout(r, 0))
    h.disable()
    if (error) return { ...op, error }
    wall.push(ms)
    maxStall = Math.max(maxStall, h.max / 1e6)
  }
  wall.sort((a, b) => a - b)
  const r1 = v => Math.round(v * 10) / 10
  return {
    ...op,
    iterations: iters,
    medianMs: r1(wall[Math.floor(wall.length / 2)]),
    maxMs: r1(wall[wall.length - 1]),
    maxStallMs: r1(maxStall),
  }
}

/** Реалистичные текстовые входы — реальные исходники репозитория, не lorem. */
function textSamples() {
  const big = readFileSync(join(ROOT, 'src', 'styles', 'layout.css'), 'utf8')
  const code = readFileSync(join(ROOT, 'electron', 'ipc', 'ai.ts'), 'utf8')
  const mk = n => {
    let s = ''
    while (s.length < n) s += big + '\n' + code + '\n'
    return s.slice(0, n)
  }
  return {
    small: mk(8 * 1024),       // типичный tool-result / stdout
    medium: mk(64 * 1024),     // крупный stdout команды
    large: mk(640 * 1024),     // read_file большого файла (кейс 635k из постановки)
    huge: mk(2.5 * 1024 * 1024), // предельный текстовый блоб (бандл/лог)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const outfile = await bundle()
  const mod = await import(`file://${outfile.replace(/\\/g, '/')}`)
  const Database = require('better-sqlite3')

  const samples = textSamples()
  const results = []
  const push = r => { results.push(r); process.stderr.write(`  ${r.label}: ${r.error ?? `${r.medianMs}ms (stall ${r.maxStallMs}ms)`}\n`) }

  if (args.onlyHeavy) {
    mod.invalidateDependencyMap?.(args.project)
    push(await measure(
      { group: 'maps', label: 'getDependencyMap cold (большой каталог)', freq: 'открытие проекта (фон)', perTurn: 0 },
      () => mod.getDependencyMap(args.project, true), 1))
    const text = JSON.stringify({ project: args.project, commit: process.env.BENCH_COMMIT ?? null, results }, null, 2)
    if (args.json) { mkdirSync(dirname(args.json), { recursive: true }); writeFileSync(args.json, text, 'utf8') }
    process.stdout.write(text + '\n')
    return
  }

  // ── secret-scanner ─────────────────────────────────────────────────────────
  // Частота: каждый tool-result (outcome.ts), stdout команд (command.ts:169),
  // каждое чтение файла моделью, git-операции, core-memory при каждом send.
  for (const [name, text] of Object.entries(samples)) {
    push(await measure(
      { group: 'secret-scanner', label: `scanText ${name} (${Math.round(text.length / 1024)}KB)`, freq: 'каждый tool-result / stdout / чтение', perTurn: name === 'small' ? 10 : name === 'medium' ? 2 : name === 'large' ? 1 : 0 },
      () => { mod.scanText(text) }, 5))
  }

  // ── диффы (main-часть): гард + маска перед pending-write ──────────────────
  // Частота: каждое подтверждение записи (file-ops.ts:86 scanText(before) +
  // file-ops.ts:136 maskSecretsForDiff). Сам визуальный дифф — renderer.
  const before = samples.large
  const after = before.slice(0, 300 * 1024) + '/* правка */' + before.slice(300 * 1024)
  push(await measure(
    { group: 'diff-write', label: 'maskSecretsForDiff 640KB', freq: 'каждое подтверждение записи', perTurn: 1 },
    () => { mod.maskSecretsForDiff(before, after) }, 5))
  const searchChunk = before.slice(100 * 1024, 100 * 1024 + 400)
  const patchBlocks = `<<<<<<< SEARCH\n${searchChunk}\n=======\n${searchChunk}/* bench */\n>>>>>>> REPLACE`
  push(await measure(
    { group: 'diff-write', label: 'applySearchReplaceBlocks 640KB', freq: 'каждый apply_patch', perTurn: 1 },
    () => { mod.applySearchReplaceBlocks(before, patchBlocks) }, 5))

  // ── core memory (внутри каждого prepareSystemContext) ─────────────────────
  push(await measure(
    { group: 'send-prep', label: 'loadCoreMemory (verstak repo)', freq: 'каждый ai:send', perTurn: 1 },
    () => { mod.loadCoreMemory(ROOT) }, 5))

  // ── история: компакция перед каждым ходом ─────────────────────────────────
  const history = [{ role: 'system', content: samples.medium }]
  for (let i = 0; i < 30; i++) {
    history.push({ role: 'user', content: `ход ${i}`, toolResults: [{ id: `t${i}`, name: 'read_file', result: samples.small.repeat(3) }] })
    history.push({ role: 'assistant', content: 'ok', toolCalls: [{ id: `t${i}`, name: 'read_file', args: { path: 'x' } }] })
  }
  push(await measure(
    { group: 'send-prep', label: 'compactToolHistory (30 ходов, ~750KB)', freq: 'каждый ход agent-loop', perTurn: 1 },
    () => { mod.compactToolHistory(history, 30) }, 5))

  // ── поиск по дереву (большой каталог) ─────────────────────────────────────
  const tools = mod.createFileTools(args.project, undefined, {})
  push(await measure(
    { group: 'tree', label: 'list_directory (корень большого каталога)', freq: 'по вызову модели', perTurn: 0 },
    () => tools.execute('list_directory', { path: '.' }), 3))
  push(await measure(
    { group: 'tree', label: 'find_files *.pdf (обход дерева)', freq: 'по вызову модели', perTurn: 0 },
    () => tools.execute('find_files', { pattern: '*.pdf' }), 2))
  // Контрольный кейс «не блокирует»: ripgrep — child process; stall обязан быть ~0.
  push(await measure(
    { group: 'tree', label: 'search_project (ripgrep, child)', freq: 'по вызову модели (контроль: НЕ main)', perTurn: 0 },
    () => tools.execute('search_project', { query: 'TODO' }), 2))

  // ── карты проекта ─────────────────────────────────────────────────────────
  mod.invalidateProjectMap(args.project)
  push(await measure(
    { group: 'maps', label: 'getProjectMap cold (большой каталог)', freq: 'открытие проекта / refresh', perTurn: 0 },
    () => mod.getProjectMap(args.project, true), 1))
  push(await measure(
    { group: 'maps', label: 'getProjectMap warm', freq: 'фолбэк в context-pack', perTurn: 1 },
    () => mod.getProjectMap(args.project, false), 3))
  if (!args.skipHeavy) {
    mod.invalidateDependencyMap?.(args.project)
    push(await measure(
      { group: 'maps', label: 'getDependencyMap cold (большой каталог)', freq: 'открытие проекта (фон)', perTurn: 0 },
      () => mod.getDependencyMap(args.project, true), 1))
  }

  // ── SQLite (better-sqlite3 — весь синхронный) на копии живой БД ───────────
  const dbDir = mkdtempSync(join(tmpdir(), 'verstak-mt-bench-db-'))
  const dbCopy = join(dbDir, 'verstak.db')
  if (existsSync(args.db)) {
    const src = new Database(args.db, { readonly: true })
    await src.backup(dbCopy)
    src.close()
    let db = null
    push(await measure(
      { group: 'sqlite', label: 'openDb + миграции (живая БД 8МБ)', freq: 'старт приложения', perTurn: 0 },
      () => { db = mod.openDb(dbCopy) }, 1))

    const runs = mod.createAgentRuns(db)
    const runId = `bench-${Date.now()}`
    runs.create({ runId, projectPath: ROOT, title: 'bench' })
    push(await measure(
      { group: 'sqlite', label: 'appendEvent (agent_run_events INSERT)', freq: 'каждое событие прогона (десятки/ход)', perTurn: 20 },
      () => { runs.appendEvent(runId, 'note', { label: 'bench', detail: samples.small.slice(0, 500) }) }, 200))

    const checkpoint300k = JSON.stringify(history).slice(0, 300 * 1024)
    const checkpoint2m = JSON.stringify(history.concat(history, history)).slice(0, 2 * 1024 * 1024)
    push(await measure(
      { group: 'sqlite', label: 'saveCheckpoint 300KB JSON', freq: 'каждый ход (троттлинг)', perTurn: 1 },
      () => { runs.saveCheckpoint(runId, 1, checkpoint300k, null) }, 10))
    push(await measure(
      { group: 'sqlite', label: 'saveCheckpoint 2MB JSON (длинная сессия)', freq: 'каждый ход длинной сессии', perTurn: 0 },
      () => { runs.saveCheckpoint(runId, 2, checkpoint2m, null) }, 5))

    // recall перед каждым send — FTS5-поиск по живым данным memories.
    const projRow = db.prepare('SELECT project_path p, COUNT(*) n FROM memories GROUP BY project_path ORDER BY n DESC LIMIT 1').get()
    push(await measure(
      { group: 'sqlite', label: `searchMemories FTS (${projRow?.n ?? 0} записей проекта)`, freq: 'каждый ai:send', perTurn: 1 },
      () => { mod.searchMemories(db, projRow?.p ?? ROOT, 'поправь заголовок в README и собери проект', 20) }, 10))
    db.close()
  } else {
    results.push({ group: 'sqlite', label: 'БД не найдена', error: args.db })
  }
  rmSync(dbDir, { recursive: true, force: true })

  // ── итог: сортировка по цене за типовой ход (perTurn × median) ────────────
  const r1 = v => Math.round(v * 10) / 10
  for (const r of results) {
    if (!r.error) r.costPerTurnMs = r1((r.perTurn ?? 0) * r.medianMs)
  }
  const sorted = [...results].sort((a, b) => (b.costPerTurnMs ?? 0) - (a.costPerTurnMs ?? 0))
  const lines = ['', 'операция                                        | медиана | max stall | частота                                | цена/ход']
  for (const r of sorted) {
    if (r.error) { lines.push(`${r.label.padEnd(47)} | ОШИБКА: ${r.error}`); continue }
    lines.push(`${r.label.padEnd(47)} | ${String(r.medianMs).padStart(6)}ms | ${String(r.maxStallMs).padStart(8)}ms | ${r.freq.padEnd(38)} | ${r.costPerTurnMs ? r.costPerTurnMs + 'ms' : '—'}`)
  }
  lines.push('', 'perTurn — ОЦЕНКА частоты за типовой ход agent-loop из кода (см. отчёт); 0 — событие не per-turn.', '')
  process.stdout.write(lines.join('\n'))

  const report = {
    project: args.project,
    commit: process.env.BENCH_COMMIT ?? null,
    node: process.version,
    startedAt: new Date().toISOString(),
    results: sorted,
  }
  const text = JSON.stringify(report, null, 2)
  if (args.json) { mkdirSync(dirname(args.json), { recursive: true }); writeFileSync(args.json, text, 'utf8') }
  process.stdout.write(text + '\n')
}

main().catch(err => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
  process.exitCode = 1
})
