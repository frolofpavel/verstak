// P3 кусок 2: токен-бенчмарк страниц встроенного браузера.
//
// ЧТО МЕРИТ: цену ОДНОГО браузерного tool result в символах и токенах на живых
// страницах трёх классов — простая статика, SPA-выдача, тяжёлый интерфейс.
// Считается ровно то, что уходит провайдеру: объект из browser.ts, сериализованный
// JSON.stringify (runner-api.ts:1556), оценка токенов — та же формула, что у
// estimateTokens (electron/ai/context-limits.ts). Снимок снимается ТЕМ ЖЕ кодом
// (shared/browser-snapshot.ts инжектится в страницу через .toString(), как в
// BrowserView.tsx), в настоящем Chromium, а не в jsdom: SPA-выдача в jsdom не
// существует, а именно она — эталонный случай приёмки 10.08.
//
// ЧЕГО НЕ МЕРИТ: поведение модели. Пойдёт ли она в find или в snapshot — свойство
// прогона, а не страницы; это отдельная ось (browser-run-bench.mjs, живые
// провайдеры). Здесь — детерминированная цена каждого варианта.
//
// Запуск: node scripts/bench/browser-page-bench.mjs [--json <файл>] [--repeats 3]
//         [--pages habr-search,mvideo-catalog] [--system-tokens 12000]
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ТРИ КЛАССА СТРАНИЦ из постановки. Страницы публичные и без логина: замер обязан
// быть воспроизводимым у другого человека на другой машине.
//  · static — простая статика: короткая форма и минимальный документ;
//  · spa    — выдача, которая приезжает XHR'ом ПОСЛЕ загрузки (эталонный кейс
//             приёмки 10.08 — поиск Хабра, на котором споткнулся встроенный режим);
//  · heavy  — тяжёлый интерфейс: каталог-витрина и кабинет-подобное приложение.
// ЗАПРОСЫ find СВЕРЕНЫ С ЖИВЫМИ ПОДПИСЯМИ страниц, а не выдуманы. Первая редакция
// спрашивала «more information» у example.com (там теперь «Learn more») и английские
// слова у app.diagrams.net (интерфейс русский) — и получала ноль совпадений, который
// читался бы как дефект find. Промах бенчмарка неотличим от промаха продукта, если
// запрос не сверен с содержимым (§3.1, про фикстуру, не совпадающую с продовой формой).
const PAGES = [
  { id: 'example-static', klass: 'static', label: 'минимальный документ',
    url: 'https://example.com/', queries: ['learn more', 'ссылка'] },
  // Форма БЕЗ JS-фреймворка. httpbin.org, на котором мерили 03.08 и 15.08, в этот же
  // день отдал 503 — образец класса выпал целиком. Замер не должен зависеть от
  // аптайма одного чужого сервиса, поэтому в наборе две статики, а не одна.
  { id: 'ddg-form', klass: 'static', label: 'статическая страница с формой поиска',
    url: 'https://html.duckduckgo.com/html/?q=electron', queries: ['search', 'next', 'настройки'] },
  { id: 'habr-search', klass: 'spa', label: 'SPA-выдача поиска (эталон приёмки 10.08)',
    url: 'https://habr.com/ru/search/?q=electron&target_type=posts&order=relevance',
    queries: ['поиск', 'войти', 'настройки'], settleMaxMs: 20000,
    // Выдача Хабра приезжает НЕ по URL: прямой адрес с запросом отдаёт заглушку
    // «нажмите на иконку» (штатное поведение, воспроизводится в обычном Chrome).
    // Кликаем ПОСЛЕДНЕЕ совпадение «поиск» — это иконка формы; первое — ссылка шапки
    // (тот самый случай одинаковых подписей из hint'а vskFind).
    steps: [{ find: 'поиск', index: -1, action: 'click' }, { waitMs: 2500 }] },
  { id: 'mdn-search', klass: 'spa', label: 'SPA-выдача документации',
    url: 'https://developer.mozilla.org/en-US/search?q=electron',
    queries: ['search', 'theme', 'electron'], settleMaxMs: 20000 },
  // НЕ ДЛЯ ПОРОГОВ. Оставлен как ЗАМЕР ОТКАЗА: npmjs встречает встроенный браузер
  // анти-бот-заслоном («Один момент…», 2 элемента, 284 символа текста). Это факт о
  // продукте — на части сайтов агент увидит заглушку вместо страницы, — и он
  // ценнее удаления неудобной строки. В расчёт порогов класс `blocked` не входит.
  { id: 'npm-search', klass: 'blocked', label: 'анти-бот-заслон вместо страницы',
    url: 'https://www.npmjs.com/search?q=electron', queries: ['search', 'sign in'], settleMaxMs: 20000 },
  { id: 'mvideo-catalog', klass: 'heavy', label: 'каталог-витрина (реперная точка B2)',
    url: 'https://www.mvideo.ru/noutbuki-planshety-komputery-8/noutbuki-118',
    queries: ['корзина', 'купить', 'ноутбук'], settleMaxMs: 25000 },
  { id: 'github-issues', klass: 'heavy', label: 'кабинет-подобный список задач без логина',
    url: 'https://github.com/electron/electron/issues',
    queries: ['new issue', 'labels', 'filter'], settleMaxMs: 25000 },
  { id: 'diagrams-app', klass: 'heavy', label: 'canvas-приложение без логина (мало контролов в DOM)',
    url: 'https://app.diagrams.net/', queries: ['фигур', 'доступ', 'поиск'], settleMaxMs: 25000 },
]

