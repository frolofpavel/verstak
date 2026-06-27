/**
 * Tier-2 #1 — LSP-навигация как тулзы: goToDefinition / findReferences. Семантика
 * (через язык-сервер) вместо grep'а: «где НА САМОМ ДЕЛЕ определён символ / где он
 * используется» — без ложных срабатываний на комментариях/строках/тёзках.
 *
 * Ядро (parseLocations + findSymbolPosition) чистое и тестируемое; реальный запрос
 * к серверу — runLspNavigation поверх общего withLspServer (graceful).
 */

import { fileURLToPath } from 'url'
import { withLspServer, sameFile } from './lsp-session'

export interface LspLocation {
  file: string        // абсолютный путь (из uri)
  line: number        // 0-based
  character: number   // 0-based
}

function uriToPath(uri: string): string {
  try { return fileURLToPath(uri) } catch { return uri }
}

/** Нормализовать ответ LSP (Location | Location[] | LocationLink[] | null) в список. */
export function parseLocations(result: unknown): LspLocation[] {
  if (!result) return []
  const arr = Array.isArray(result) ? result : [result]
  const out: LspLocation[] = []
  for (const loc of arr) {
    if (!loc || typeof loc !== 'object') continue
    const r = loc as Record<string, unknown>
    const uri = typeof r.uri === 'string' ? r.uri : typeof r.targetUri === 'string' ? r.targetUri : null
    const range = (r.range ?? r.targetRange) as { start?: { line?: unknown; character?: unknown } } | undefined
    if (!uri || !range || typeof range.start !== 'object' || range.start === null) continue
    const start = range.start
    out.push({
      file: uriToPath(uri),
      line: typeof start.line === 'number' ? start.line : 0,
      character: typeof start.character === 'number' ? start.character : 0,
    })
  }
  return out
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Позиция (0-based line/character) первого словограничного вхождения символа. */
export function findSymbolPosition(content: string, symbol: string): { line: number; character: number } | null {
  if (!symbol) return null
  const re = new RegExp(`(^|[^A-Za-z0-9_])(${escapeRegex(symbol)})([^A-Za-z0-9_]|$)`)
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i])
    if (m) return { line: i, character: m.index + m[1].length }
  }
  return null
}

/**
 * Запросить у языкового сервера определение/использования символа. Находим позицию
 * символа в файле → didOpen → request. Graceful: нет сервера/таймаут → null; символа
 * нет в файле → [].
 */
export async function runLspNavigation(opts: {
  path: string        // абсолютный путь
  content: string
  root: string
  symbol: string
  kind: 'definition' | 'references'
  timeoutMs?: number
}): Promise<LspLocation[] | null> {
  const pos = findSymbolPosition(opts.content, opts.symbol)
  if (!pos) return []
  return withLspServer(opts, async (client, uri) => {
    // ГОТОВНОСТЬ: definition/references вернут пусто, если сервер ещё не проанализировал
    // файл. Сервер шлёт publishDiagnostics (пусть и пустой) когда анализ завершён —
    // ждём его как сигнал готовности, с коротким фолбэком (не все серверы шлют).
    await new Promise<void>(resolve => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      client.onNotification((method, params) => {
        if (method === 'textDocument/publishDiagnostics'
          && sameFile(String((params as { uri?: string } | null)?.uri ?? ''), opts.path)) finish()
      })
      setTimeout(finish, 2500)
    })
    const method = opts.kind === 'definition' ? 'textDocument/definition' : 'textDocument/references'
    const params: Record<string, unknown> = { textDocument: { uri }, position: pos }
    if (opts.kind === 'references') params.context = { includeDeclaration: true }
    const result = await client.request(method, params)
    if (process.env.LSP_DEBUG) {
      console.error('[lsp-nav]', opts.kind, opts.symbol, 'pos=', JSON.stringify(pos), 'result=', JSON.stringify(result)?.slice(0, 400))
    }
    return parseLocations(result)
  })
}
