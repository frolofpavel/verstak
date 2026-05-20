import { readFile, readdir, stat, writeFile } from 'fs/promises'
import { join, resolve, relative, sep } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import type { ToolDefinition } from './types'
import { classifyCommand } from './command-policy'
import { isForbiddenPath, scanText } from './secret-scanner'

const execFileAsync = promisify(execFile)

const MAX_READ_BYTES = 2 * 1024 * 1024  // 2 MB
const MAX_SEARCH_HITS = 80
const MAX_LINE_CHARS = 220
const IGNORE_DIRS = new Set(['node_modules', '.git', 'out', 'dist', '.next', '.vite', '.geminigrok-data', '.superpowers', '__pycache__', 'venv', '.venv', 'target', 'build'])

export const TOOL_DEFS: ToolDefinition[] = [
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
    description: 'Записать содержимое в файл. Требует подтверждения пользователя.',
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
    name: 'run_command',
    description: 'Запустить shell-команду в корне проекта. Команда требует подтверждения пользователя. Возвращает stdout/stderr/exitCode.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Команда для shell. Без побочных эффектов вне проекта.' } },
      required: ['command']
    }
  },
  {
    name: 'search_project',
    description: 'Полнотекстовый поиск по проекту (ripgrep). Возвращает совпадения в формате file:line:text. Игнорирует node_modules / .git / out / dist. Используй для нахождения определений функций, использований переменных, текстовых фрагментов.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Текст или regex для поиска.' },
        glob: { type: 'string', description: 'Опциональный glob-фильтр путей, например "**/*.ts" или "src/**".' },
        ignoreCase: { type: 'boolean', description: 'Игнорировать регистр (default true).' },
        regex: { type: 'boolean', description: 'Интерпретировать query как regex (default false, тогда литеральный поиск).' }
      },
      required: ['query']
    }
  },
  {
    name: 'find_files',
    description: 'Найти файлы в проекте по glob-паттерну. Возвращает относительные пути. Используй до read_file, когда не знаешь точное имя.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob, например "**/*.test.ts" или "src/**/Chat.tsx".' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'list_connectors',
    description: 'Перечислить внешние коннекторы (1С OData и т.п.) — что подключено, готово ли к работе. Возвращает массив { id, label, kind, status, detail }.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'connector_query',
    description: 'Выполнить запрос к внешнему коннектору. Для 1С (id="onec") — entity + filter/select/top или metadata:true. Для HTTP (id="http") — endpoint + method + path + query/body/headers. Креды и base URL берутся из настроек — НЕ передавай пароли в args.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID коннектора: "onec" | "http".' },
        // 1С OData params
        entity: { type: 'string', description: '[onec] Имя OData-сущности, например "Catalog_Контрагенты".' },
        filter: { type: 'string', description: '[onec] OData $filter.' },
        select: { type: 'string', description: '[onec] Список полей через запятую.' },
        top: { type: 'number', description: '[onec] Размер страницы 1..100.' },
        metadata: { type: 'boolean', description: '[onec] Если true — вернёт $metadata.' },
        // HTTP params
        endpoint: { type: 'string', description: '[http] Имя сконфигурированного эндпоинта.' },
        method: { type: 'string', description: '[http] GET/POST/PUT/DELETE/PATCH (default GET).' },
        path: { type: 'string', description: '[http] Относительный путь от base URL.' },
        query: { type: 'object', description: '[http] Query-параметры (плоский объект).' },
        body: { description: '[http] JSON-сериализуемое тело запроса.' },
        headers: { type: 'object', description: '[http] Дополнительные заголовки.' }
      },
      required: ['id']
    }
  },
  {
    name: 'browser_navigate',
    description: 'Открыть URL во встроенном браузере GeminiGrok (вкладка Browser). Возвращает финальный URL после редиректов. Если пользователь не открыл вкладку Browser, инструмент вернёт ошибку — попроси открыть вкладку.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL или поисковый запрос. Без схемы — будет добавлено https://.' } },
      required: ['url']
    }
  },
  {
    name: 'browser_read_page',
    description: 'Получить текстовое содержимое текущей страницы во встроенном браузере (innerText, до 50 000 символов). Опционально передай CSS-селектор чтобы достать только нужный кусок.',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'Опциональный CSS-селектор, например "main article" или "#content".' } }
    }
  },
  {
    name: 'create_plan',
    description: 'Создать структурированный план многошаговой задачи. Используй когда задача требует 3+ шагов или явного согласования с пользователем. План отобразится во вкладке Plan; пользователь сможет выполнять шаги по одному.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Краткое название плана.' },
        steps: {
          type: 'array',
          description: 'Упорядоченный список шагов плана.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Конкретное действие.' },
              detail: { type: 'string', description: 'Опциональные подробности: какие файлы, какие команды, критерии готовности.' }
            },
            required: ['title']
          }
        }
      },
      required: ['title', 'steps']
    }
  }
]

