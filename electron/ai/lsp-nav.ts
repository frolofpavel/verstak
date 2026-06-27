/**
 * Tier-2 #1 — LSP-навигация как тулзы: goToDefinition / findReferences. Семантика
 * (через язык-сервер) вместо grep'а: «где НА САМОМ ДЕЛЕ определён символ / где он
 * используется» — без ложных срабатываний на комментариях/строках/тёзках.
 *
 * Ядро (parseLocations + findSymbolPositions) чистое и тестируемое; реальный запрос
 * к серверу — runLspNavigation поверх общего withLspServer (graceful).
 */

import { fileURLToPath } from 'url'
import { withLspServer, sameFile } from './lsp-session'
import type { LspClient } from './lsp/client'

export interface LspLocation {
  file: string        // абсолютный путь (из uri)
  line: number        // 0-based
  character: number   // 0-based
}

function uriToPath(uri: string): string {
  try { return fileURLToPath(uri) } catch { return uri }
}

/** Нормализовать ответ LSP (Location | Location[] | LocationLink[] | null) в список.
 *  Для LocationLink приоритет targetSelectionRange (сам идентификатор) над targetRange
 *  (весь блок вместе с doc-комментарием/декоратором) — иначе указывали бы на коммент. */
export function parseLocations(result: unknown): LspLocation[] {
  if (!result) return []
  const arr = Array.isArray(result) ? result : [result]
  const out: LspLocation[] = []
  for (const loc of arr) {
    if (!loc || typeof loc !== 'object') continue
    const r = loc as Record<string, unknown>
    const uri = typeof r.uri === 'string' ? r.uri : typeof r.targetUri === 'string' ? r.targetUri : null
    const range = (r.targetSelectionRange ?? r.range ?? r.targetRange) as { start?: { line?: unknown; character?: unknown } } | undefined
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

/** ВСЕ словограничные вхождения символа (0-based line/character), до limit штук.
 *  Перебор кандидатов нужен, т.к. первое вхождение может быть в комментарии/строке
 *  (сервер вернёт там пусто) — а реальный код-токен ниже. */
export function findSymbolPositions(content: string, symbol: string, limit = 8): Array<{ line: number; character: number }> {
  if (!symbol) return []
  const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(symbol)}(?![A-Za-z0-9_])`, 'g')
  const lines = content.split('\n')
  const out: Array<{ line: number; character: number }> = []
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(lines[i])) !== null) {
      out.push({ line: i, character: m.index })
      if (out.length >= limit) break
      if (re.lastIndex === m.index) re.lastIndex++ // защита от zero-width
    }
  }
  return out
}

/** Первое вхождение (back-compat). */
export function findSymbolPosition(content: string, symbol: string): { line: number; character: number } | null {
  return findSymbolPositions(content, symbol, 1)[0] ?? null
}

/** Дождаться готовности анализа (первый publishDiagnostics для файла) или фолбэка. */
function waitForReadiness(client: LspClient, path: string): Promise<void> {
  return new Promise(resolve => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    client.onNotification((method, params) => {
      if (method === 'textDocument/publishDiagnostics'
        && sameFile(String((params as { uri?: string } | null)?.uri ?? ''), path)) finish()
    })
    setTimeout(finish, 2500)
  })
}

/**
 * Запросить у языкового сервера определение/использования символа. Перебираем
 * вхождения символа в файле, пока сервер не вернёт непустой результат (пропускает
 * вхождения в комментариях/строках). Graceful: нет сервера/таймаут → null; нет в
 * файле или все вхождения пустые → [].
 */
export async function runLspNavigation(opts: {
  path: string        // абсолютный путь
  content: string
  root: string
  symbol: string
  kind: 'definition' | 'references'
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<LspLocation[] | null> {
  const positions = findSymbolPositions(opts.content, opts.symbol)
  if (positions.length === 0) return []
  return withLspServer(opts, async (client, uri) => {
    await waitForReadiness(client, opts.path)
    const method = opts.kind === 'definition' ? 'textDocument/definition' : 'textDocument/references'
    for (const pos of positions) {
      if (opts.signal?.aborted) break
      const params: Record<string, unknown> = { textDocument: { uri }, position: pos }
      if (opts.kind === 'references') params.context = { includeDeclaration: true }
      const result = await client.request(method, params)
      const locs = parseLocations(result)
      if (process.env.LSP_DEBUG) {
        console.error('[lsp-nav]', opts.kind, opts.symbol, 'pos=', JSON.stringify(pos), 'locs=', locs.length)
      }
      if (locs.length > 0) return locs // первое вхождение в коде (не в комментарии)
    }
    return []
  })
}
