/**
 * Context Pack — динамический срез состояния репозитория, который
 * автоматически инжектится в system prompt перед каждым ai:send.
 *
 * Зачем: без этого блока агент тратит лишние 2-5 read_file/list_directory
 * на «понять что происходит». С Context Pack модель уже знает:
 *   - какая ветка / есть ли uncommitted изменения
 *   - какие файлы редактировались в последние N сессий
 *   - примерную форму проекта (сжатая project map)
 *   - какой verify-script доступен (если есть)
 *
 * Цена: ~300-1500 токенов на запрос. Окупается уже на 1 сэкономленном
 * read_file. На длинных задачах экономит десятки turn'ов.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { getProjectMap, projectMapToText, getDependencyMap, computeDependencyHubs } from './project-map'
import type { DependencyMap, ProjectMap } from './project-map'
import { detectCrossProjectPaths } from './grounding'
import { buildProfileBlock, loadProjectProfile, type ProjectProfile } from './project-profile'
// Re-export for backward compatibility — tests still import from here.
export { detectCrossProjectPaths }

/** Минимальный срез Memory — только поля, нужные для инжекции в context-pack. */
interface MemoryEntry {
  type: string
  content: string
  tags: string[]
}

/** Core memory blocks — всегда в system prompt (загружаются при каждом turn'е). */
interface CoreMemoryBlocks {
  memory: string
  user: string
}

const execFileAsync = promisify(execFile)

export interface ContextPackInput {
  projectPath: string
  /** Recently accepted file writes (most recent first). Up to ~10 entries. */
  recentWrites?: Array<{ filePath: string; createdAt: number }>
  /** Latest user message — scanned for absolute paths outside the active project. */
  latestUserMessage?: string
  /** True when this is the first user message in the chat session. We nudge
   *  the model to call get_project_map BEFORE reading individual files. */
  isFirstTurn?: boolean
  /** Топ-5 воспоминаний проекта из долговременной памяти — инжектятся как
   *  информационный блок. Пустой массив или undefined = секция не добавляется. */
  memories?: MemoryEntry[]
  /** Core memory (Hermes-style) — всегда в system prompt, обновляется агентом через tools.
   *  Инжектируется ДО архивной памяти, т.к. всегда релевантна. */
  coreMemory?: CoreMemoryBlocks
  /** Граф зависимостей проекта. Если не передан — context-pack сам подтянет его
   *  из кэша (getDependencyMap дёшев на тёплом кэше после warm на открытии).
   *  Передавать явно стоит только чтобы не дёргать кэш дважды. */
  dependencyMap?: DependencyMap
  /** v3 Шаг C: machine-readable профиль проекта (из брифа/автоскана). Инжектится
   *  как постоянный блок, чтобы модель не собирала контекст заново. */
  profile?: ProjectProfile
}

/**
 * Архитектурная секция карты: топ-хабы (самые импортируемые файлы) + ключевые
 * символы этих файлов. Это даёт агенту опоры проекта — он сразу видит не только
 * пути, но и что внутри центральных модулей, без лишних read_file.
 *
 * Бюджет держим узким (символы только для хабов, не для всех файлов), т.к. блок
 * идёт в КАЖДЫЙ запрос. Возвращает '' если граф пуст (не проект / нет связей).
 */
function buildDependencySection(dep: DependencyMap, map: ProjectMap | null): string {
  const hubs = computeDependencyHubs(dep, 7)
  if (hubs.length === 0) return ''
  const lines: string[] = []
  // Одна сводная строка хабов — опоры архитектуры с числом импортов.
  lines.push(`dependency_hubs (самые импортируемые): ${hubs.map(h => `${h.path} (×${h.importedBy})`).join(', ')}`)
  // Ключевые символы для топ-5 хабов — из project map (если доступна), иначе
  // из exports графа зависимостей. Только хабы, не весь проект — бюджет.
  const symbolLines: string[] = []
  for (const hub of hubs.slice(0, 5)) {
    let syms: string[] = []
    const entry = map?.files.find(f => f.path === hub.path)
    if (entry && entry.symbols.length > 0) {
      syms = entry.symbols.slice(0, 6).map(s => `${s.kind}:${s.name}`)
    } else {
      syms = (dep.files[hub.path]?.exports ?? []).slice(0, 6)
    }
    if (syms.length > 0) symbolLines.push(`  ${hub.path}: ${syms.join(', ')}`)
  }
  if (symbolLines.length > 0) {
    lines.push('hub_symbols (что внутри ключевых модулей):')
    lines.push(...symbolLines)
  }
  return lines.join('\n')
}

/**
 * Build a compact <context_pack> block ready to append to the system prompt.
 * Never throws — degraded data is better than no data, and we don't want a
 * cold git repo or missing tools to break the AI request.
 */