export interface FileTools {
  execute: (name: string, args: Record<string, unknown>) => Promise<unknown>
  /** Pure execution — used by the IPC layer after user has confirmed the command. */
  runCommand: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  classifyCommand: typeof classifyCommand
}

function safeJoin(root: string, rel: string): string {
  const abs = resolve(root, rel)
  const r = relative(root, abs)
  if (r.startsWith('..') || r.includes('..' + sep) || r === '..') {
    throw new Error(`Запрещён выход за пределы проекта: ${rel}`)
  }
  return abs
}

function isRipgrepAvailable(): boolean {
  // Cheap probe — bare check if `rg` resolves. PATH lookup is sync via `where`/`which`
  try {
    if (process.platform === 'win32') {
      const paths = (process.env.PATH || '').split(';')
      for (const p of paths) {
        if (existsSync(join(p, 'rg.exe')) || existsSync(join(p, 'rg'))) return true
      }
    } else {
      const paths = (process.env.PATH || '').split(':')
      for (const p of paths) {
        if (existsSync(join(p, 'rg'))) return true
      }
    }
  } catch { /* ignore */ }
  return false
}

const RIPGREP_AVAILABLE = isRipgrepAvailable()

async function searchWithRipgrep(root: string, query: string, glob: string | undefined, ignoreCase: boolean, regex: boolean): Promise<string[]> {
  const args: string[] = ['--no-heading', '--line-number', '--color=never', '--max-count', '20', '--max-filesize', '512K']
  if (ignoreCase) args.push('-i')
  if (!regex) args.push('-F')
  if (glob) args.push('-g', glob)
  args.push(query)
  args.push('.')
  try {
    const { stdout } = await execFileAsync('rg', args, { cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
    return stdout.split('\n').filter(Boolean).slice(0, MAX_SEARCH_HITS)
      .map(line => line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + '…' : line)
  } catch (err) {
    const e = err as { code?: number; stdout?: string }
    // rg exits 1 when no matches — return empty
    if (e.code === 1) return []
    throw err
  }
}

async function searchFallback(root: string, query: string, glob: string | undefined, ignoreCase: boolean, regex: boolean): Promise<string[]> {
  void glob  // best-effort: glob filter ignored in fallback for simplicity
  const haystack = ignoreCase ? query.toLowerCase() : query
  const rx = regex ? new RegExp(query, ignoreCase ? 'i' : '') : null
  const results: string[] = []
  async function walk(dir: string) {
    if (results.length >= MAX_SEARCH_HITS) return
    let entries: string[]
    try { entries = await readdir(dir) } catch { return }
    for (const name of entries) {
      if (results.length >= MAX_SEARCH_HITS) return
      if (IGNORE_DIRS.has(name) || name.startsWith('.')) continue
      const abs = join(dir, name)
      let st
      try { st = await stat(abs) } catch { continue }
      if (st.isDirectory()) { await walk(abs); continue }
      if (st.size > 512 * 1024) continue
      let content: string
      try { content = await readFile(abs, 'utf8') } catch { continue }
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= MAX_SEARCH_HITS) return
        const line = lines[i]
        const cmp = ignoreCase ? line.toLowerCase() : line
        const hit = rx ? rx.test(line) : cmp.includes(haystack)
        if (hit) {
          const rel = relative(root, abs).replace(/\\/g, '/')
          const trimmed = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + '…' : line
          results.push(`${rel}:${i + 1}:${trimmed}`)
        }
      }
    }
  }
  await walk(root)
  return results
}

async function findFiles(root: string, pattern: string): Promise<string[]> {
  // Simple glob matcher: convert ** and * and ?. For real-world usage, this is sufficient for navigation hints.
  const re = globToRegExp(pattern)
  const results: string[] = []
  async function walk(dir: string) {
    if (results.length >= 200) return
    let entries: string[]
    try { entries = await readdir(dir) } catch { return }
    for (const name of entries) {
      if (results.length >= 200) return
      if (IGNORE_DIRS.has(name)) continue
      const abs = join(dir, name)
      let st
      try { st = await stat(abs) } catch { continue }
      const rel = relative(root, abs).replace(/\\/g, '/')
      if (st.isDirectory()) {
        if (re.test(rel)) results.push(rel + '/')
        await walk(abs)
      } else {
        if (re.test(rel)) results.push(rel)
      }
    }
  }
  await walk(root)
  return results
}

