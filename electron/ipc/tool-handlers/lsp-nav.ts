// Tier-2 #1 — LSP-навигация как тулзы: find_definition / find_references. Семантика
// через язык-сервер (точнее grep'а). Read-only. Движок — electron/ai/lsp-nav.ts.
import { readFileSync, statSync } from 'fs'
import { relative } from 'path'
import type { ToolHandler, ToolContext } from './shared'
import { emitActivity } from './shared'
import { runLspNavigation } from '../../ai/lsp-nav'
import { isLspNavigableFile } from '../../ai/lang-servers'
import { safeRealJoin } from '../../ai/path-policy'
import type { ToolCall, ToolResult } from '../../ai/types'

const MAX_LSP_FILE_BYTES = 2_000_000 // как MAX_READ_BYTES у read_file

function relPath(root: string, file: string): string {
  const r = relative(root, file)
  return r && !r.startsWith('..') ? r.replace(/\\/g, '/') : file
}

async function navigate(kind: 'definition' | 'references', call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const rel = String(call.args.path ?? '').trim()
  const symbol = String(call.args.symbol ?? '').trim()
  if (!rel || !symbol) {
    return { id: call.id, name: call.name, result: '', error: `${call.name}: нужны path и symbol` }
  }
  // safeRealJoin (как read_file) — anti-traversal/symlink-escape: иначе find_definition
  // ({path:'../../../etc/passwd.py'}) прочитал бы файл вне проекта мимо path-policy.
  let abs: string
  try {
    abs = await safeRealJoin(ctx.projectPath, rel)
  } catch (e) {
    return { id: call.id, name: call.name, result: '', error: e instanceof Error ? e.message : `путь вне проекта: ${rel}` }
  }
  if (!isLspNavigableFile(abs)) {
    return { id: call.id, name: call.name, result: `LSP-навигация поддерживается для TS/JS, Python, Go, Rust; для ${rel} языковой сервер не настроен — используй search_project.` }
  }
  let content: string
  try {
    // Лимит размера как у read_file (didOpen 50-MB файла = пик памяти + блокировка).
    if (statSync(abs).size > MAX_LSP_FILE_BYTES) {
      return { id: call.id, name: call.name, result: '', error: `${rel} слишком большой для LSP-навигации (> 2 MB) — используй search_project.` }
    }
    content = readFileSync(abs, 'utf8')
  } catch (e) {
    return { id: call.id, name: call.name, result: '', error: `не прочитать ${rel}: ${e instanceof Error ? e.message : String(e)}` }
  }
  const word = kind === 'definition' ? 'Определение' : 'Использования'
  const locs = await runLspNavigation({ path: abs, content, root: ctx.projectPath, symbol, kind, signal: ctx.signal })
  if (locs === null) {
    emitActivity(ctx, call, 'error', call.name, `${symbol}: сервер недоступен`)
    return { id: call.id, name: call.name, result: `Языковой сервер недоступен/не ответил для «${symbol}». Установлен ли pyright/gopls/rust-analyzer? Фолбэк — search_project.` }
  }
  if (locs.length === 0) {
    emitActivity(ctx, call, 'ok', call.name, `${symbol}: не найдено`)
    return { id: call.id, name: call.name, result: `${word} «${symbol}»: сервер не вернул локаций (символа может не быть в ${rel} как кода, либо он внешний) — попробуй search_project.` }
  }
  const lines = locs.map(l => ` ${relPath(ctx.projectPath, l.file)}:${l.line + 1}:${l.character + 1}`).join('\n')
  emitActivity(ctx, call, 'ok', call.name, `${symbol}: ${locs.length}`)
  return { id: call.id, name: call.name, result: `${word} «${symbol}» (${locs.length}):\n${lines}` }
}

export const findDefinitionHandler: ToolHandler = {
  mode: 'parallel-read',
  handle: (call, ctx) => navigate('definition', call, ctx),
}

export const findReferencesHandler: ToolHandler = {
  mode: 'parallel-read',
  handle: (call, ctx) => navigate('references', call, ctx),
}
