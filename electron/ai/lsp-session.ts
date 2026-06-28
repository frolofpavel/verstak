/**
 * Общий каркас LSP-сессии: поднять языковой сервер для одного файла (spawn →
 * initialize → didOpen), выполнить запрос через `run(client, uri)`, прибрать
 * процесс. ПОЛНОСТЬЮ graceful: бинаря нет / таймаут / краш / нет сервера для языка
 * → null. НИКОГДА не кидает и не вешает цикл.
 *
 * Переиспользуется диагностикой (lsp-diagnose) и навигацией (lsp-nav). Сидит на
 * протестированных примитивах LspClient + LspDecoder. Тут — только spawn/handshake.
 */

import { spawn, type ChildProcess } from 'child_process'
import { pathToFileURL, fileURLToPath } from 'url'
import { LspClient, type LspTransport } from './lsp/client'
import { LspDecoder } from './lsp/framing'
import { resolveLangServer } from './lang-servers'
import { treeKill } from './child-kill'

const DEFAULT_TIMEOUT_MS = 8_000

// Семафор: LSP-навигация — единственные parallel-read тулзы, спавнящие тяжёлый внешний
// процесс (pyright/gopls/rust-analyzer); N вызовов за ход стартуют конкурентно → пик RAM.
// Ограничиваем число одновременных LSP-сессий (диагностика + навигация).
const MAX_CONCURRENT_LSP = 3
let activeLsp = 0
const lspQueue: Array<() => void> = []
function acquireLsp(): Promise<void> {
  if (activeLsp < MAX_CONCURRENT_LSP) { activeLsp++; return Promise.resolve() }
  return new Promise(resolve => lspQueue.push(resolve))
}
function releaseLsp(): void {
  const next = lspQueue.shift()
  if (next) next()        // слот переходит ждущему (activeLsp не уменьшаем)
  else activeLsp--
}

export interface LspSessionOpts {
  path: string        // абсолютный путь к файлу
  content: string     // полное содержимое (для didOpen)
  root: string        // корень проекта (cwd сервера + rootUri)
  timeoutMs?: number
  signal?: AbortSignal // Stop/отмена — прерывает ожидание (процесс приберётся в finally)
  navigation?: boolean // true → резолвить TS/JS-сервер (для goToDefinition/findReferences)
}

export async function withLspServer<T>(
  opts: LspSessionOpts,
  run: (client: LspClient, uri: string) => Promise<T | null>,
): Promise<T | null> {
  const cfg = resolveLangServer(opts.path, { navigation: opts.navigation })
  if (!cfg) return null
  if (opts.signal?.aborted) return null
  await acquireLsp()

  let child: ChildProcess | null = null
  let client: LspClient | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  try {
    child = spawn(cfg.command, cfg.args, {
      cwd: opts.root,
      stdio: ['pipe', 'pipe', 'ignore'],
      // На Windows pyright/gopls часто .cmd-обёртки; без shell — ENOENT (как остальные
      // CLI-spawn проекта). windowsHide — чтобы не мигало окно.
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    // EPIPE/ECONNRESET прилетает АСИНХРОННО как 'error' на потоке; без слушателя Node
    // роняет ВЕСЬ main-процесс. Глушим — контракт graceful.
    child.stdin?.on('error', () => {})
    child.stdout?.on('error', () => {})

    const decoder = new LspDecoder()
    const transport: LspTransport = {
      send: (data) => { try { child?.stdin?.write(data) } catch { /* сервер мог упасть */ } },
      onMessage: (cb) => {
        child?.stdout?.on('data', (chunk: Buffer) => {
          for (const msg of decoder.push(chunk)) cb(msg)
        })
      },
      // treeKill, НЕ child.kill: shell:true на Windows спавнит cmd.exe → реальный
      // сервер ВНУК; child.kill убьёт только cmd.exe (см. child-kill.ts).
      close: () => { if (child) treeKill(child) },
    }
    client = new LspClient(transport)
    const uri = pathToFileURL(opts.path).toString()

    // ENOENT (бинаря нет) и ранний выход сервера → null, не ждём таймаут.
    const failPromise = new Promise<null>(res => {
      child?.on('error', () => res(null))
      child?.on('exit', () => res(null))
    })
    const timeoutPromise = new Promise<null>(res => {
      timer = setTimeout(() => res(null), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    })
    // Stop/отмена: прерываем ожидание; процесс приберётся в finally (treeKill).
    const abortPromise = new Promise<null>(res => {
      if (opts.signal?.aborted) return res(null)
      opts.signal?.addEventListener('abort', () => res(null), { once: true })
    })

    // Хендшейк отдельным промисом, чтобы зависший initialize не блокировал race.
    const session = (async (): Promise<T | null> => {
      await client!.request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(opts.root).toString(),
        capabilities: {
          textDocument: {
            publishDiagnostics: { relatedInformation: false },
            definition: { linkSupport: true },
            references: {},
          },
        },
      })
      client!.notify('initialized', {})
      client!.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: cfg.languageId, version: 1, text: opts.content },
      })
      return run(client!, uri)
    })().catch(() => null)

    return await Promise.race([session, failPromise, timeoutPromise, abortPromise])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
    try { client?.dispose() } catch { /* noop */ }
    // treeKill и здесь (client мог быть null — spawn упал до создания).
    if (child) { try { treeKill(child) } catch { /* noop */ } }
    releaseLsp()
  }
}

/** Один ли это файл: uri↔путь по разрешённому пути (win32 — регистронезависимо,
 *  независимо от percent-кодирования диска: pyright нормализует иначе). */
export function sameFile(uri: string, filePath: string): boolean {
  try {
    const a = fileURLToPath(uri)
    if (process.platform === 'win32') {
      return a.toLowerCase().replace(/\//g, '\\') === filePath.toLowerCase().replace(/\//g, '\\')
    }
    return a === filePath
  } catch {
    return false
  }
}
