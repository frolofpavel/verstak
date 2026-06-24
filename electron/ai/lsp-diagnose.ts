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
import { pathToFileURL } from 'url'
import { LspClient, type LspTransport } from './lsp/client'
import { LspDecoder } from './lsp/framing'
import { resolveLangServer, extractErrorDiagnostics, type LspDiagItem } from './lang-servers'

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
    child = spawn(cfg.command, cfg.args, { cwd: opts.root, stdio: ['pipe', 'pipe', 'ignore'] })

    const decoder = new LspDecoder()
    const transport: LspTransport = {
      send: (data) => { try { child?.stdin?.write(data) } catch { /* сервер мог упасть */ } },
      onMessage: (cb) => {
        child?.stdout?.on('data', (chunk: Buffer) => {
          for (const msg of decoder.push(chunk)) cb(msg)
        })
      },
      close: () => { try { child?.kill() } catch { /* уже мёртв */ } },
    }
    client = new LspClient(transport)

    const uri = pathToFileURL(opts.path).toString()
    let settle: (v: LspDiagItem[] | null) => void = () => {}
    const diagPromise = new Promise<LspDiagItem[] | null>(res => { settle = res })

    client.onNotification((method, params) => {
      if (method !== 'textDocument/publishDiagnostics') return
      if ((params as { uri?: string } | null)?.uri === uri) settle(extractErrorDiagnostics(params))
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
    try { child?.kill() } catch { /* noop */ }
  }
}