function globToRegExp(glob: string): RegExp {
  let pattern = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        pattern += '.*'
        i++
        if (glob[i + 1] === '/') i++
      } else {
        pattern += '[^/]*'
      }
    } else if (c === '?') {
      pattern += '[^/]'
    } else if ('.+()[]{}^$|\\'.includes(c)) {
      pattern += '\\' + c
    } else {
      pattern += c
    }
  }
  pattern += '$'
  return new RegExp(pattern)
}

export function createFileTools(root: string): FileTools {
  async function runCommand(command: string) {
    // Spawn the shell ourselves rather than using execSync: we want a hard
    // timeout, captured stderr, and no parent-process hijack.
    const isWindows = process.platform === 'win32'
    const shell = isWindows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
    const shellArg = isWindows ? '/d /s /c' : '-c'
    try {
      const { stdout, stderr } = await execFileAsync(shell, [...shellArg.split(' '), command], {
        cwd: root,
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true
      })
      return { stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode: 0 }
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; signal?: string; message?: string }
      const exitCode = typeof e.code === 'number' ? e.code : 1
      const stderr = String(e.stderr ?? e.message ?? '')
      return { stdout: String(e.stdout ?? ''), stderr, exitCode }
    }
  }

  return {
    classifyCommand,
    runCommand,

    async execute(name, args) {
      if (name === 'read_file') {
        const relPath = String(args.path)
        if (isForbiddenPath(relPath)) {
          throw new Error(`Доступ запрещён политикой безопасности: ${relPath} (secrets/credentials)`)
        }
        const abs = safeJoin(root, relPath)
        const st = await stat(abs)
        if (!st.isFile()) throw new Error(`Не файл: ${args.path}`)
        if (st.size > MAX_READ_BYTES) {
          throw new Error(`Файл слишком большой: ${st.size} байт (лимит ${MAX_READ_BYTES})`)
        }
        const raw = await readFile(abs, 'utf8')
        const scan = scanText(raw)
        if (scan.hits.length > 0) {
          // Add a header note so the AI knows redaction happened
          return `[secret-scanner: redacted ${scan.hits.join(', ')}]\n${scan.redacted}`
        }
        return raw
      }
      if (name === 'list_directory') {
        const abs = safeJoin(root, String(args.path))
        const entries = await readdir(abs)
        const out: string[] = []
        for (const e of entries) {
          const childRel = (String(args.path) === '.' ? e : `${args.path}/${e}`)
          if (isForbiddenPath(childRel)) continue  // hide secret stores from directory listings
          const st = await stat(join(abs, e))
          out.push(st.isDirectory() ? `${e}/` : e)
        }
        return out
      }
      if (name === 'write_file') {
        const relPath = String(args.path)
        if (isForbiddenPath(relPath)) {
          throw new Error(`Запись запрещена политикой безопасности: ${relPath}`)
        }
        const abs = safeJoin(root, relPath)
        await writeFile(abs, String(args.content), 'utf8')
        return { ok: true }
      }
      if (name === 'run_command') {
        // The IPC layer intercepts this tool call to gather user confirmation
        // BEFORE invoking execute. If we land here, it means the confirmation
        // flow was bypassed — fail loudly rather than silently executing.
        throw new Error('run_command нельзя вызывать напрямую — он проходит через подтверждение пользователя')
      }
      if (name === 'search_project') {
        const query = String(args.query ?? '')
        if (!query) throw new Error('search_project: пустой query')
        const glob = args.glob ? String(args.glob) : undefined
        const ignoreCase = args.ignoreCase !== false
        const regex = !!args.regex
        const rawHits = RIPGREP_AVAILABLE
          ? await searchWithRipgrep(root, query, glob, ignoreCase, regex)
          : await searchFallback(root, query, glob, ignoreCase, regex)
        // Drop hits from forbidden files and redact secret-looking matches
        const safeHits: string[] = []
        let redactionCount = 0
        for (const line of rawHits) {
          const idx = line.indexOf(':')
          const file = idx >= 0 ? line.slice(0, idx) : line
          if (isForbiddenPath(file)) continue
          const scan = scanText(line)
          if (scan.hits.length > 0) redactionCount++
          safeHits.push(scan.redacted)
        }
        return {
          matches: safeHits,
          truncated: safeHits.length >= MAX_SEARCH_HITS,
          backend: RIPGREP_AVAILABLE ? 'ripgrep' : 'fallback',
          ...(redactionCount > 0 ? { redactions: redactionCount } : {})
        }
      }
      if (name === 'find_files') {
        const pattern = String(args.pattern ?? '')
        if (!pattern) throw new Error('find_files: пустой pattern')
        const files = await findFiles(root, pattern)
        return { files, truncated: files.length >= 200 }
      }
      throw new Error(`Неизвестный tool: ${name}`)
    }
  }
}