export async function buildContextPack(input: ContextPackInput): Promise<string> {
  const { projectPath } = input
  const parts: string[] = []

  // -1. First-turn nudge: AI tends to dive into read_file before understanding
  //     the project shape. When this is the first user message, suggest
  //     get_project_map first for structure/architecture questions.
  if (input.isFirstTurn) {
    parts.push(`first_turn: true — для вопросов про архитектуру/структуру/стек проекта СНАЧАЛА вызови get_project_map (это дешевле чем несколько read_file). Для конкретных задач — действуй как обычно.`)
  }

  // 0. Профиль проекта (v3 Шаг C) — постоянный machine-readable снимок. Идёт
  //    в начало: модель сразу знает суть/стек/конвенции, не собирая контекст заново.
  //    input.profile (тесты) имеет приоритет; иначе сам читаем .verstak/profile.json.
  const profile = input.profile ?? await loadProjectProfile(projectPath)
  const profileBlock = buildProfileBlock(profile)
  if (profileBlock) parts.push(profileBlock)

  // 0. Cross-project path warning — if user mentioned an absolute path that
  //    isn't inside this project, the AI can't access it. We surface this so
  //    it tells the user instead of silently reading the wrong project's files.
  const crossProject = detectCrossProjectPaths(input.latestUserMessage ?? '', projectPath)
  if (crossProject.length > 0) {
    parts.push(`⚠ cross_project_paths: пользователь упомянул пути вне активного проекта (${projectPath}): ${crossProject.join('; ')}. Активный проект — другой. Сначала сообщи пользователю и предложи переключить проект в сайдбаре, либо переформулировать задачу.`)
  }

  // 1. Git status (branch + dirty file list). Skipped silently if not a git repo.
  const git = await readGitStatus(projectPath)
  if (git) parts.push(`git: ${git}`)

  // 2. Recent writes — what we touched in this project recently.
  if (input.recentWrites && input.recentWrites.length > 0) {
    const list = input.recentWrites.slice(0, 8).map(w => w.filePath).join(', ')
    parts.push(`recent_writes (${input.recentWrites.length}): ${list}`)
  }

  // Read package.json ONCE per buildContextPack — multiple detectors
  // (verify scripts, product stack, possibly more) share the parsed view.
  const pkg = await readPackageJson(projectPath)

  // 3. Verify scripts — hints to the model what command to run after edits.
  const verifyHints = await detectVerifyScripts(projectPath, pkg)
  if (verifyHints.length > 0) parts.push(`verify_scripts: ${verifyHints.join(', ')}`)

  // 3b. Product stack — derived from the same parsed package.json.
  const stack = await detectProductStack(projectPath, pkg)
  if (stack) parts.push(`product_stack: ${stack}`)

  // 4. Project map (compact mode — the formatter knows the budget, no
  //    text re-parsing here). Cache is auto-invalidated on write_file.
  let mapBlock = ''
  let projectMap: ProjectMap | null = null
  try {
    projectMap = await getProjectMap(projectPath, false)
    // Бюджет поднят 1500 → 2500: компактная карта остаётся «список путей»,
    // но архитектурная нагрузка (символы хабов) живёт в отдельной dep-секции
    // ниже со своим узким бюджетом, а не раздувает этот список.
    mapBlock = projectMapToText(projectMap, { mode: 'compact', maxChars: 2500 })
  } catch {
    /* map build failed — skip silently */
  }

  // 4b. Dependency hubs + key symbols — архитектурные опоры проекта. Граф
  //     кэшируется (getDependencyMap дёшев после warm на открытии), поэтому
  //     инжект почти бесплатен по времени. Бюджет узкий: символы только для
  //     хабов. Это идёт в каждый запрос — держим компактным.
  let depBlock = ''
  try {
    const dep = input.dependencyMap ?? await getDependencyMap(projectPath, false)
    depBlock = buildDependencySection(dep, projectMap)
  } catch {
    /* dependency map build failed — skip silently */
  }

  // 5. Core Memory (Hermes-style) — всегда в system prompt, загружается при каждом turn'е.
  //    MEMORY.md = заметки о проекте, USER.md = заметки о пользователе.
  //    Инжектируется перед архивной памятью — она всегда актуальна, не нужно искать.
  let coreMemorySection = ''
  if (input.coreMemory) {
    const { memory, user } = input.coreMemory
    const hasMemory = memory.trim().length > 0
    const hasUser = user.trim().length > 0
    if (hasMemory || hasUser) {
      const parts2: string[] = []
      if (hasMemory) parts2.push(`### О проекте (MEMORY.md)\n${memory.trim()}`)
      if (hasUser) parts2.push(`### О пользователе (USER.md)\n${user.trim()}`)
      coreMemorySection = `\n\n## Core Memory (обновляется агентом)\n\n${parts2.join('\n\n')}`
    }
  }

  // 6. Долговременная память — топ-N воспоминаний проекта. Каждое — одна строка,
  //    только информационно, не инструкция. Не добавляем пустую секцию.
  let memorySection = ''
  if (input.memories && input.memories.length > 0) {
    const lines = input.memories.slice(0, 5).map(m => {
      const tags = m.tags.length > 0 ? `${m.tags.join(', ')} — ` : ''
      return `[${m.type}] ${tags}${m.content}`
    })
    memorySection = `\n\n## Память агента (из прошлых сессий)\n\n${lines.join('\n')}`
  }

  if (parts.length === 0 && !mapBlock && !depBlock && !coreMemorySection && !memorySection) return ''

  const meta = parts.length > 0 ? parts.join('\n') : '(no git, no recent writes)'
  const mapSection = mapBlock ? `\n\nproject_map (compact):\n${mapBlock}` : ''
  const depSection = depBlock ? `\n\n${depBlock}` : ''
  return `<context_pack generated="auto" project="${escapeAttr(projectPath)}">
${meta}${mapSection}${depSection}${coreMemorySection}${memorySection}
</context_pack>`
}

