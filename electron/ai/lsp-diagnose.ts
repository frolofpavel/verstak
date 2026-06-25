/**
 * T1.1 — реальный запуск языкового сервера для одного файла и сбор ERROR-диагностик.
 *
 * ПОЛНОСТЬЮ graceful: бинарь не найден (ENOENT) / таймаут / краш сервера / битый
 * ответ → возвращаем null. Петля тогда откатывается к мягкому verify-хинту, как
 * для языков без сервера. Эта функция НИКОГДА не кидает и не вешает цикл.
 *
 * Сидит на уже протестированных примитивах: LspClient (JSON-RPC корреляция) +
 * LspDecoder (кадрирование stdio). Здесь — только spawn + LSP-хендшейк.
 */

import { spawn, type ChildProcess } from 'child_process'
import { pathToFileURL, fileURLToPath } from 'url'
import { LspClient, type LspTransport } from './lsp/client'
import { LspDecoder } from './lsp/framing'
import { resolveLangServer, extractErrorDiagnostics, type LspDiagItem } from './lang-servers'
import { treeKill } from './child-kill'

const DEFAULT_TIMEOUT_MS = 8_000

export async function runLspDiagnostics(opts: {
  path: string        // абсолютный путь к файлу
  content: string     // полное содержимое файла (для didOpen)
  root: string        // корень проекта (cwd сервера + rootUri)
  timeoutMs?: number
}): Promise<LspDiagItem[] | null> {
  const cfg = resolveLangServer(opts.path)
  if (!cfg) return null

  let child: ChildProcess | null = null
  let client: LspClient | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  try {
    child = spawn(cfg.command, cfg.args, {
      cwd: opts.root,
      stdio: ['pipe', 'pipe', 'ignore'],
      // На Windows pyright/gopls после `npm i -g` — .cmd-обёртки; spawn без shell их
      // не запускает (ENOENT) → вся LSP-петля молча мертва на основной платформе.
      // (как и остальные CLI-spawn проекта: claude-cli/codex-cli/…)
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    // EPIPE/ECONNRESET на пайпах прилетает АСИНХРОННО как 'error' на потоке; без
    // слушателя Node роняет ВЕСЬ main-процесс (нет uncaughtException-хука). Глушим —
    // функция обязана быть graceful и НИКОГДА не кидать (см. контракт в шапке).
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
      // treeKill, НЕ child.kill: на Windows shell:true спавнит cmd.exe → реальный
      // сервер (node.exe pyright) ВНУК; child.kill убьёт только cmd.exe, внук осиротеет
      // (см. child-kill.ts). Конвенция проекта для всех shell:true-спавнов.
      close: () => { if (child) treeKill(child) },
    }
    client = new LspClient(transport)

    const uri = pathToFileURL(opts.path).toString()
    let settle: (v: LspDiagItem[] | null) => void = () => {}
    const diagPromise = new Promise<LspDiagItem[] | null>(res => { settle = res })

    client.onNotification((method, params) => {
      if (method !== 'textDocument/publishDiagnostics') return
      const got = (params as { uri?: string } | null)?.uri
      if (process.env.LSP_DEBUG) {
        const n = Array.isArray((params as { diagnostics?: unknown[] } | null)?.diagnostics) ? (params as { diagnostics: unknown[] }).diagnostics.length : '?'
        console.error('[lsp] publishDiagnostics got=', got, 'expected=', uri, 'diags=', n)
      }
      // Строгий ===  uri ненадёжен на Windows (pyright нормализует регистр диска и
      // percent-кодирует ':') — сравниваем по разрешённому ПУТИ (регистронезависимо).
      if (typeof got === 'string' && sameFile(got, opts.path)) settle(extractErrorDiagnostics(params))
    })

    // ENOENT (бинаря нет) и ранний выход сервера → null, не ждём таймаут.
    const failPromise = new Promise<null>(res => {
      child?.on('error', () => res(null))
      child?.on('exit', () => res(null))
    })

    const timeoutPromise = new Promise<null>(res => {
      timer = setTimeout(() => res(null), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    })

    // Хендшейк отдельным промисом, чтобы зависший initialize не блокировал race.
    const handshake = (async (): Promise<LspDiagItem[] | null> => {
      await client!.request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(opts.root).toString(),
        capabilities: { textDocument: { publishDiagnostics: { relatedInformation: false } } },
      })
      client!.notify('initialized', {})
      client!.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: cfg.languageId, version: 1, text: opts.content },
      })
      return diagPromise
    })().catch(() => null)

    return await Promise.race([handshake, failPromise, timeoutPromise])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
    try { client?.dispose() } catch { /* noop */ }
    // treeKill и здесь (client мог быть null — spawn упал до его создания → дерево
    // процессов не закрыто через transport.close).
    if (child) { try { treeKill(child) } catch { /* noop */ } }
  }
}

/** Один ли это файл: сравниваем uri↔путь по разрешённому пути (на Windows
 *  регистронезависимо и независимо от percent-кодирования диска). */
function sameFile(uri: string, filePath: string): boolean {
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