// Кандидаты порога top-N. Действующий — VSK_SNAPSHOT_TOP_N = 150, он в списке:
// замер обязан показать, дорог он или дёшев, а не подтвердить сам себя.
const CAPS = [10, 25, 50, 100, 150, 200, 300, 500]
const FIND_LIMIT = 30   // дефолт browser.ts (limit ?? 30)

function parseArgs(argv) {
  const args = { json: null, repeats: 3, pages: null, systemTokens: null, project: null, progress: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') args.json = resolve(argv[++i])
    else if (a === '--repeats') args.repeats = Number(argv[++i])
    else if (a === '--pages') args.pages = argv[++i].split(',')
    else if (a === '--system-tokens') args.systemTokens = Number(argv[++i])
    // Постоянная часть хода (system + схемы инструментов) МЕРИТСЯ, а не задаётся
    // рукой: она и есть та база, поверх которой копится история. Ручной
    // --system-tokens оставлен для повтора чужого замера.
    else if (a === '--project') args.project = resolve(argv[++i])
    else if (a === '--progress') args.progress = resolve(argv[++i])
    else if (a === '--show') args.show = true
    else throw new Error(`Unknown argument: ${a}`)
  }
  return args
}

/**
 * Постоянная часть каждого хода: system-строка (compose-system, тот же путь, что у
 * ai:send) + схемы инструментов, которые API-провайдер получает КАЖДЫМ запросом.
 * Меряем реальными модулями продукта — как preflight-bench и prompt-cache-bench.
 */
async function measureFixedTurnCost(project) {
  const mods = p => JSON.stringify(join(ROOT, p)).slice(1, -1).replace(/\\\\/g, '/')
  const dir = join(dirname(require.resolve('esbuild/package.json')), '..', '.verstak-page-bench')
  mkdirSync(dir, { recursive: true })
  const entry = join(dir, 'fixed-entry.mjs')
  writeFileSync(entry, `
export { prepareSystemContext } from '${mods('electron/ai/compose-system.ts')}'
export { TOOL_DEFS } from '${mods('electron/ai/tools.ts')}'
export { selectAllowedToolDefs } from '${mods('electron/ai/runner-util.ts')}'
export { loadCoreMemory } from '${mods('electron/ai/core-memory.ts')}'
`, 'utf8')
  const outfile = join(dir, 'fixed-bundle.mjs')
  await build({
    entryPoints: [entry], outfile, bundle: true, platform: 'node', target: 'node22', format: 'esm',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
    external: ['better-sqlite3', 'electron', '@homebridge/node-pty-prebuilt-multiarch', '@huggingface/transformers', 'unpdf', 'mammoth', 'exceljs', 'sharp'],
    logLevel: 'silent',
  })
  const mod = await import(`file://${outfile.replace(/\\/g, '/')}`)
  const composed = await mod.prepareSystemContext({
    projectPath: project,
    messages: [{ role: 'user', content: 'открой сайт и найди на нём форму поиска' }],
    recentWrites: [], memories: [], coreMemory: mod.loadCoreMemory(project),
    agentMode: 'accept-edits', brainContext: null, outputStyle: null, isFirstTurn: true,
  })
  const tools = mod.selectAllowedToolDefs(mod.TOOL_DEFS, [], undefined)
  const toolsJson = JSON.stringify(tools)
  const systemTokens = Math.ceil(composed.system.length / 4)
  const toolTokens = Math.ceil(toolsJson.length / 4)
  return {
    systemChars: composed.system.length, systemTokens,
    toolCount: tools.length, toolChars: toolsJson.length, toolTokens,
    browserToolChars: JSON.stringify(tools.filter(t => t.name.startsWith('browser_'))).length,
    fixedTurnTokens: systemTokens + toolTokens,
  }
}

