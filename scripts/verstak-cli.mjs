#!/usr/bin/env node
/**
 * Verstak CLI — запуск AI-агента из терминала без GUI.
 *
 * Самодостаточный скрипт на plain ES modules: без Electron, без TypeScript.
 * Делает прямые HTTPS-запросы к провайдерам, выполняет инструменты локально.
 *
 * Использование:
 *   node scripts/verstak-cli.mjs "исправь баг в src/auth.ts"
 *   node scripts/verstak-cli.mjs -p claude -m claude-sonnet-4-6 "объясни этот код"
 *   echo "fix tests" | node scripts/verstak-cli.mjs --stdin
 *   node scripts/verstak-cli.mjs --json "найди все TODO"
 */

import { parseArgs } from 'node:util'
import { resolve, join, relative, dirname } from 'node:path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { execSync, execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import http from 'node:http'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ---------------------------------------------------------------------------
// Аргументы
// ---------------------------------------------------------------------------

const { values, positionals } = parseArgs({
  options: {
    provider: { type: 'string', short: 'p', default: 'gemini-api' },
    model:    { type: 'string', short: 'm' },
    key:      { type: 'string', short: 'k' },
    project:  { type: 'string', default: '.' },
    mode:     { type: 'string', default: 'auto' },
    stdin:    { type: 'boolean', default: false },
    json:     { type: 'boolean', default: false },
    recipe:   { type: 'string' },
    task:     { type: 'string' },
    workspace:{ type: 'string' },
    'max-turns': { type: 'string' },
    'trace-json': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    help:     { type: 'boolean', short: 'h', default: false },
    version:  { type: 'boolean', short: 'v', default: false },
  },
  allowPositionals: true,
  strict: false,
})

// ---------------------------------------------------------------------------
// Help / version
// ---------------------------------------------------------------------------

if (values.help) {
  console.log(`
Verstak CLI — AI-агент в терминале без GUI

Использование:
  verstak "ваш промпт"
  verstak -p claude -m claude-sonnet-4-6 "исправь баг"
  echo "объясни это" | verstak --stdin
  verstak --json "найди все TODO-комментарии"
  node scripts/verstak-cli.mjs "ваш промпт"

Команды (не запускают провайдера):
  verstak doctor          Проверить настроенные провайдеры (--json для machine-readable)
  verstak status          То же, что doctor
  verstak models          Список провайдеров и env-переменных
  verstak recipe run      Запустить coding recipe в headless режиме

Опции:
  -p, --provider   AI-провайдер: gemini-api (по умолч), claude, grok, openai,
                   openrouter, deepseek, mistral, groq, ollama
                   (YandexGPT/GigaChat — только в GUI, не в CLI)
  -m, --model      Имя модели (по умолч: дефолтная провайдера)
  -k, --key        API-ключ (или через env: GEMINI_API_KEY, ANTHROPIC_API_KEY, …)
  --project        Директория проекта (по умолч: текущая)
  --mode           Режим агента: auto (по умолч), ask, plan
                   auto — все инструменты без подтверждения
                   ask  — подтверждение перед write/run
                   plan — только чтение, без записи
  --recipe         Recipe id для "recipe run": bugfix, test-fix, typescript-error...
  --task           Текст задачи для "recipe run" (или positional после run)
  --workspace      Alias для --project
  --max-turns      Лимит ходов agent loop (по умолч: 20)
  --trace-json     Добавить machine-readable trace в JSON output
  --dry-run        Для recipe run: показать protocol/trace без вызова провайдера
  --stdin          Читать промпт из stdin
  --json           Вывод в JSON-формате
  -v, --version    Показать версию
  -h, --help       Показать справку

Env-переменные:
  GEMINI_API_KEY       Gemini API
  ANTHROPIC_API_KEY    Claude (Anthropic)
  XAI_API_KEY          Grok (xAI)
  OPENAI_API_KEY       OpenAI
  OPENROUTER_API_KEY   OpenRouter
  DEEPSEEK_API_KEY     DeepSeek
  MISTRAL_API_KEY      Mistral
  GROQ_API_KEY         Groq

Примеры:
  GEMINI_API_KEY=xxx node scripts/verstak-cli.mjs "list all TODO"
  ANTHROPIC_API_KEY=xxx node scripts/verstak-cli.mjs -p claude "fix src/auth.ts"
  node scripts/verstak-cli.mjs -p openrouter --key sk-or-xxx "explain this codebase"
`)
  process.exit(0)
}

