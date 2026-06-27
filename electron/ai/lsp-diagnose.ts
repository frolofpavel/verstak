/**
 * T1.1 — запуск языкового сервера для файла и сбор ERROR-диагностик.
 *
 * Каркас сессии (spawn/handshake/cleanup, graceful) — в lsp-session.ts. Здесь —
 * только ожидание publishDiagnostics для нашего файла. Полностью graceful: нет
 * сервера / таймаут / краш → null (петля откатывается к мягкому verify-хинту).
 */

import { withLspServer, sameFile } from './lsp-session'
import { extractErrorDiagnostics, type LspDiagItem } from './lang-servers'

export async function runLspDiagnostics(opts: {
  path: string        // абсолютный путь к файлу
  content: string     // полное содержимое файла (для didOpen)
  root: string        // корень проекта (cwd сервера + rootUri)
  timeoutMs?: number
}): Promise<LspDiagItem[] | null> {
  return withLspServer(opts, (client) => new Promise<LspDiagItem[] | null>(resolve => {
    // Резолвится при первом publishDiagnostics для нашего файла; если их нет —
    // не резолвится, и withLspServer вернёт null по таймауту.
    client.onNotification((method, params) => {
      if (method !== 'textDocument/publishDiagnostics') return
      const got = (params as { uri?: string } | null)?.uri
      if (process.env.LSP_DEBUG) {
        const n = Array.isArray((params as { diagnostics?: unknown[] } | null)?.diagnostics) ? (params as { diagnostics: unknown[] }).diagnostics.length : '?'
        console.error('[lsp] publishDiagnostics got=', got, 'expected=', opts.path, 'diags=', n)
      }
      // Строгий === uri ненадёжен на Windows (регистр диска / percent-кодирование) —
      // сравниваем по разрешённому пути (sameFile).
      if (typeof got === 'string' && sameFile(got, opts.path)) resolve(extractErrorDiagnostics(params))
    })
  }))
}
