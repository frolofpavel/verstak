// V2 (волна 2.6.0), ось A: измеритель pre-flight — того, что исполняется между
// Enter и отправкой первого запроса провайдеру.
//
// ЧТО ЭТОТ ИНСТРУМЕНТ МЕРИТ И ЧЕГО НЕ МЕРИТ — объявлено, чтобы цифру не прочли
// шире, чем она есть. Меряется ДЕТЕРМИНИРОВАННАЯ часть «времени до первого
// символа»: сборка system-слоя и context-pack (карта проекта, граф зависимостей,
// профиль, git, память). Сеть и генерация модели НЕ меряются — они зависят от
// провайдера и нагрузки, воспроизводимой цифры не дают, и правкой V2 не
// затрагиваются. Всё, что V2 сокращает, лежит внутри измеряемого куска.
//
// Запуск: node scripts/bench/preflight-bench.mjs --project <путь> [--json <файл>]
// Сборка TS в один бандл через esbuild — тот же приём, что в build-headless.mjs
// (electron/ai/* написаны на TS и напрямую Node-ом не исполняются).
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function parseArgs(argv) {
  const args = { project: null, json: null, scenarios: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--project') args.project = resolve(argv[++i])
    else if (a === '--json') args.json = resolve(argv[++i])
    else if (a === '--scenarios') args.scenarios = argv[++i].split(',')
    else throw new Error(`Unknown argument: ${a}`)
  }
  if (!args.project) throw new Error('--project <путь> обязателен')
  return args
}

// Точка входа бандла: тонкая обёртка над реальными модулями продукта. Меряем
// ТОТ ЖЕ код, который исполняется в проде, а не его копию (CLAUDE.md §3.1).
const ENTRY = `
import { buildContextPack } from '${JSON.stringify(join(ROOT, 'electron/ai/context-pack.ts')).slice(1, -1).replace(/\\\\/g, '/')}'
import { prepareSystemContext } from '${JSON.stringify(join(ROOT, 'electron/ai/compose-system.ts')).slice(1, -1).replace(/\\\\/g, '/')}'
import { getProjectMap, getDependencyMap } from '${JSON.stringify(join(ROOT, 'electron/ai/project-map.ts')).slice(1, -1).replace(/\\\\/g, '/')}'
export { buildContextPack, prepareSystemContext, getProjectMap, getDependencyMap }
`

async function bundle() {
  const dir = mkdtempSync(join(tmpdir(), 'verstak-preflight-bench-'))
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
  return { dir, outfile }
}

async function timed(label, work) {
  const t0 = process.hrtime.bigint()
  let error = null
  try { await work() } catch (err) { error = err instanceof Error ? err.message : String(err) }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  return { label, ms: Math.round(ms), error }
}

/**
 * Три сценария постановки. Отличаются они НЕ текстом запроса (pre-flight к тексту
 * почти безразличен), а состоянием кэшей — именно оно решает, ждёт человек или нет:
 *  1. cold  — «Привет» первой отправкой в свежем процессе (кэш пуст);
 *  2. warm  — повторная отправка в том же проекте (кэш прогрет);
 *  3. turns — задача на 8–10 ходов: pre-flight на каждом ходу, суммарная цена.
 */
const TURNS = 9

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { dir, outfile } = await bundle()
  try {
    const mod = await import(`file://${outfile.replace(/\\/g, '/')}`)
    const project = args.project
    const common = { projectPath: project, recentWrites: [], coreMemory: { memory: '', user: '' } }
    const phases = []

    // Сценарий 1 — холодный старт, «Привет». ПОРЯДОК ЗДЕСЬ ЗНАЧИМ: сборка
    // контекста идёт ПЕРВОЙ, до любого явного прогрева карт. Иначе замер «холодного»
    // сценария снимался бы с уже прогретого кэша и показывал цифру, которой у
    // человека не бывает (первая ошибка этого же инструмента, исправлена до замера).
    phases.push({ scenario: 'cold-hello', ...(await timed('system_context (cold)', () => mod.prepareSystemContext({ ...common, messages: [{ role: 'user', content: 'Привет' }], isFirstTurn: true }))) })
    // Фазы порознь — уже по прогретому кэшу: показывают, сколько стоит ПОВТОРНОЕ
    // обращение к карте и графу (кто платит на холодную — видно по строке выше и
    // по замеру cold-parts, который делается отдельным запуском процесса).
    phases.push({ scenario: 'warm-parts', ...(await timed('project_map (warm)', () => mod.getProjectMap(project, false))) })
    phases.push({ scenario: 'warm-parts', ...(await timed('dependency_map (warm)', () => mod.getDependencyMap(project, false))) })

    // Сценарий 2 — короткая правка, кэш уже прогрет предыдущим сценарием.
    phases.push({ scenario: 'warm-edit', ...(await timed('context_pack (warm)', () => mod.buildContextPack({ ...common, latestUserMessage: 'поправь заголовок в README' }))) })
    phases.push({ scenario: 'warm-edit', ...(await timed('system_context (warm)', () => mod.prepareSystemContext({ ...common, messages: [{ role: 'user', content: 'поправь заголовок в README' }] }))) })

    // Сценарий 3 — задача на 8–10 ходов: pre-flight не единожды. Сумма и есть
    // та часть общего времени задачи, которую платит подготовка контекста.
    const perTurn = []
    for (let i = 1; i <= TURNS; i++) {
      const t = await timed(`turn ${i}`, () => mod.prepareSystemContext({ ...common, messages: [{ role: 'user', content: `ход ${i}` }] }))
      perTurn.push(t.ms)
      phases.push({ scenario: 'task-9-turns', ...t })
    }

    const sum = list => list.reduce((a, b) => a + b, 0)
    const byScenario = name => phases.filter(p => p.scenario === name)
    const report = {
      project,
      // Замер привязан к коммиту — иначе «до» и «после» сравнивают разный код.
      commit: process.env.BENCH_COMMIT ?? null,
      turns: TURNS,
      phases,
      summary: {
        // Главная цифра оси A: сколько человек ждёт после Enter на «Привет».
        coldHelloMs: sum(byScenario('cold-hello').map(p => p.ms)),
        warmProjectMapMs: phases.find(p => p.label === 'project_map (warm)')?.ms ?? null,
        warmDependencyMapMs: phases.find(p => p.label === 'dependency_map (warm)')?.ms ?? null,
        warmEditMs: sum(byScenario('warm-edit').map(p => p.ms)),
        taskTurnsTotalMs: sum(perTurn),
        taskTurnsMedianMs: perTurn.slice().sort((a, b) => a - b)[Math.floor(perTurn.length / 2)],
      },
    }
    const text = JSON.stringify(report, null, 2)
    if (args.json) { mkdirSync(dirname(args.json), { recursive: true }); writeFileSync(args.json, text, 'utf8') }
    process.stdout.write(text + '\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch(err => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
  process.exitCode = 1
})