if (values.version) {
  const pkgPath = resolve(__dirname, '../package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  console.log(`Verstak CLI v${pkg.version}`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Резолвинг API-ключа
// ---------------------------------------------------------------------------

/** ENV-переменные для каждого провайдера */
const ENV_KEYS = {
  'gemini-api':    'GEMINI_API_KEY',
  'claude':        'ANTHROPIC_API_KEY',
  'grok':          'XAI_API_KEY',
  'openai':        'OPENAI_API_KEY',
  'openrouter':    'OPENROUTER_API_KEY',
  'deepseek':      'DEEPSEEK_API_KEY',
  'mistral':       'MISTRAL_API_KEY',
  'groq':          'GROQ_API_KEY',
  'ollama':        null,  // локальный, ключ не нужен
  // YandexGPT/GigaChat намеренно НЕ в CLI: getProviderStream их не реализует
  // (нужны спец-провайдеры с folder-id/OAuth). RU-провайдеры — через GUI.
}

/** Ключи в .verstak/settings.json для каждого провайдера. */
const SETTINGS_KEY_MAP = {
  'gemini-api': 'gemini_api_key',
  'claude': 'anthropic_api_key',
  'grok': 'xai_api_key',
  'openai': 'openai_api_key',
  'openrouter': 'openrouter_api_key',
  'deepseek': 'deepseek_api_key',
  'mistral': 'mistral_api_key',
  'groq': 'groq_api_key',
}

function resolveApiKey(provider, explicit) {
  if (explicit) return explicit
  const envVar = ENV_KEYS[provider]
  if (envVar === null) return ''  // ollama — без ключа
  if (envVar && process.env[envVar]) return process.env[envVar]
  // Попробуем .verstak/settings.json
  const settingsPath = resolve(projectPath, '.verstak', 'settings.json')
  if (existsSync(settingsPath)) {
    try {
      const s = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      const settingsKey = SETTINGS_KEY_MAP[provider]
      if (settingsKey && s[settingsKey]) return s[settingsKey]
    } catch { /* ignore */ }
  }
  const envMsg = envVar ? `\nУстановите ${envVar} или передайте --key` : ''
  throw new Error(`API-ключ для провайдера "${provider}" не найден.${envMsg}`)
}

// ---------------------------------------------------------------------------
// Путь к проекту
// ---------------------------------------------------------------------------

const projectPath = resolve(process.cwd(), values.workspace ?? values.project ?? '.')

// ---------------------------------------------------------------------------
// Bounded local commands (F14, claw-code parity): doctor / status / models —
// проверяют конфигурацию ЛОКАЛЬНО, НЕ запускают провайдера и не зависают.
// Должны идти ДО резолва промпта (иначе "verstak doctor" уйдёт как промпт в API).
// ---------------------------------------------------------------------------

/** Настроен ли провайдер (ключ в env или .verstak/settings.json) — без throw. */
function isConfigured(provider) {
  const envVar = ENV_KEYS[provider]
  if (envVar === null) return true // ollama — локальный, ключ не нужен
  if (envVar && process.env[envVar]) return true
  const settingsPath = resolve(projectPath, '.verstak', 'settings.json')
  if (existsSync(settingsPath)) {
    try {
      const s = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      const k = SETTINGS_KEY_MAP[provider]
      if (k && s[k]) return true
    } catch { /* ignore */ }
  }
  return false
}

function providerSource(provider) {
  const envVar = ENV_KEYS[provider]
  if (envVar === null) return 'local'
  if (envVar && process.env[envVar]) return 'env'
  if (isConfigured(provider)) return 'settings'
  return 'none'
}

const COMMAND = positionals[0]
const SUBCOMMAND = positionals[1]
if (COMMAND === 'doctor' || COMMAND === 'status' || COMMAND === 'models') {
  const pkgVersion = (() => {
    try { return JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8')).version }
    catch { return 'unknown' }
  })()
  const providers = Object.keys(ENV_KEYS).map(p => ({
    provider: p,
    envVar: ENV_KEYS[p],
    configured: isConfigured(p),
    source: providerSource(p),
  }))
  const configuredCount = providers.filter(p => p.configured).length
  if (values.json) {
    console.log(JSON.stringify({ ok: true, command: COMMAND, version: pkgVersion, project: projectPath, providersConfigured: configuredCount, providersTotal: providers.length, providers }, null, 2))
  } else if (COMMAND === 'models') {
    console.log(`Verstak CLI v${pkgVersion} — провайдеры (флаг -p):`)
    for (const p of providers) {
      console.log(`  ${p.configured ? '✓' : '·'} ${p.provider.padEnd(12)} ${p.envVar ? `env: ${p.envVar}` : 'локальный (ollama)'}`)
    }
  } else {
    console.log(`Verstak CLI v${pkgVersion} doctor — проект: ${projectPath}`)
    console.log(`Настроено провайдеров: ${configuredCount}/${providers.length}`)
    for (const p of providers) {
      console.log(`  ${p.configured ? '✓' : '·'} ${p.provider.padEnd(12)} ${p.configured ? `(${p.source})` : (p.envVar ? `задай ${p.envVar} или --key` : '')}`)
    }
  }
  process.exit(0)
}

const isRecipeRun = COMMAND === 'recipe' && SUBCOMMAND === 'run'

// ---------------------------------------------------------------------------
// Headless coding recipes
// ---------------------------------------------------------------------------

const STEP_TEXT = {
  inspect_error: 'Изучи точный текст ошибки/симптома (код, файл, строка) — не гадай о причине.',
  locate_files: 'Найди конкретные файлы и места, которых касается задача.',
  read_context: 'Прочитай найденные файлы и связанный контекст ПЕРЕД правкой.',
  propose_patch: 'Сформулируй минимальный патч; не расширяй scope.',
  apply_patch: 'Примени патч точечно, сохраняя стиль вокруг.',
  run_verify: 'Прогони верификацию и добейся зелёного результата.',
  run_tests: 'Прогони релевантные тесты и убедись, что они проходят по правильной причине.',
  review: 'Пройди независимое ревью изменений (review_before_commit) перед завершением.',
  summarize: 'Кратко объясни, что и почему изменил (diff в 1-2 строки).',
}

const BUILT_IN_RECIPES = [
  {
    id: 'small-edit',
    kind: 'coding',
    read_set: [],
    steps: ['locate_files', 'read_context', 'propose_patch', 'apply_patch', 'run_verify', 'summarize'],
    verify: { commands: ['npm run type'] },
    reviewer: { required: false },
    stop: ['change_applied', 'type_green', 'no_unrelated_changes'],
  },
  {
    id: 'typescript-error',
    kind: 'coding',
    read_set: ['tsconfig*.json', '**/*.ts', '**/*.tsx'],
    steps: ['inspect_error', 'locate_files', 'read_context', 'propose_patch', 'apply_patch', 'run_verify', 'summarize'],
    verify: { commands: ['npm run type'] },
    reviewer: { required: false },
    stop: ['typecheck_green', 'diff_explained', 'no_unrelated_changes'],
  },
  {
    id: 'bugfix',
    kind: 'coding',
    read_set: ['**/*.ts', '**/*.tsx', 'tests/**'],
    steps: ['inspect_error', 'locate_files', 'read_context', 'propose_patch', 'apply_patch', 'run_tests', 'run_verify', 'review', 'summarize'],
    verify: { commands: ['npm run type', 'npm run test:fast'] },
    reviewer: { required: true },
    stop: ['root_cause_found', 'tests_green', 'type_green', 'reviewer_pass'],
  },
  {
    id: 'test-fix',
    kind: 'coding',
    read_set: ['tests/**', '**/*.test.ts', 'vitest.config*', 'package.json'],
    steps: ['inspect_error', 'locate_files', 'read_context', 'propose_patch', 'apply_patch', 'run_tests', 'summarize'],
    verify: { commands: ['npm run test:fast'] },
    reviewer: { required: false },
    stop: ['tests_green', 'no_unrelated_changes', 'diff_explained'],
  },
  {
    id: 'refactor-safe',
    kind: 'coding',
    read_set: ['**/*.ts', '**/*.tsx'],
    steps: ['locate_files', 'read_context', 'propose_patch', 'apply_patch', 'run_verify', 'run_tests', 'review', 'summarize'],
    verify: { commands: ['npm run type', 'npm run test:fast'] },
    reviewer: { required: true },
    stop: ['behavior_unchanged', 'type_green', 'tests_green', 'reviewer_pass'],
  },
  {
    id: 'review-before-commit',
    kind: 'coding',
    read_set: [],
    steps: ['run_verify', 'run_tests', 'review', 'summarize'],
    verify: { commands: ['npm run type', 'npm run test:fast'] },
    reviewer: { required: true },
    stop: ['verify_green', 'reviewer_pass', 'diff_explained'],
  },
]

function loadRecipe(id) {
  return BUILT_IN_RECIPES.find(r => r.id === id) ?? null
}

function renderRecipeProtocol(recipe) {
  const L = []
  L.push(`<!-- recipe_protocol: ${recipe.id} -->`)
  L.push(`## Рабочий протокол задачи (recipe: ${recipe.id})`)
  L.push('Работай по этому жёсткому пошаговому протоколу, а не в свободном агентном режиме. Соблюдай порядок шагов и границы охвата — это важнее скорости.')

  if (recipe.read_set.length > 0) {
    L.push('\n### Контекст (read_set) — читай только релевантное из:')
    for (const g of recipe.read_set) L.push(`- ${g}`)
    L.push('Не выходи за пределы read_set без явной необходимости.')
  } else {
    L.push('\n### Контекст: читай только файлы, прямо относящиеся к задаче. Не расширяй охват.')
  }

  L.push('\n### Шаги (строго по порядку):')
  recipe.steps.forEach((s, i) => L.push(`${i + 1}. ${STEP_TEXT[s] ?? s}`))

  if (recipe.verify?.commands?.length) {
    L.push('\n### Верификация (обязательна):')
    for (const c of recipe.verify.commands) L.push(`- \`${c}\``)
    L.push('Задача не выполнена, пока верификация не зелёная. Учитывается baseline: ошибки, существовавшие ДО правки, не блокируют — блокируют только новые.')
  }

  if (recipe.reviewer?.required) {
    L.push('\n### Ревью перед завершением (обязательно):')
    L.push('Вызови инструмент review_before_commit — независимый review gate проверит diff + task brief + вывод verify. Не завершай задачу без прохождения гейта.')
  }

  if (recipe.stop.length > 0) {
    L.push('\n### Готово, когда выполнено ВСЁ:')
    for (const x of recipe.stop) L.push(`- ${x}`)
  }

  L.push('\nГраницы: минимальный патч, никаких несвязанных правок, не глуши ошибки заглушками (any/@ts-ignore/skip тестов) без явной причины.')
  return L.join('\n')
}

// ---------------------------------------------------------------------------
// Чтение промпта
// ---------------------------------------------------------------------------

async function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', chunk => { data += chunk })
    process.stdin.on('end', () => resolve(data.trim()))
    // Таймаут если stdin пустой (не pipe)
    if (process.stdin.isTTY) resolve('')
  })
}