/**
 * Run `git status -sb` and `git rev-parse --abbrev-ref HEAD` and turn the
 * output into a single-line summary. Returns null if not a git repo.
 */
async function readGitStatus(projectPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '-sb'], {
      cwd: projectPath, timeout: 5000, windowsHide: true, maxBuffer: 256 * 1024
    })
    const lines = stdout.split('\n').map(l => l.trimEnd()).filter(Boolean)
    if (lines.length === 0) return null
    const head = lines[0].replace(/^## /, '')
    const body = lines.slice(1)
    if (body.length === 0) return `${head} (clean)`
    const modified = body.filter(l => /^ ?[MARCD]/.test(l)).length
    const untracked = body.filter(l => l.startsWith('?? ')).length
    const summary = `${head}, ${modified} modified, ${untracked} untracked`
    // Include first 5 actual paths so model can target them
    const firstFew = body.slice(0, 5).map(l => l.trim()).join('; ')
    return `${summary}${firstFew ? ` [${firstFew}]` : ''}`
  } catch {
    return null
  }
}

/**
 * Shared parsed view of package.json. Cached per buildContextPack invocation
 * so multiple detectors (verify scripts, product stack, future stack hints)
 * don't re-read & re-parse the same file. Falls back to null if not present
 * or unparseable — every caller must tolerate missing data.
 */
interface ParsedPkg {
  name?: string
  type?: string
  main?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
async function readPackageJson(projectPath: string): Promise<ParsedPkg | null> {
  try {
    const raw = await readFile(join(projectPath, 'package.json'), 'utf8')
    return JSON.parse(raw) as ParsedPkg
  } catch { return null }
}

/**
 * Look at package.json scripts (and existence of tsconfig / php files) to
 * suggest what verify command to run after edits.
 */
async function detectVerifyScripts(projectPath: string, pkg: ParsedPkg | null): Promise<string[]> {
  const hints: string[] = []
  if (pkg) {
    const scripts = pkg.scripts ?? {}
    if (scripts.test) hints.push('npm test')
    if (scripts['type-check'] || scripts.typecheck) hints.push('npm run type-check')
    if (scripts.lint) hints.push('npm run lint')
    if (scripts.build) hints.push('npm run build')
  }
  // tsconfig present → tsc --noEmit is a reasonable verify; check_diagnostics tool доступен
  try {
    await readFile(join(projectPath, 'tsconfig.json'), 'utf8')
    if (!hints.some(h => h.includes('tsc') || h.includes('type-check'))) {
      hints.push('npx tsc --noEmit')
    }
    hints.push('check_diagnostics (после правок .ts/.tsx файлов используй этот tool для проверки типов)')
  } catch { /* no tsconfig */ }
  return hints.slice(0, 5)  // cap to keep it short
}

/**
 * Quick summary of "what kind of project is this", derived from the shared
 * ParsedPkg + Python fallbacks.
 */
async function detectProductStack(projectPath: string, pkg: ParsedPkg | null): Promise<string> {
  if (pkg) {
    const deps: Record<string, string> = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    const hints: string[] = []
    if (deps['electron']) hints.push('electron')
    if (deps['next']) hints.push('next.js')
    else if (deps['react']) hints.push('react')
    if (deps['vue']) hints.push('vue')
    if (deps['svelte']) hints.push('svelte')
    if (deps['vite'] || deps['electron-vite']) hints.push('vite')
    if (deps['typescript']) hints.push('typescript')
    if (deps['better-sqlite3']) hints.push('better-sqlite3')
    if (deps['express']) hints.push('express')
    if (deps['fastify']) hints.push('fastify')
    const stack = hints.length > 0 ? hints.join(' + ') : 'node'
    const name = pkg.name ? ` (${pkg.name})` : ''
    return `${stack}${name}`
  }
  // Try Python fallback
  try {
    await readFile(join(projectPath, 'pyproject.toml'), 'utf8')
    return 'python (pyproject.toml)'
  } catch { /* none */ }
  try {
    const raw = await readFile(join(projectPath, 'requirements.txt'), 'utf8')
    const hints: string[] = ['python']
    if (/fastapi/i.test(raw)) hints.push('fastapi')
    else if (/flask/i.test(raw)) hints.push('flask')
    else if (/django/i.test(raw)) hints.push('django')
    return hints.join(' + ')
  } catch { /* none */ }
  return ''
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// detectCrossProjectPaths moved to ./grounding.ts
