/**
 * Project Warmup (Итерация 3) — наполняет Project Brain: скан проекта → важные
 * файлы → FileSummary по каждому → overview → ContextPack short/medium/long.
 * После «прогрева» AI-запрос жмёт готовый ContextPack вместо всего проекта заново.
 *
 * Чистые функции (выбор файлов / stub-summary / сборка пакетов) тестируются
 * напрямую. Оркестратор runWarmup инжектит IO (чтение файлов + store) — тоже
 * тестируется с моками. Summary в MVP — эвристический stub; реальный AI-
 * summarizer подключается позже той же сигнатурой (per ТЗ).
 */

import type { FileSummary, ContextPack, ProjectBrainStore } from '../../storage/project-brain'

const EXCLUDE_DIRS = ['node_modules', '.git', 'dist', 'build', 'out', 'release', 'coverage', '.next', '.cache', '.turbo', 'venv', '__pycache__']
const EXCLUDE_EXT = ['.lock', '.map', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.woff', '.woff2', '.ttf', '.eot', '.exe', '.dll', '.zip', '.7z', '.gz', '.pdf', '.mp4', '.mp3', '.wasm', '.node', '.bin', '.db', '.sqlite']

/** Путь — мусор для прогрева (исключить из скана). */
export function isExcludedPath(rel: string): boolean {
  const p = rel.replace(/\\/g, '/').toLowerCase()
  if (EXCLUDE_DIRS.some(d => p === d || p.startsWith(d + '/') || p.includes('/' + d + '/'))) return true
  if (EXCLUDE_EXT.some(e => p.endsWith(e))) return true
  if (/(^|\/)package-lock\.json$|(^|\/)yarn\.lock$|(^|\/)pnpm-lock\.yaml$/.test(p)) return true
  return false
}

// Паттерны важности (выше score → раньше попадает в выборку).
const IMPORTANT: Array<{ re: RegExp; score: number }> = [
  { re: /(^|\/)readme\.md$/i, score: 100 },
  { re: /(^|\/)package\.json$/i, score: 95 },
  { re: /(^|\/)(claude|agents|gemini)\.md$/i, score: 92 },
  { re: /\.(config|rc)\.(ts|js|json|cjs|mjs)$/i, score: 85 },
  { re: /(^|\/)tsconfig.*\.json$/i, score: 80 },
  { re: /(^|\/)(index|main|app|server)\.(ts|tsx|js|py)$/i, score: 78 },
  { re: /(registry|router|routes|store|state)\.(ts|tsx|js)$/i, score: 72 },
  { re: /(^|\/)src\/(core|lib|ai|store|ipc|storage)\//i, score: 60 },
  { re: /(^|\/)docs?\//i, score: 50 },
  { re: /\.(ts|tsx|py|go|rs|java)$/i, score: 30 },
  { re: /\.(js|jsx|css|md)$/i, score: 20 },
]

function score(rel: string): number {
  const p = rel.replace(/\\/g, '/')
  if (/\.(test|spec)\.[tj]sx?$/.test(p)) return 5 // тесты — низкий приоритет
  let best = 0
  for (const { re, score } of IMPORTANT) if (re.test(p)) best = Math.max(best, score)
  return best
}

/** Выбрать важные файлы для прогрева: исключить мусор → отсортировать по важности → cap. */
export function selectImportantFiles(files: string[], maxFiles = 40): string[] {
  return files
    .filter(f => !isExcludedPath(f))
    .map(f => ({ f, s: score(f) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || a.f.localeCompare(b.f))
    .slice(0, maxFiles)
    .map(x => x.f)
}

/** Грубая оценка токенов (≈ символы/4). */
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4)
}

/**
 * Эвристический stub-summary файла (MVP). Реальный AI-summarizer подключится
 * этой же сигнатурой. Берёт первый осмысленный комментарий/строку + символы.
 */
export function summarizeFileStub(filePath: string, content: string, symbols?: string[]): FileSummary {
  const lines = content.split('\n')
  // Первая содержательная строка комментария/описания.
  const firstDoc = lines.find(l => /^\s*(\/\/|\*|#|\/\*)/.test(l) && l.replace(/[^a-zа-я0-9]/gi, '').length > 8)
  const head = (firstDoc ?? lines.find(l => l.trim().length > 0) ?? '').replace(/^[\s/*#-]+/, '').trim().slice(0, 160)
  const exports = (symbols && symbols.length > 0)
    ? symbols.slice(0, 8)
    : Array.from(content.matchAll(/export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+([A-Za-z0-9_]+)/g)).map(m => m[1]).slice(0, 8)
  const deps = Array.from(content.matchAll(/(?:import|from)\s+['"]([^'"]+)['"]/g)).map(m => m[1]).filter(d => d.startsWith('.')).slice(0, 6)
  return {
    filePath,
    fileHash: null,
    summary: head || `${filePath} (${lines.length} строк)`,
    keyExports: Array.from(new Set(exports)),
    keyDependencies: Array.from(new Set(deps)),
    risks: null,
    tokenEstimate: estimateTokens(content),
  }
}

/** Бюджеты токенов на пакеты (Итер.3 ТЗ: short 1-2k / medium 4-8k / long 12-20k). */
const PACK_BUDGET: Record<ContextPack['type'], number> = { short: 2000, medium: 8000, long: 20000 }

/**
 * Собрать ContextPack из summary файлов под бюджет токенов. short — заголовки +
 * 1 строка, long — с экспортами/зависимостями. overview идёт в начало каждого.
 */
export function buildContextPack(type: ContextPack['type'], overview: string, summaries: FileSummary[]): ContextPack {
  const budget = PACK_BUDGET[type]
  const lines: string[] = []
  if (overview) lines.push(`## Обзор проекта\n${overview}`, '')
  lines.push('## Ключевые файлы')
  const used: string[] = []
  for (const s of summaries) {
    let block = `- ${s.filePath}: ${s.summary ?? ''}`
    if (type !== 'short' && s.keyExports.length) block += `\n  экспорт: ${s.keyExports.join(', ')}`
    if (type === 'long' && s.keyDependencies.length) block += `\n  зависит: ${s.keyDependencies.join(', ')}`
    const next = lines.join('\n') + '\n' + block
    if (estimateTokens(next) > budget && used.length > 0) break
    lines.push(block)
    used.push(s.filePath)
  }
  const content = lines.join('\n')
  return { type, content, tokenEstimate: estimateTokens(content), sourceFiles: used }
}

/**
 * Выбрать слой ContextPack под задачу (Итер.4): короткий запрос → short,
 * план/архитектура → medium, глубокий разбор проекта → long.
 */
export function pickPackType(message: string | null | undefined): ContextPack['type'] {
  const t = (message ?? '').toLowerCase()
  if (/архитектур|как устроен|весь проект|целиком|рефактор|глубок|across the (codebase|project)|весь код/.test(t)) return 'long'
  if (/план|спроектир|design|подход|обзор|карт[аы]|где (реализ|лежит|искать)|почему/.test(t) || t.length > 300) return 'medium'
  return 'short'
}

export interface WarmupDeps {
  /** project-relative пути всех файлов проекта. */
  listFiles: () => Promise<string[]>
  /** Прочитать содержимое файла (project-relative). null при ошибке. */
  readFile: (rel: string) => Promise<string | null>
  /** Символы файла из project-map (опционально, улучшает summary). */
  symbolsFor?: (rel: string) => string[] | undefined
  store: ProjectBrainStore
}

export interface WarmupResult {
  filesScanned: number
  filesSummarized: number
  packs: Array<{ type: ContextPack['type']; tokenEstimate: number | null }>
}

/** Оркестратор прогрева: скан → summary → overview → packs → сохранить в Brain. */
export async function runWarmup(projectPath: string, deps: WarmupDeps, maxFiles = 40): Promise<WarmupResult> {
  const all = await deps.listFiles()
  const important = selectImportantFiles(all, maxFiles)

  const summaries: FileSummary[] = []
  for (const rel of important) {
    const content = await deps.readFile(rel)
    if (content == null) continue
    const fs = summarizeFileStub(rel, content, deps.symbolsFor?.(rel))
    summaries.push(fs)
    deps.store.saveFileSummary(projectPath, fs)
  }

  const overview = `Проект из ${all.length} файлов. Прогрето ${summaries.length} ключевых. `
    + `Топ: ${summaries.slice(0, 6).map(s => s.filePath).join(', ')}.`

  deps.store.updateBrain(projectPath, {
    overview,
    importantFiles: important,
    lastWarmupAt: Date.now(),
  })

  const packs: ContextPack[] = (['short', 'medium', 'long'] as const).map(t => buildContextPack(t, overview, summaries))
  for (const p of packs) deps.store.saveContextPack(projectPath, p)

  return {
    filesScanned: all.length,
    filesSummarized: summaries.length,
    packs: packs.map(p => ({ type: p.type, tokenEstimate: p.tokenEstimate })),
  }
}