let recipeSpec = null
let recipeProtocol = ''
let prompt = isRecipeRun
  ? String(values.task ?? positionals.slice(2).join(' ')).trim()
  : positionals.join(' ').trim()
if (values.stdin || (!prompt && !process.stdin.isTTY)) {
  prompt = await readStdin()
}

if (isRecipeRun) {
  const recipeId = String(values.recipe ?? '').trim()
  if (!recipeId) {
    console.error('Ошибка: recipe run требует --recipe <id>')
    process.exit(1)
  }
  recipeSpec = loadRecipe(recipeId)
  if (!recipeSpec) {
    console.error(`Ошибка: неизвестный recipe "${recipeId}". Доступно: ${BUILT_IN_RECIPES.map(r => r.id).join(', ')}`)
    process.exit(1)
  }
  recipeProtocol = renderRecipeProtocol(recipeSpec)
}

if (!prompt) {
  console.error('Ошибка: укажите промпт как аргумент или передайте через --stdin\nДля справки: verstak --help')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// HTTPS-утилита для streaming SSE / JSON
// ---------------------------------------------------------------------------

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
    }
    const mod = parsedUrl.protocol === 'https:' ? https : http
    const req = mod.request(options, (res) => {
      resolve(res)
    })
    req.on('error', reject)
    req.write(JSON.stringify(body))
    req.end()
  })
}

