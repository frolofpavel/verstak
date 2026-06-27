// Tier-2 #1 — LSP-навигация как тулзы: find_definition / find_references. Семантика
// через язык-сервер (точнее grep'а). Read-only. Движок — electron/ai/lsp-nav.ts.
import { readFileSync } from 'fs'
import { join, relative } from 'path'
import type { ToolHandler, ToolContext } from './shared'
import { emitActivity } from './shared'
import { runLspNavigation } from '../../ai/lsp-nav'
import { isLspDiagnosableFile } from '../../ai/lang-servers'
import type { ToolCall, ToolResult } from '../../ai/types'

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
  const abs = join(ctx.projectPath, rel)
  if (!isLspDiagnosableFile(abs)) {
    return { id: call.id, name: call.name, result: `LSP-навигация поддерживается для Python/Go/Rust; для ${rel} языковой сервер не настроен — используй search_project.` }
  }
  let content: string
  try {
    content = readFileSync(abs, 'utf8')
  } catch (e) {
    return { id: call.id, name: call.name, result: '', error: `не прочитать ${rel}: ${e instanceof Error ? e.message : String(e)}` }
  }
  const word = kind === 'definition' ? 'Определение' : 'Использования'
  const locs = await runLspNavigation({ path: abs, content, root: ctx.projectPath, symbol, kind })
  if (locs === null) {
    emitActivity(ctx, call, 'error', call.name, `${symbol}: сервер недоступен`)
    return { id: call.id, name: call.name, result: `Языковой сервер недоступен/не ответил для «${symbol}». Установлен ли pyright/gopls/rust-analyzer? Фолбэк — search_project.` }
  }
  if (locs.length === 0) {
    emitActivity(ctx, call, 'ok', call.name, `${symbol}: не найдено`)
    return { id: call.id, name: call.name, result: `${word} «${symbol}»: не найдено (символ отсутствует в ${rel} или сервер не разрешил его).` }
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
