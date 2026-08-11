// Ускорение 2.6.x, шаг 1 (модуль 1): замер prompt-кэша по провайдерам.
//
// ЧТО МЕРИТ: долю кэш-попаданий (usage cached_tokens) на 2-м и 3-м ходу
// короткого чата, собранного ТЕМ ЖЕ кодом, что продовый ai:send API-пути:
// prepareSystemContext → systemForProvider → provider.send (реальные модули,
// не копия — CLAUDE.md §3.1). Плюс диагностика: байт-в-байт сравнение
// system-строк между ходами — первая точка расхождения и есть виновник
// кэш-мисса (prompt cache префиксный).
//
// ЧЕГО НЕ МЕРИТ: полный agent-loop с инструментальными ходами (runner),
// Anthropic explicit caching (нет живого anthropic_api_key — см. отчёт),
// recall памяти проекта (memories=[] на всех ходах; в проде recall-блок живёт
// в volatile-хвосте ПОСЛЕ кэш-маркера, стабильный префикс он не трогает).
//
// Секреты: значения ключей НЕ печатаются и НЕ пишутся в отчёт. Расшифровка
// (Electron safeStorage/DPAPI) происходит только в дочернем Electron-процессе;
// оркестратор передаёт туда зашифрованные base64-блобы как есть.
//
// Запуск: node scripts/bench/prompt-cache-bench.mjs --project <путь>
//         [--providers deepseek,verstak-gateway] [--json <файл>] [--dry]
// --dry: собрать план и системные промпты без сетевых вызовов (для проверки).
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Провайдеры API-транспорта, чьи usage-события несут cached_tokens и чей ключ —
// одиночный секрет в settings. Модель — дефолтная реестра (как чат «из коробки»).
const CANDIDATES = [
  { id: 'deepseek', secretKey: 'deepseek_api_key' },
  { id: 'verstak-gateway', secretKey: 'verstak_gateway_api_key' },
  { id: 'kimi-coding', secretKey: 'kimi_coding_api_key' },
  { id: 'zai-coding', secretKey: 'zai_coding_api_key' },
  { id: 'moonshot', secretKey: 'moonshot_api_key' },
  { id: 'qwen', secretKey: 'qwen_api_key' },
  { id: 'mistral', secretKey: 'mistral_api_key' },
  { id: 'groq', secretKey: 'groq_api_key' },
  { id: 'openrouter', secretKey: 'openrouter_api_key' },
  { id: 'custom-openai', secretKey: 'custom_openai_api_key' },
  { id: 'gemini-api', secretKey: 'gemini_api_key' },
  { id: 'claude', secretKey: 'anthropic_api_key' },
  { id: 'grok', secretKey: 'xai_api_key' },
  { id: 'openai', secretKey: 'openai_api_key' },
]

// Три хода одного чата. Короткие и заземлённые в context-pack, чтобы ответы
// были короткими, а замер — дешёвым.
const TURNS = [
  'Привет',
  'Назови текущую git-ветку из контекста одним словом.',
  'Спасибо! Назови product_stack проекта одной строкой.',
]

function parseArgs(argv) {
  const args = { project: null, providers: null, json: null, dry: false, freezeSystem: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--project') args.project = resolve(argv[++i])
    else if (a === '--providers') args.providers = argv[++i].split(',')
    else if (a === '--json') args.json = resolve(argv[++i])
    else if (a === '--dry') args.dry = true
    // Контрольный кейс (§3.1 «проверка на отсутствие события нуждается в
    // контроле»): system собирается ОДИН раз и замораживается на все ходы.
    // Отделяет виновника «хвост разошёлся» от «кэш провайдера не успел прогреться».
    else if (a === '--freeze-system') args.freezeSystem = true
    else throw new Error(`Unknown argument: ${a}`)
  }
  if (!args.project) throw new Error('--project <путь> обязателен')
  return args
}

// Точка входа бандла — реальные модули продукта (тот же приём, что preflight-bench).
const mods = p => JSON.stringify(join(ROOT, p)).slice(1, -1).replace(/\\\\/g, '/')
const ENTRY = `
export { prepareSystemContext } from '${mods('electron/ai/compose-system.ts')}'
export { systemForProvider, CACHE_BREAKPOINT } from '${mods('electron/ai/compose-prompt.ts')}'
export { createProvider, PROVIDERS } from '${mods('electron/ai/registry.ts')}'
export { TOOL_DEFS } from '${mods('electron/ai/tools.ts')}'
export { selectAllowedToolDefs } from '${mods('electron/ai/runner-util.ts')}'
export { resolveToolMode, JSON_TOOL_INSTRUCTION } from '${mods('electron/ai/tool-mode.ts')}'
export { intensityConfig, parseIntensity } from '${mods('electron/ai/intensity.ts')}'
export { loadCoreMemory } from '${mods('electron/ai/core-memory.ts')}'
`