async function streamResponse(res) {
  return new Promise((resolve, reject) => {
    let raw = ''
    res.on('data', chunk => { raw += chunk.toString() })
    res.on('end', () => resolve(raw))
    res.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Системный промпт
// ---------------------------------------------------------------------------

function buildSystemPrompt(projectPath, recipeProtocol = '') {
  const lines = [
    'Ты — AI-ассистент для разработки. Работаешь в режиме CLI без GUI.',
    `Корень проекта: ${projectPath}`,
    'Используй инструменты (read_file, write_file, run_command, list_directory, search_project, find_files) для работы с файлами и кодом.',
    'Перед правкой кода — прочитай файл. Все пути — относительные от корня проекта.',
    'После изменений — кратко сообщи что сделано.',
  ]

  if (recipeProtocol) {
    lines.push(`\n--- Headless Recipe Protocol ---\n${recipeProtocol}`)
  }

  // Попробуем загрузить user-layer (CLAUDE.md / AGENTS.md / .verstak/RULES.md)
  const candidates = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.verstak/RULES.md']
  for (const c of candidates) {
    const p = join(projectPath, c)
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, 'utf-8').trim()
        if (content) {
          lines.push(`\n--- Правила проекта из ${c} ---\n${content}`)
          break
        }
      } catch { /* ignore */ }
    }
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Инструменты — выполнение
// ---------------------------------------------------------------------------

const IGNORE_DIRS = new Set(['node_modules', '.git', 'out', 'dist', '.next', '.vite',
  '.verstak-data', '__pycache__', 'venv', '.venv', 'target', 'build', 'release'])

const FORBIDDEN_PATTERNS = [/\.env$/, /\.key$/, /creds.*\.json$/, /id_ed25519$/, /id_rsa$/]

function isForbidden(filePath) {
  const base = filePath.split(/[\\/]/).pop() ?? ''
  return FORBIDDEN_PATTERNS.some(p => p.test(base))
}

/** Безопасный join — не выходим за projectPath */
function safeJoin(root, rel) {
  const resolved = resolve(root, rel)
  if (!resolved.startsWith(resolve(root))) {
    throw new Error(`Выход за пределы проекта: ${rel}`)
  }
  return resolved
}

async function toolReadFile(args, root) {
  const { path: relPath } = args
  const absPath = safeJoin(root, relPath)
  if (isForbidden(absPath)) return `Доступ запрещён: ${relPath}`
  try {
    const content = await readFile(absPath, 'utf-8')
    return content.length > 200_000
      ? content.slice(0, 200_000) + '\n... [файл обрезан, показаны первые 200 КБ]'
      : content
  } catch (e) {
    return `Ошибка чтения ${relPath}: ${e.message}`
  }
}

async function toolListDirectory(args, root) {
  const { path: relPath = '.' } = args
  const absPath = safeJoin(root, relPath)
  try {
    const entries = await readdir(absPath, { withFileTypes: true })
    const lines = entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name))
    return lines.join('\n') || '(пустая директория)'
  } catch (e) {
    return `Ошибка: ${e.message}`
  }
}

async function toolWriteFile(args, root, mode) {
  const { path: relPath, content } = args
  const absPath = safeJoin(root, relPath)
  if (isForbidden(absPath)) return `Запись запрещена: ${relPath}`
  if (mode === 'plan') return `[plan mode] Запись заблокирована: ${relPath}`
  if (mode === 'ask') {
    process.stderr.write(`\n⚠  Агент хочет записать: ${relPath}\n`)
    // В неинтерактивном контексте — разрешаем (можно добавить readline позже)
  }
  try {
    const dir = dirname(absPath)
    mkdirSync(dir, { recursive: true })
    writeFileSync(absPath, content, 'utf-8')
    return `Записано: ${relPath}`
  } catch (e) {
    return `Ошибка записи ${relPath}: ${e.message}`
  }
}

async function toolRunCommand(args, root, mode) {
  const { command } = args
  if (mode === 'plan') return `[plan mode] Команда заблокирована: ${command}`
  if (mode === 'ask') {
    process.stderr.write(`\n⚠  Агент хочет выполнить: ${command}\n`)
  }
  try {
    const output = execSync(command, {
      cwd: root,
      encoding: 'utf-8',
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return output || '(нет вывода)'
  } catch (e) {
    return `Ошибка (exitCode ${e.status ?? '?'}): ${e.message}\n${e.stderr ?? ''}`
  }
}

async function toolSearchProject(args, root) {
  const { query, glob: globPattern, ignoreCase = true, regex = false } = args
  try {
    // Пробуем ripgrep, fallback на grep
    const flags = ['-n', '--max-count=5', '--max-depth=20']
    if (ignoreCase) flags.push('-i')
    if (!regex) flags.push('-F')
    if (globPattern) flags.push(`--glob`, globPattern)
    for (const d of IGNORE_DIRS) flags.push(`--glob=!${d}/**`)
    flags.push('--', query, '.')

    const output = execFileSync('rg', flags, {
      cwd: root, encoding: 'utf-8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024
    })
    const lines = output.trim().split('\n').slice(0, 80)
    return lines.join('\n') || 'Совпадений не найдено'
  } catch (e) {
    if (e.status === 1) return 'Совпадений не найдено'
    // fallback — простой рекурсивный поиск
    try {
      const results = []
      await searchInDir(root, root, query.toLowerCase(), results, 80)
      return results.join('\n') || 'Совпадений не найдено'
    } catch {
      return `Ошибка поиска: ${e.message}`
    }
  }
}

async function searchInDir(dir, root, query, results, maxHits) {
  if (results.length >= maxHits) return
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (results.length >= maxHits) return
    const full = join(dir, e.name)
    const rel = relative(root, full)
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) await searchInDir(full, root, query, results, maxHits)
    } else if (e.isFile()) {
      try {
        const content = await readFile(full, 'utf-8')
        const lines = content.split('\n')
        lines.forEach((line, i) => {
          if (results.length < maxHits && line.toLowerCase().includes(query)) {
            results.push(`${rel}:${i + 1}: ${line.slice(0, 200)}`)
          }
        })
      } catch { /* skip binary */ }
    }
  }
}

