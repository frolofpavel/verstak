/**
 * T1.1 — мультиязычный LSP в петле. Реестр языковых серверов (расширение → команда)
 * + извлечение ERROR-диагностик из publishDiagnostics + хинт для следующего хода.
 *
 * Из конкурентного исследования: наша агентная петля сильна на TS (авто-tsc), но
 * на Python/Go/Rust «писала вслепую» — модель не видела реальных ошибок. Языковой
 * сервер (pyright/gopls/rust-analyzer) даёт те же диагностики, что tsc для TS.
 * Чистое ядро (без spawn) — реальный запуск в lsp-diagnose.ts, graceful.
 */

export interface LangServerConfig {
  /** Исполняемый файл языкового сервера (ищется в PATH). */
  command: string
  args: string[]
  /** LSP languageId для textDocument/didOpen. */
  languageId: string
}

export interface LspDiagItem {
  line: number       // 0-based (как в LSP)
  character: number  // 0-based
  severity: number
  message: string
  source?: string
}

// .ts/.tsx НАМЕРЕННО отсутствуют в реестре ДИАГНОСТИК — они покрыты tsc-петлёй
// (diagnostic-loop.ts), дублировать языковым сервером не нужно.
const REGISTRY: Array<{ ext: RegExp; cfg: LangServerConfig }> = [
  { ext: /\.pyi?$/i, cfg: { command: 'pyright-langserver', args: ['--stdio'], languageId: 'python' } },
  { ext: /\.go$/i, cfg: { command: 'gopls', args: [], languageId: 'go' } },
  { ext: /\.rs$/i, cfg: { command: 'rust-analyzer', args: [], languageId: 'rust' } },
]

// typescript-language-server подключаем ТОЛЬКО для НАВИГАЦИИ (goToDefinition/
// findReferences по TS/JS). Для диагностик TS владеет tsc-петля — поэтому этот сервер
// НЕ в REGISTRY и резолвится лишь при navigation=true (иначе дублировал бы tsc).
const TS_NAV_EXT = /\.[mc]?[jt]sx?$/i

/** LSP languageId для TS/JS по расширению (важно для корректного парсинга JSX). */
function tsLanguageId(path: string): string {
  if (/\.tsx$/i.test(path)) return 'typescriptreact'
  if (/\.jsx$/i.test(path)) return 'javascriptreact'
  if (/\.[mc]?js$/i.test(path)) return 'javascript'
  return 'typescript'
}

/**
 * Конфиг языкового сервера для файла или null.
 * @param opts.navigation — true для навигации (включает typescript-language-server
 *   на TS/JS). По умолчанию (диагностики) TS/JS → null (их ведёт tsc-петля).
 */
export function resolveLangServer(path: string, opts?: { navigation?: boolean }): LangServerConfig | null {
  const p = (path ?? '').trim()
  for (const r of REGISTRY) if (r.ext.test(p)) return r.cfg
  if (opts?.navigation && TS_NAV_EXT.test(p)) {
    return { command: 'typescript-language-server', args: ['--stdio'], languageId: tsLanguageId(p) }
  }
  return null
}

/** Можно ли диагностировать файл через LSP (есть сервер в реестре диагностик). */
export function isLspDiagnosableFile(path: string): boolean {
  return resolveLangServer(path) !== null
}

/** Можно ли НАВИГировать по файлу (goToDefinition/findReferences) — включает TS/JS. */
export function isLspNavigableFile(path: string): boolean {
  return resolveLangServer(path, { navigation: true }) !== null
}

/**
 * ERROR-диагностики (severity 1) из params уведомления textDocument/publishDiagnostics.
 * Warnings/info/hint отбрасываем — в петле fix-until-green они только шумят.
 * Отсутствие severity по LSP трактуется как Error.
 */
export function extractErrorDiagnostics(params: unknown): LspDiagItem[] {
  if (!params || typeof params !== 'object') return []
  const arr = (params as { diagnostics?: unknown }).diagnostics
  if (!Array.isArray(arr)) return []
  const out: LspDiagItem[] = []
  for (const d of arr) {
    if (!d || typeof d !== 'object') continue
    const rec = d as Record<string, unknown>
    const sev = typeof rec.severity === 'number' ? rec.severity : 1
    if (sev !== 1) continue
    const start = ((rec.range as Record<string, unknown> | undefined)?.start ?? {}) as Record<string, unknown>
    out.push({
      line: typeof start.line === 'number' ? start.line : 0,
      character: typeof start.character === 'number' ? start.character : 0,
      severity: sev,
      message: typeof rec.message === 'string' ? rec.message : '',
      source: typeof rec.source === 'string' ? rec.source : undefined,
    })
  }
  return out
}

/**
 * Хинт для следующего хода (зеркалит formatDiagnosticHint TS-петли). null если
 * ошибок нет. Строка/колонка переводятся в 1-based для человекочитаемости.
 */
export function formatLspDiagnosticHint(path: string, diags: LspDiagItem[]): string | null {
  if (!diags.length) return null
  const lines = diags
    .map(d => ` ${path}:${d.line + 1}:${d.character + 1} — ${d.source ? d.source + ': ' : ''}${d.message}`)
    .join('\n')
  return (
    '[system: авто-проверка языковым сервером после твоих правок нашла ошибки. '
    + 'ОБЯЗАТЕЛЬНО почини их перед тем как сказать «готово»:\n\n'
    + lines
    + '\n\nЕсли какая-то ошибка не связана с твоими правками — явно это отметь.]'
  )
}