/** Бандл ПРОДОВОГО модуля снимка — тот же исходник, что уезжает в webview. */
async function bundle() {
  const dir = join(dirname(require.resolve('esbuild/package.json')), '..', '.verstak-page-bench')
  mkdirSync(dir, { recursive: true })
  const outfile = join(dir, 'browser-snapshot.cjs')
  await build({
    entryPoints: [join(ROOT, 'shared', 'browser-snapshot.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    logLevel: 'silent',
  })
  return outfile
}

const median = xs => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }

/**
 * Сведение прогонов одной страницы. Берём МЕДИАНУ по повторам: сеть и SPA дают
 * разброс, среднее его прячет. Число элементов у SPA тоже гуляет (лента живая) —
 * поэтому в отчёт идут и min/max, а не одна цифра.
 */
function fold(page) {
  const ok = page.runs.filter(r => !r.error && r.count != null)
  if (ok.length === 0) return { ...page, ok: false, reason: page.runs.map(r => r.error).filter(Boolean)[0] ?? 'нет данных' }
  const counts = ok.map(r => r.count)
  const capsOf = n => ok.map(r => r.caps.find(c => c.n === n)).filter(Boolean)
  return {
    id: page.id, klass: page.klass, url: page.url, label: page.label, ok: true,
    runsOk: ok.length,
    title: ok[0].title,
    finalUrl: ok[0].finalUrl,
    count: { median: median(counts), min: Math.min(...counts), max: Math.max(...counts) },
    unnamed: median(ok.map(r => r.unnamed)),
    roles: ok[0].roles,
    truncatedByBudget: ok.some(r => r.truncatedByBudget),
    loadMs: median(ok.map(r => r.loadMs)),
    settleMs: median(ok.map(r => r.settleMs)),
    // Шаги до замера (если были) — с их readback'ом: что именно нажали и сколько
    // элементов было ДО. Без этого «46 элементов» у Хабра не отличить от «46 после клика».
    steps: ok[0].steps ?? null,
    interactiveBeforeSteps: ok[0].interactiveBeforeSteps ?? null,
    // Кадры за секунду. 0 — страница НЕ рисовалась, и её цифры о продукте не говорят.
    rafPerSec: ok.map(r => (r.raf ? r.raf.frames : null)),
    snapshotMs: median(ok.map(r => r.snapshotMs)),
    snapshotFull: { chars: median(ok.map(r => r.snapshotFull.chars)), tokens: median(ok.map(r => r.snapshotFull.tokens)) },
    readPage: { chars: median(ok.map(r => r.readPage.chars)), tokens: median(ok.map(r => r.readPage.tokens)) },
    caps: CAPS.map(n => {
      const rows = capsOf(n)
      return rows.length ? {
        n, shown: median(rows.map(r => r.shown)), truncated: rows.some(r => r.truncated),
        chars: median(rows.map(r => r.chars)), tokens: median(rows.map(r => r.tokens)),
      } : { n, shown: null, chars: null, tokens: null }
    }),
    finds: (ok[0].finds ?? []).map((f, i) => {
      const rows = ok.map(r => r.finds[i]).filter(Boolean)
      return {
        query: f.query,
        ms: median(rows.map(r => r.ms)),
        totalHits: median(rows.map(r => r.totalHits)),
        count: median(rows.map(r => r.count)),
        chars: median(rows.map(r => r.chars)),
        tokens: median(rows.map(r => r.tokens)),
        top: f.top,
      }
    }),
  }
}

/**
 * Д6 — НАКОПЛЕНИЕ КОНТЕКСТА ЗА ПРОГОН, а не за ход. API-путь пересылает всю
 * историю каждым ходом, поэтому цена tool result платится СТОЛЬКО РАЗ, сколько
 * ходов осталось до конца задачи: результат хода 1 в десятиходовой задаче уезжает
 * провайдеру десять раз. Это и есть механика, из-за которой одна задача приёмки
 * стоила 3.7M входных токенов.
 *
 * Считаем ТРИ стратегии на одном и том же сценарии из 10 действий, по измеренным
 * полезным нагрузкам этой страницы. Арифметика, а не прогон модели: поведение
 * модели меряет вторая ось. Зато сравнение стратегий здесь точное.
 */
function scenario(folded, systemTokens) {
  const cap150 = folded.caps.find(c => c.n === 150)?.tokens ?? 0
  const capFull = folded.snapshotFull.tokens
  const findT = folded.finds.length ? Math.round(folded.finds.reduce((a, f) => a + f.tokens, 0) / folded.finds.length) : 0
  const readT = folded.readPage.tokens
  // Десять действий типовой задачи «дойти до выдачи и прочитать её»: навигация,
  // ориентирование, ввод, отправка, ожидание, чтение результата, три уточнения.
  // Отличаются стратегии ровно тем, ЧЕМ агент ориентируется на странице.
  const nav = 40                        // browser_navigate — ответ короткий
  const act = 30                        // click/type/press_key — {ok,url}
  const plans = {
    'snapshot-каждый-раз': [nav, capFull, act, act, capFull, act, capFull, readT, capFull, readT],
    'snapshot(top-150)-каждый-раз': [nav, cap150, act, act, cap150, act, cap150, readT, cap150, readT],
    'find-первым': [nav, findT, act, act, findT, act, findT, readT, findT, readT],
  }
  const out = {}
  for (const [name, steps] of Object.entries(plans)) {
    let carried = 0            // сумма уже накопленных tool result'ов
    let totalInput = 0         // сумма входных токенов по всем ходам прогона
    for (const s of steps) {
      totalInput += systemTokens + carried    // ход отправляет систему + всю историю
      carried += s
    }
    out[name] = {
      perStepTokens: steps,
      lastTurnInputTokens: systemTokens + carried,
      totalInputTokens: totalInput,
    }
  }
  return out
}

/** Цена прогона по прайсу продукта (shared/contracts/pricing.ts), $/1M входных. */
const PRICE_INPUT = { deepseek: 0.28, 'kimi-k2.7-code (gateway)': 0.60 }

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const pages = args.pages ? PAGES.filter(p => args.pages.includes(p.id)) : PAGES
  if (pages.length === 0) throw new Error('Ни одной страницы не выбрано')

  const bundlePath = await bundle()
  const userDataDir = mkdtempSync(join(tmpdir(), 'verstak-page-bench-userdata-'))
  const workDir = mkdtempSync(join(tmpdir(), 'verstak-page-bench-'))
  const configPath = join(workDir, 'config.json')
  const resultPath = join(workDir, 'result.json')
  const progressPath = args.progress ?? join(workDir, 'progress.log')
  writeFileSync(configPath, JSON.stringify({
    bundlePath, userDataDir, resultPath, progressPath,
    pages, caps: CAPS, findLimit: FIND_LIMIT,
    repeats: args.repeats,
    settlePollMs: 700, settleMaxMs: 15000, settleMinMs: 3000, settleStable: 3,
    // Потолки на каждый вызов браузера и на весь замер. Причина — в шапке
    // withTimeout: без них прогон встал на 1 ч 48 мин без единой строки вывода.
    loadTimeoutMs: 30000, measureTimeoutMs: 30000,
    globalBudgetMs: args.repeats * pages.length * 120000,
    viewport: { width: 1280, height: 900 },
    showWindow: args.show === true,
  }), 'utf8')
  process.stdout.write(`[page-bench] прогресс: ${progressPath}\n`)

  const electronBin = require('electron')
  const runner = join(ROOT, 'scripts', 'bench', 'browser-page-bench-electron.cjs')
  const code = await new Promise((res, rej) => {
    const child = spawn(electronBin, [runner], {
      env: { ...process.env, VERSTAK_PAGE_BENCH_CONFIG: configPath },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.on('error', rej)
    child.on('exit', c => res(c ?? 1))
  })
  if (!existsSync(resultPath)) throw new Error(`Electron-раннер завершился с кодом ${code}, результата нет`)

  const raw = JSON.parse(readFileSync(resultPath, 'utf8'))
  // Результат может быть ЧАСТИЧНЫМ (раннер пишет после каждой страницы). Молчать об
  // этом нельзя: неполный набор страниц выглядит как полный замер (§3.1).
  raw.partial = raw.complete !== true || code !== 0
  raw.exitCode = code
  const folded = raw.pages.map(fold)
  const fixed = args.project ? await measureFixedTurnCost(args.project) : null
  const systemTokens = fixed ? fixed.fixedTurnTokens : (args.systemTokens ?? null)
  const report = {
    commit: process.env.BENCH_COMMIT ?? null,
    partial: raw.partial,
    exitCode: raw.exitCode,
    pagesRequested: pages.map(p => p.id),
    startedAt: raw.startedAt,
    electron: raw.electron, chrome: raw.chrome,
    viewport: raw.viewport, repeats: raw.repeats, caps: raw.caps, findLimit: raw.findLimit,
    topNInCode: raw.topN,
    systemTokens,
    fixedTurnCost: fixed,
    priceInputPerMTok: PRICE_INPUT,
    pages: folded,
    scenarios: systemTokens
      ? Object.fromEntries(folded.filter(p => p.ok).map(p => [p.id, scenario(p, systemTokens)]))
      : null,
    rawRuns: raw.pages,
  }
  const text = JSON.stringify(report, null, 2)
  if (args.json) { mkdirSync(dirname(args.json), { recursive: true }); writeFileSync(args.json, text, 'utf8') }

  // Человекочитаемые таблицы: сырые числа, вывод делает читатель.
  const pad = (s, n) => String(s).padEnd(n)
  const lines = ['']
  if (report.partial) {
    lines.push(`ЧАСТИЧНЫЙ ЗАМЕР: заказано страниц ${pages.length}, снято ${folded.length} (код выхода ${raw.exitCode}).`)
  }
  lines.push('СТРАНИЦА (класс)          | элем. | снимок мс | полный снимок ток. | top-150 ток. | find ток. (сред.) | read_page ток.')
  for (const p of folded) {
    if (!p.ok) { lines.push(`${pad(p.id, 25)} | ОТКАЗ: ${p.reason}`); continue }
    const c150 = p.caps.find(c => c.n === 150)
    const fAvg = p.finds.length ? Math.round(p.finds.reduce((a, f) => a + f.tokens, 0) / p.finds.length) : 0
    lines.push(`${pad(`${p.id} (${p.klass})`, 25)} | ${pad(p.count.median, 5)} | ${pad(p.snapshotMs, 9)} | ${pad(p.snapshotFull.tokens, 18)} | ${pad(c150?.tokens ?? '—', 12)} | ${pad(fAvg, 17)} | ${p.readPage.tokens}`)
  }
  lines.push('')
  lines.push('ПОРОГ top-N — полезная нагрузка снимка (токены):')
  lines.push(`${pad('страница', 25)} | ${CAPS.map(n => pad(n, 6)).join('| ')}`)
  for (const p of folded) {
    if (!p.ok) continue
    lines.push(`${pad(p.id, 25)} | ${p.caps.map(c => pad(c.tokens ?? '—', 6)).join('| ')}`)
  }
  if (report.scenarios) {
    lines.push('')
    lines.push('НАКОПЛЕНИЕ ЗА ПРОГОН из 10 действий (входных токенов суммарно / последний ход):')
    for (const [id, sc] of Object.entries(report.scenarios)) {
      lines.push(`  ${id}:`)
      for (const [name, v] of Object.entries(sc)) {
        const cost = (v.totalInputTokens / 1e6 * PRICE_INPUT.deepseek).toFixed(4)
        lines.push(`    ${pad(name, 30)} ${pad(v.totalInputTokens.toLocaleString('ru-RU'), 12)} / ${pad(v.lastTurnInputTokens.toLocaleString('ru-RU'), 10)}  ≈ $${cost} (DeepSeek вход)`)
      }
    }
  }
  lines.push('')
  process.stdout.write(lines.join('\n') + '\n')
}

main().catch(err => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
  process.exitCode = 1
})