async function toolFindFiles(args, root) {
  const { pattern } = args
  try {
    const results = []
    await findFilesInDir(root, root, pattern, results, 100)
    return results.join('\n') || 'Файлы не найдены'
  } catch (e) {
    return `Ошибка: ${e.message}`
  }
}

async function findFilesInDir(dir, root, pattern, results, maxHits) {
  if (results.length >= maxHits) return
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  // Простая glob-реализация: convert ** и * в regex
  const regStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape
    .replace(/\\\*\\\*/g, '.*')              // ** → .*
    .replace(/\\\*/g, '[^/]*')               // * → [^/]*
    .replace(/\\\?/g, '[^/]')               // ? → [^/]
  const rx = new RegExp('^' + regStr + '$')
  for (const e of entries) {
    if (results.length >= maxHits) return
    const full = join(dir, e.name)
    const rel = relative(root, full).replace(/\\/g, '/')
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) await findFilesInDir(full, root, pattern, results, maxHits)
    } else {
      if (rx.test(rel) || rx.test(e.name)) results.push(rel)
    }
  }
}

async function toolApplyPatch(args, root, mode) {
  const { path: relPath, diff } = args
  const absPath = safeJoin(root, relPath)
  if (isForbidden(absPath)) return `Доступ запрещён: ${relPath}`
  if (mode === 'plan') return `[plan mode] Патч заблокирован: ${relPath}`
  try {
    let content = await readFile(absPath, 'utf-8')
    // Парсим SEARCH/REPLACE блоки
    const blockRx = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g
    let match
    let applied = 0
    while ((match = blockRx.exec(diff)) !== null) {
      const [, search, replace] = match
      if (content.includes(search)) {
        content = content.replace(search, replace)
        applied++
      } else {
        return `Ошибка: блок SEARCH не найден в ${relPath}:\n${search.slice(0, 200)}`
      }
    }
    if (applied === 0) return `Предупреждение: ни один блок SEARCH/REPLACE не применён`
    writeFileSync(absPath, content, 'utf-8')
    return `Применено ${applied} блоков в ${relPath}`
  } catch (e) {
    return `Ошибка: ${e.message}`
  }
}

async function executeToolCli(name, args, root, mode) {
  switch (name) {
    case 'read_file':       return toolReadFile(args, root)
    case 'list_directory':  return toolListDirectory(args, root)
    case 'write_file':      return toolWriteFile(args, root, mode)
    case 'apply_patch':     return toolApplyPatch(args, root, mode)
    case 'run_command':     return toolRunCommand(args, root, mode)
    case 'search_project':  return toolSearchProject(args, root)
    case 'find_files':      return toolFindFiles(args, root)
    case 'get_project_map':
    case 'refresh_project_map': {
      // Простая реализация: tree + размеры
      const lines = []
      await buildProjectTree(root, root, lines, 0, 4)
      return `Структура проекта:\n${lines.join('\n')}`
    }
    default:
      return `Инструмент "${name}" недоступен в CLI-режиме`
  }
}

async function buildProjectTree(dir, root, lines, depth, maxDepth) {
  if (depth > maxDepth) return
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  const indent = '  '.repeat(depth)
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name)) continue
    lines.push(`${indent}${e.isDirectory() ? e.name + '/' : e.name}`)
    if (e.isDirectory()) {
      await buildProjectTree(join(dir, e.name), root, lines, depth + 1, maxDepth)
    }
  }
}

// ---------------------------------------------------------------------------
// Описание инструментов для провайдеров (JSON Schema)
// ---------------------------------------------------------------------------

const CLI_TOOL_DEFS = [
  {
    name: 'read_file',
    description: 'Прочитать содержимое файла относительно корня проекта',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Относительный путь от корня проекта' } },
      required: ['path']
    }
  },
  {
    name: 'list_directory',
    description: 'Перечислить файлы и папки в директории',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Относительный путь, "." для корня' } },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Записать содержимое файла. Используй для создания новых файлов или полной замены.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'apply_patch',
    description: 'Точечная правка файла через SEARCH/REPLACE блоки.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        diff: { type: 'string', description: 'Один или несколько SEARCH/REPLACE блоков' }
      },
      required: ['path', 'diff']
    }
  },
  {
    name: 'run_command',
    description: 'Запустить shell-команду в корне проекта',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command']
    }
  },
  {
    name: 'search_project',
    description: 'Полнотекстовый поиск по проекту',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        glob: { type: 'string' },
        ignoreCase: { type: 'boolean' },
        regex: { type: 'boolean' }
      },
      required: ['query']
    }
  },
  {
    name: 'find_files',
    description: 'Найти файлы по glob-паттерну',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern']
    }
  },
  {
    name: 'get_project_map',
    description: 'Получить структуру проекта (дерево директорий)',
    parameters: { type: 'object', properties: {} }
  },
]

// ---------------------------------------------------------------------------
// Провайдеры — реализации через HTTPS
// ---------------------------------------------------------------------------

// --- Gemini ---

