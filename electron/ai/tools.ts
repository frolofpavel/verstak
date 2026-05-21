import { readFile, readdir, stat, writeFile } from 'fs/promises'
import { join, relative } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import type { ToolDefinition } from './types'
import { classifyCommand } from './command-policy'
import { isForbiddenPath, scanText } from './secret-scanner'
import { getProjectMap, invalidateProjectMap, projectMapToText } from './project-map'
import { safeRealJoin } from './path-policy'

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
    description: 'Записать ПОЛНОЕ содержимое файла. Используй ТОЛЬКО для СОЗДАНИЯ новых файлов или ПОЛНОЙ замены маленьких файлов (<200 строк). Для ПРАВКИ существующих больших файлов вместо этого вызывай apply_patch — это дешевле и безопаснее.',
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
    description: `Точечная правка файла через SEARCH/REPLACE блоки. Намного дешевле и безопаснее чем write_file для существующих файлов.

Формат diff:
<<<<<<< SEARCH
точный кусок текущего содержимого (включая отступы)
=======
новый текст
>>>>>>> REPLACE

Несколько блоков в одном файле — разделяй пустой строкой. Каждый SEARCH должен УНИКАЛЬНО совпадать с содержимым файла; если фрагмент встречается несколько раз — добавь больше контекста. Файл должен существовать (для создания используй write_file).

Возвращает количество применённых блоков. Требует подтверждения пользователя как обычный write — diff отображается в том же модальном окне.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Относительный путь к существующему файлу.' },
        diff: { type: 'string', description: 'Один или несколько SEARCH/REPLACE блоков.' }
      },
      required: ['path', 'diff']
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
    name: 'get_project_map',
    description: 'Получить структуру проекта одной командой: дерево директорий + top-level символы (functions, classes, components, types, exports) для каждого *.ts/*.tsx/*.js/*.jsx файла + количество строк. Используй ВПЕРВЫЕ при незнакомом проекте — экономит десятки read_file/list_directory вызовов. Карта кэшируется; для обновления вызови refresh_project_map.',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', description: '"text" (default, компактный markdown) или "json" (структура).' }
      }
    }
  },
  {
    name: 'refresh_project_map',
    description: 'Принудительно пересканировать проект и обновить project map. Вызывай после крупных изменений структуры (новые файлы, переименования). Возвращает свежую карту.',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', description: '"text" или "json".' }
      }
    }
  },
  {
    name: 'propose_edits',
    description: 'Атомарно предложить пакет изменений нескольких файлов сразу. Пользователь увидит все диффы в одной модалке с вкладками и сможет принять все одной кнопкой. Используй для рефакторингов, переименований, синхронных правок в нескольких местах — вместо последовательной серии write_file. Каждый элемент edits — это {path, content, reason}: reason кратко объясняет зачем эта правка.',
    parameters: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          description: 'Список правок (1..20).',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Относительный путь от корня проекта.' },
              content: { type: 'string', description: 'Полное новое содержимое файла.' },
              reason: { type: 'string', description: 'Краткое обоснование правки (1 строка).' }
            },
            required: ['path', 'content']
          }
        },
        summary: { type: 'string', description: 'Общий заголовок пакета правок, 1 строка.' }
      },
      required: ['edits']
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
    name: 'browser_screenshot',
    description: 'Сделать скриншот текущей страницы во встроенном браузере. Скриншот будет автоматически прикреплён к следующему сообщению как изображение — провайдеры с vision (Gemini 3.5, GPT-4o) увидят его и смогут проанализировать визуально. Используй для отладки UI / визуальных регрессий.',
    parameters: { type: 'object', properties: {} }
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

/**
 * Apply one or more SEARCH/REPLACE blocks to a string and return the result.
 * Each SEARCH must match EXACTLY ONCE in the current state of the buffer
 * (re-checked after each replacement so earlier rewrites don't break later
 * matches). Throws with a precise error if a block doesn't match or is
 * ambiguous — important so the AI sees feedback and can correct.
 */
export function applySearchReplaceBlocks(input: string, diff: string): string {
  const blockRe = /<{7,}\s*SEARCH\s*\n([\s\S]*?)\n={7,}\s*\n([\s\S]*?)\n>{7,}\s*REPLACE\b/g
  let result = input
  let applied = 0
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(diff)) !== null) {
    const search = m[1]
    const replace = m[2]
    if (!search) {
      throw new Error(`apply_patch: пустой SEARCH блок в позиции ${applied + 1}`)
    }
    const first = result.indexOf(search)
    if (first === -1) {
      // Provide a useful diagnostic: a few lines that might be close
      const sample = search.split('\n')[0].slice(0, 80)
      throw new Error(`apply_patch: SEARCH блок #${applied + 1} не найден в файле. Первая строка искомого: "${sample}". Прочитай файл заново и составь патч по актуальному содержимому.`)
    }
    const next = result.indexOf(search, first + 1)
    if (next !== -1) {
      throw new Error(`apply_patch: SEARCH блок #${applied + 1} встречается в файле несколько раз (позиции ${first} и ${next}). Добавь контекста до/после чтобы фрагмент стал уникальным.`)
    }
    result = result.slice(0, first) + replace + result.slice(first + search.length)
    applied++
  }
  if (applied === 0) {
    throw new Error('apply_patch: в diff не найдено ни одного валидного SEARCH/REPLACE блока. Формат: <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE')
  }
  return result
}