async function bundle() {
  // Бандл кладём ВНУТРЬ node_modules (git его не видит), чтобы external-модули
  // резолвились обычным walk-up — из OS-tmp bare-специфаеры не резолвятся.
  const dir = join(dirname(require.resolve('esbuild/package.json')), '..', '.verstak-prompt-cache-bench')
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
  return { dir, outfile }
}

/** Зашифрованные blob'ы настроек (base64 как лежат в БД) — расшифрует Electron. */
function readEncryptedSettings(keys) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(join(process.env.APPDATA, 'verstak', 'storage', 'verstak.db'), { readOnly: true })
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?')
  const out = {}
  for (const k of keys) {
    const row = stmt.get(k)
    if (row && row.value) out[k] = row.value
  }
  db.close()
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const wanted = args.providers
    ? CANDIDATES.filter(c => args.providers.includes(c.id))
    : CANDIDATES

  const settingKeys = [
    ...wanted.map(c => c.secretKey),
    'custom_openai_baseurl', 'custom_openai_models',
    'yandex_folder_id', 'gigachat_client_secret',
    'ptc_enabled', 'web_access', 'orchestrator_default', 'intensity', 'output_style',
    `system_prompt_${args.project}`,
  ]
  const encrypted = readEncryptedSettings(settingKeys)
  const available = wanted.filter(c => encrypted[c.secretKey])
  const skipped = wanted.filter(c => !encrypted[c.secretKey]).map(c => c.id)
  if (available.length === 0) throw new Error('Ни одного провайдера с ключом в settings')

  const { outfile } = await bundle()

  // Временный userData с копией Local State приложения: safeStorage возьмёт
  // тот же os_crypt-ключ, не конкурируя за живой профиль работающего Verstak.
  const userDataDir = mkdtempSync(join(tmpdir(), 'verstak-cache-bench-userdata-'))
  const realLocalState = join(process.env.APPDATA, 'verstak', 'Local State')
  if (existsSync(realLocalState)) copyFileSync(realLocalState, join(userDataDir, 'Local State'))

  const workDir = mkdtempSync(join(tmpdir(), 'verstak-cache-bench-'))
  const configPath = join(workDir, 'config.json')
  const resultPath = join(workDir, 'result.json')
  writeFileSync(configPath, JSON.stringify({
    bundlePath: outfile,
    projectPath: args.project,
    userDataDir,
    resultPath,
    dry: args.dry,
    freezeSystem: args.freezeSystem,
    turns: TURNS,
    providers: available.map(c => ({ id: c.id, secretKey: c.secretKey })),
    encrypted,
  }), 'utf8')

  const electronBin = require('electron')
  const runner = join(ROOT, 'scripts', 'bench', 'prompt-cache-bench-electron.cjs')
  const code = await new Promise((res, rej) => {
    const child = spawn(electronBin, [runner], {
      env: { ...process.env, VERSTAK_CACHE_BENCH_CONFIG: configPath },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.on('error', rej)
    child.on('exit', c => res(c ?? 1))
  })
  if (code !== 0 || !existsSync(resultPath)) {
    throw new Error(`Electron-раннер завершился с кодом ${code}, результата нет`)
  }
  const result = JSON.parse(readFileSync(resultPath, 'utf8'))
  result.skippedNoKey = skipped
  result.commit = process.env.BENCH_COMMIT ?? null

  // Человекочитаемая таблица: доля кэш-попаданий на 2-м и 3-м ходу.
  const fmtShare = t => {
    if (!t || t.error) return 'ошибка'
    if (t.cacheReadTokens == null) return 'нет данных'
    const total = t.inputAccounting === 'exclusive'
      ? (t.inputTokens ?? 0) + (t.cacheReadTokens ?? 0) + (t.cacheWriteTokens ?? 0)
      : (t.inputTokens ?? 0)
    if (!total) return 'нет данных'
    return `${Math.round((t.cacheReadTokens / total) * 100)}% (${t.cacheReadTokens}/${total})`
  }
  const lines = ['', 'провайдер            | модель                 | ход2 кэш | ход3 кэш']
  for (const p of result.providers) {
    const [, t2, t3] = p.turns
    lines.push(`${p.id.padEnd(20)} | ${String(p.model).padEnd(22)} | ${fmtShare(t2)} | ${fmtShare(t3)}`)
  }
  lines.push('')
  process.stdout.write(lines.join('\n'))

  const text = JSON.stringify(result, null, 2)
  if (args.json) { mkdirSync(dirname(args.json), { recursive: true }); writeFileSync(args.json, text, 'utf8') }
  process.stdout.write(text + '\n')
  rmSync(workDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
}

main().catch(err => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
  process.exitCode = 1
})