const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-flash']
const GEMINI_DEFAULT = 'gemini-3.5-flash'

async function* sendGemini(apiKey, model, messages, tools) {
  // Разделяем system + history
  const sysMsg = messages.find(m => m.role === 'system')
  const systemInstruction = sysMsg ? { parts: [{ text: sysMsg.content }] } : undefined
  const history = messages.filter(m => m.role !== 'system')

  // Конвертируем сообщения в Gemini-формат
  const contents = history.map(m => {
    const role = m.role === 'assistant' ? 'model' : 'user'
    const parts = []
    if (m.content) parts.push({ text: m.content })
    if (m.toolCalls?.length) {
      for (const c of m.toolCalls) {
        const part = { functionCall: { name: c.name, args: c.args } }
        if (c.thoughtSignature) part.thoughtSignature = c.thoughtSignature
        parts.push(part)
      }
    }
    if (m.toolResults?.length) {
      for (const r of m.toolResults) {
        parts.push({
          functionResponse: {
            name: r.name,
            response: r.error ? { error: r.error } : { result: r.result }
          }
        })
      }
    }
    if (parts.length === 0) parts.push({ text: '' })
    return { role, parts }
  })

  const toolDecls = tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }))

  const body = {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(toolDecls.length ? { tools: [{ functionDeclarations: toolDecls }] } : {}),
    generationConfig: { temperature: 0.2 }
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
  const res = await httpsPost(url, {}, body)

  if (res.statusCode !== 200) {
    const errBody = await streamResponse(res)
    throw new Error(`Gemini HTTP ${res.statusCode}: ${errBody.slice(0, 500)}`)
  }

  // SSE stream
  let buffer = ''
  for await (const chunk of res) {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') { yield { type: 'done' }; return }
      try {
        const obj = JSON.parse(data)
        const cand = obj.candidates?.[0]
        if (!cand) continue
        for (const part of (cand.content?.parts ?? [])) {
          if (part.text) yield { type: 'text', text: part.text }
          if (part.functionCall) {
            yield {
              type: 'tool-call',
              call: {
                id: `gc-${Math.random().toString(36).slice(2)}`,
                name: part.functionCall.name,
                args: part.functionCall.args ?? {},
                thoughtSignature: part.thoughtSignature,
              }
            }
          }
        }
        if (cand.finishReason && cand.finishReason !== 'STOP') {
          // tool calls не имеют явного stopReason TOOL_CALL в streaming
        }
      } catch { /* skip malformed line */ }
    }
  }
  yield { type: 'done' }
}

// --- Claude (Anthropic) ---

const CLAUDE_MODELS = ['claude-opus-4-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5']
const CLAUDE_DEFAULT = 'claude-opus-4-5'

async function* sendClaude(apiKey, model, messages, tools) {
  const sysContent = messages.find(m => m.role === 'system')?.content ?? ''
  const history = messages.filter(m => m.role !== 'system')

  // Конвертируем в Claude-формат
  const claudeMsgs = []
  for (const m of history) {
    if (m.role === 'assistant') {
      const blocks = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      if (m.toolCalls?.length) {
        for (const c of m.toolCalls) {
          blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args })
        }
      }
      claudeMsgs.push({ role: 'assistant', content: blocks })
    } else {
      // user
      if (m.toolResults?.length) {
        const blocks = []
        if (m.content) blocks.push({ type: 'text', text: m.content })
        for (const r of m.toolResults) {
          const text = r.error
            ? `Error: ${r.error}\n${JSON.stringify(r.result).slice(0, 5000)}`
            : (typeof r.result === 'string' ? r.result : JSON.stringify(r.result).slice(0, 5000))
          blocks.push({ type: 'tool_result', tool_use_id: r.id, content: text })
        }
        claudeMsgs.push({ role: 'user', content: blocks })
      } else {
        claudeMsgs.push({ role: 'user', content: m.content || '' })
      }
    }
  }

  const claudeTools = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }))

  const body = {
    model,
    max_tokens: 8192,
    system: sysContent,
    messages: claudeMsgs,
    ...(claudeTools.length ? { tools: claudeTools } : {}),
    stream: true,
  }

  const res = await httpsPost(
    'https://api.anthropic.com/v1/messages',
    {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'interleaved-thinking-2025-05-14'
    },
    body
  )

  if (res.statusCode !== 200) {
    const errBody = await streamResponse(res)
    throw new Error(`Claude HTTP ${res.statusCode}: ${errBody.slice(0, 500)}`)
  }

  let buffer = ''
  let currentToolCall = null

  for await (const chunk of res) {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') { yield { type: 'done' }; return }
      try {
        const obj = JSON.parse(data)
        switch (obj.type) {
          case 'content_block_start':
            if (obj.content_block?.type === 'tool_use') {
              currentToolCall = { id: obj.content_block.id, name: obj.content_block.name, argsRaw: '' }
            }
            break
          case 'content_block_delta':
            if (obj.delta?.type === 'text_delta') {
              yield { type: 'text', text: obj.delta.text }
            }
            if (obj.delta?.type === 'input_json_delta' && currentToolCall) {
              currentToolCall.argsRaw += obj.delta.partial_json
            }
            break
          case 'content_block_stop':
            if (currentToolCall) {
              let args = {}
              try { args = JSON.parse(currentToolCall.argsRaw) } catch { /* ignore */ }
              yield { type: 'tool-call', call: { id: currentToolCall.id, name: currentToolCall.name, args } }
              currentToolCall = null
            }
            break
          case 'message_stop':
            yield { type: 'done' }
            return
        }
      } catch { /* skip */ }
    }
  }
  yield { type: 'done' }
}