// safeJoin / safeRealJoin moved to ./path-policy.ts — see import above.

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

export function createFileTools(root: string, signal?: AbortSignal): FileTools {
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
        windowsHide: true,
        // Propagate the outer agent's abort so Stop / Shift+Esc actually
        // kills the child process instead of waiting out the 60s timeout.
        signal
      })
      return { stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode: 0 }
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; signal?: string; message?: string; name?: string }
      // Abort signal surfaces as AbortError — report cleanly
      if (e.name === 'AbortError') {
        return { stdout: String(e.stdout ?? ''), stderr: 'Команда прервана пользователем', exitCode: 130 }
      }
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
        const abs = await safeRealJoin(root, relPath)
        let st
        try {
          st = await stat(abs)
        } catch (err) {
          const e = err as NodeJS.ErrnoException
          if (e.code === 'ENOENT') {
            // Clearer guidance — model otherwise tends to retry the same path 3×
            throw new Error(`Файл "${relPath}" не существует в активном проекте (${root}). Вызови list_directory или get_project_map чтобы увидеть реальную структуру.`)
          }
          throw err
        }
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
        const abs = await safeRealJoin(root, String(args.path))
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
        const abs = await safeRealJoin(root, relPath)
        await writeFile(abs, String(args.content), 'utf8')
        // Invalidate project map cache so the next get_project_map sees this file
        invalidateProjectMap(root)
        return { ok: true }
      }
      if (name === 'apply_patch') {
        // Note: this branch should normally NOT be reached — ipc/ai.ts
        // intercepts apply_patch to wire it through the user-confirmation
        // flow, just like write_file. We keep an implementation here for
        // direct/test use.
        const relPath = String(args.path)
        if (isForbiddenPath(relPath)) {
          throw new Error(`Запись запрещена политикой безопасности: ${relPath}`)
        }
        const abs = await safeRealJoin(root, relPath)
        const before = await readFile(abs, 'utf8')
        const after = applySearchReplaceBlocks(before, String(args.diff))
        await writeFile(abs, after, 'utf8')
        invalidateProjectMap(root)
        return { ok: true, before, after }
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
      if (name === 'get_project_map') {
        const map = await getProjectMap(root, false)
        const fmt = String(args.format ?? 'text')
        return fmt === 'json' ? map : projectMapToText(map)
      }
      if (name === 'refresh_project_map') {
        invalidateProjectMap(root)
        const map = await getProjectMap(root, true)
        const fmt = String(args.format ?? 'text')
        return fmt === 'json' ? map : projectMapToText(map)
      }
      throw new Error(`Неизвестный tool: ${name}`)
    }
  }
}