// --- OpenAI-совместимые провайдеры ---

const OPENAI_PROVIDER_CONFIGS = {
  'openai': {
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5', 'gpt-4o', 'gpt-4o-mini', 'o1'],
    default: 'gpt-4o',
  },
  'grok': {
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-4-fast', 'grok-3'],
    default: 'grok-4',
  },
  'openrouter': {
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-opus-4-5', 'google/gemini-3-flash', 'openai/gpt-4o'],
    default: 'anthropic/claude-opus-4-5',
  },
  'deepseek': {
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    default: 'deepseek-chat',
  },
  'mistral': {
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-small-latest'],
    default: 'mistral-large-latest',
  },
  'groq': {
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768'],
    default: 'llama-3.3-70b-versatile',
  },
  'ollama': {
    baseUrl: 'http://localhost:11434/v1',
    models: ['llama3.2', 'codellama', 'qwen2.5-coder'],
    default: 'llama3.2',
  },
}

async function* sendOpenAiCompat(apiKey, baseUrl, model, messages, tools) {
  // Конвертируем в OpenAI-формат
  const oaiMessages = []
  for (const m of messages) {
    if (m.role === 'system') {
      oaiMessages.push({ role: 'system', content: m.content })
      continue
    }
    if (m.role === 'assistant') {
      const entry = { role: 'assistant', content: m.content || '' }
      if (m.toolCalls?.length) {
        entry.tool_calls = m.toolCalls.map(c => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) }
        }))
      }
      oaiMessages.push(entry)
      continue
    }
    // user
    if (m.toolResults?.length) {
      if (m.content) oaiMessages.push({ role: 'user', content: m.content })
      for (const r of m.toolResults) {
        const text = r.error
          ? `Error: ${r.error}`
          : (typeof r.result === 'string' ? r.result : JSON.stringify(r.result).slice(0, 5000))
        oaiMessages.push({ role: 'tool', tool_call_id: r.id, content: text })
      }
    } else {
      oaiMessages.push({ role: 'user', content: m.content || '' })
    }
  }

  const oaiTools = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))

  const body = {
    model,
    messages: oaiMessages,
    stream: true,
    ...(oaiTools.length ? { tools: oaiTools, tool_choice: 'auto' } : {}),
  }

  const headers = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}
  const res = await httpsPost(`${baseUrl}/chat/completions`, headers, body)

  if (res.statusCode !== 200) {
    const errBody = await streamResponse(res)
    throw new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 500)}`)
  }

  let buffer = ''
  const pendingToolCalls = {}  // id → { name, argsRaw }

  for await (const chunk of res) {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') { yield { type: 'done' }; return }
      try {
        const obj = JSON.parse(data)
        const delta = obj.choices?.[0]?.delta
        if (!delta) continue
        if (delta.content) yield { type: 'text', text: delta.content }
        if (delta.tool_calls?.length) {
          for (const tc of delta.tool_calls) {
            const idx = String(tc.index ?? 0)
            if (!pendingToolCalls[idx]) {
              pendingToolCalls[idx] = {
                id: tc.id ?? `tc-${idx}`,
                name: tc.function?.name ?? '',
                argsRaw: ''
              }
            }
            if (tc.id) pendingToolCalls[idx].id = tc.id
            // Имя приходит целиком в одном delta у большинства провайдеров; часть
            // (DeepSeek/Qwen/др.) шлёт его в КАЖДОМ delta повторно → += давал
            // «read_fileread_file» и все tool-calls отвергались как неизвестные.
            // Присваиваем (как GUI-парсер openai-compat.ts), а не аккумулируем.
            if (tc.function?.name) pendingToolCalls[idx].name = tc.function.name
            if (tc.function?.arguments) pendingToolCalls[idx].argsRaw += tc.function.arguments
          }
        }
        const finishReason = obj.choices?.[0]?.finish_reason
        if (finishReason === 'tool_calls' || (finishReason === 'stop' && Object.keys(pendingToolCalls).length)) {
          for (const [, tc] of Object.entries(pendingToolCalls)) {
            let args = {}
            try { args = JSON.parse(tc.argsRaw) } catch { /* ignore */ }
            yield { type: 'tool-call', call: { id: tc.id, name: tc.name, args } }
          }
          // Очищаем — но не выходим, поток может продолжаться
          for (const k of Object.keys(pendingToolCalls)) delete pendingToolCalls[k]
        }
        if (finishReason === 'stop') { yield { type: 'done' }; return }
      } catch { /* skip */ }
    }
  }
  // Flush remaining tool calls
  for (const [, tc] of Object.entries(pendingToolCalls)) {
    let args = {}
    try { args = JSON.parse(tc.argsRaw) } catch { /* ignore */ }
    yield { type: 'tool-call', call: { id: tc.id, name: tc.name, args } }
  }
  yield { type: 'done' }
}

// ---------------------------------------------------------------------------
// Маршрутизация провайдера
// ---------------------------------------------------------------------------

function getProviderStream(provider, apiKey, model, messages, tools) {
  switch (provider) {
    case 'gemini-api':
      return sendGemini(apiKey, model ?? GEMINI_DEFAULT, messages, tools)
    case 'claude':
      return sendClaude(apiKey, model ?? CLAUDE_DEFAULT, messages, tools)
    default: {
      const cfg = OPENAI_PROVIDER_CONFIGS[provider]
      if (!cfg) throw new Error(`Неизвестный провайдер: "${provider}". Используйте --help для списка.`)
      return sendOpenAiCompat(apiKey, cfg.baseUrl, model ?? cfg.default, messages, tools)
    }
  }
}

// ---------------------------------------------------------------------------
// Основной агентный цикл
// ---------------------------------------------------------------------------

async function runAgent({ provider, model, apiKey, projectPath, mode, json: jsonMode, prompt, recipe, recipeProtocol, maxTurns, traceJson }) {
  const systemPrompt = buildSystemPrompt(projectPath, recipeProtocol)
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt }
  ]

  const allAssistantTexts = []
  const trace = {
    provider,
    model: model ?? '(default)',
    recipeId: recipe?.id ?? null,
    toolCalls: [],
    firstMutatingTool: null,
    baselineTaken: false,
    verifyCommands: recipe?.verify?.commands ?? [],
    reviewGate: recipe?.reviewer?.required ? 'required' : 'not-required',
    finalStatus: 'running',
    failureReason: null,
  }
  const MAX_TURNS = maxTurns

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let fullText = ''
    const toolCalls = []

    const stream = getProviderStream(provider, apiKey, model, messages, CLI_TOOL_DEFS)

    for await (const event of stream) {
      if (event.type === 'text') {
        fullText += event.text
        if (!jsonMode) process.stdout.write(event.text)
      }
      if (event.type === 'tool-call') {
        toolCalls.push(event.call)
      }
      if (event.type === 'error') {
        if (!jsonMode) process.stderr.write(`\nОшибка провайдера: ${event.message}\n`)
        process.exit(1)
      }
      if (event.type === 'done') break
    }

    if (fullText) allAssistantTexts.push(fullText)

    // Собираем assistant message
    const assistantMsg = { role: 'assistant', content: fullText }
    if (toolCalls.length) assistantMsg.toolCalls = toolCalls
    messages.push(assistantMsg)

    // Нет tool calls — агент завершил работу
    if (toolCalls.length === 0) break

    // Выводим сообщение о вызовах инструментов (не в json-режиме)
    if (!jsonMode) {
      process.stderr.write(`\n[${toolCalls.map(c => c.name).join(', ')}]\n`)
    }

    // Выполняем инструменты
    const toolResults = []
    for (const call of toolCalls) {
      trace.toolCalls.push({ turn, name: call.name, args: scrubTraceArgs(call.args) })
      if (!trace.firstMutatingTool && isMutatingToolName(call.name)) {
        trace.firstMutatingTool = call.name
      }
      let result
      try {
        result = await executeToolCli(call.name, call.args, projectPath, mode)
      } catch (e) {
        result = `Ошибка: ${e.message}`
      }
      toolResults.push({ id: call.id, name: call.name, result })
    }

    // Добавляем результаты как user-сообщение
    messages.push({ role: 'user', content: '', toolResults })
  }

  trace.finalStatus = 'success'

  if (!jsonMode) {
    // Финальный перенос строки если вывод не заканчивается на \n
    if (allAssistantTexts.length && !allAssistantTexts.at(-1).endsWith('\n')) {
      process.stdout.write('\n')
    }
  } else {
    const output = {
      success: true,
      provider,
      model: model ?? '(default)',
      projectPath,
      prompt,
      response: allAssistantTexts.join('\n'),
      messages: messages.filter(m => m.role !== 'system'),
      ...(traceJson || recipe ? { trace } : {}),
    }
    console.log(JSON.stringify(output, null, 2))
  }
}

function scrubTraceArgs(args) {
  const out = {}
  for (const [k, v] of Object.entries(args ?? {})) {
    if (/key|token|secret|password|cookie|authorization/i.test(k)) out[k] = '[REDACTED]'
    else if (typeof v === 'string') out[k] = v.length > 300 ? v.slice(0, 300) + '…' : v
    else out[k] = v
  }
  return out
}

function isMutatingToolName(name) {
  return new Set(['write_file', 'apply_patch', 'edit_file', 'create_file', 'apply_diff']).has(name)
}

// ---------------------------------------------------------------------------
// Точка входа
// ---------------------------------------------------------------------------

try {
  const maxTurns = Math.max(1, Math.min(100, Number(values['max-turns'] ?? 20) || 20))
  if (isRecipeRun && values['dry-run']) {
    const trace = {
      provider: values.provider,
      model: values.model ?? '(default)',
      recipeId: recipeSpec.id,
      toolCalls: [],
      firstMutatingTool: null,
      baselineTaken: false,
      verifyCommands: recipeSpec.verify?.commands ?? [],
      reviewGate: recipeSpec.reviewer?.required ? 'required' : 'not-required',
      finalStatus: 'dry-run',
      failureReason: null,
    }
    const payload = {
      success: true,
      command: 'recipe run',
      projectPath,
      task: prompt,
      recipe: recipeSpec,
      protocol: recipeProtocol,
      trace,
    }
    console.log(values.json || values['trace-json'] ? JSON.stringify(payload, null, 2) : recipeProtocol)
    process.exit(0)
  }

  const apiKey = resolveApiKey(values.provider, values.key)
  await runAgent({
    provider: values.provider,
    model: values.model,
    apiKey,
    projectPath,
    mode: values.mode,
    json: values.json,
    prompt,
    recipe: recipeSpec,
    recipeProtocol,
    maxTurns,
    traceJson: values['trace-json'],
  })
  process.exit(0)
} catch (err) {
  // F14 (claw-code parity): при --json отдаём typed error envelope, иначе текст.
  const code = /API-ключ.*не найден/.test(err.message) ? 'api_key_not_found'
    : /вне.*проект|outside/i.test(err.message) ? 'path_denied'
    : 'agent_error'
  if (values.json) {
    console.error(JSON.stringify({ ok: false, error_code: code, message: err.message }))
  } else {
    console.error(`\nОшибка: ${err.message}`)
  }
  process.exit(1)
}
