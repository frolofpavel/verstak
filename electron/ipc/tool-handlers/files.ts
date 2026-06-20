// File-хендлеры: convert_file / edit_spreadsheet. Вынесено при распиле.
import type { ToolHandler } from './shared'
import { emitActivity, awaitCommandConfirm } from './shared'
import { scanText, isForbiddenPath } from '../../ai/secret-scanner'
import { safeRealJoin } from '../../ai/path-policy'
import { decide, blockReason } from '../../ai/mode-policy'

function csvToMarkdown(lines: string[]): string {
  if (lines.length === 0) return '(пустой CSV)'
  const rows = lines.map(l => l.split(',').map(c => c.trim()))
  const header = rows[0]
  const sep = header.map(() => '---')
  const body = rows.slice(1)
  return [
    '| ' + header.join(' | ') + ' |',
    '| ' + sep.join(' | ') + ' |',
    ...body.map(r => '| ' + r.join(' | ') + ' |')
  ].join('\n')
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 10000)
}

export const convertFileHandler: ToolHandler = {
  mode: 'parallel-read',
  async handle(call, ctx) {
    try {
      const { readFileSync, existsSync } = await import('fs')
      const { extname } = await import('path')
      const { safeRealJoin } = await import('../../ai/path-policy')
      const relPath = String(call.args.path ?? '')
      if (!relPath) {
        return { id: call.id, name: call.name, result: '', error: 'convert_file: path обязателен' }
      }
      // Тот же рубеж, что read_file/read_spreadsheet: convert_file иначе отдавал
      // creds*.json / cookies.json / credentials.json модели в обход политики.
      if (isForbiddenPath(relPath)) {
        return { id: call.id, name: call.name, result: '', error: `Доступ запрещён политикой безопасности: ${relPath} (secrets/credentials)` }
      }
      const filePath = await safeRealJoin(ctx.projectPath, relPath)
      if (!existsSync(filePath)) {
        return { id: call.id, name: call.name, result: '', error: `convert_file: файл не найден: ${relPath}` }
      }
      const ext = extname(filePath).toLowerCase()

      if (ext === '.csv') {
        const text = readFileSync(filePath, 'utf-8')
        const lines = text.split('\n').filter(l => l.trim()).slice(0, 50)
        const result = scanText(csvToMarkdown(lines)).redacted
        emitActivity(ctx, call, 'ok', 'convert_file', `${relPath} · CSV → table`)
        return { id: call.id, name: call.name, result }
      }

      if (ext === '.html' || ext === '.htm') {
        const html = readFileSync(filePath, 'utf-8')
        emitActivity(ctx, call, 'ok', 'convert_file', `${relPath} · HTML → text`)
        return { id: call.id, name: call.name, result: scanText(stripHtml(html)).redacted }
      }

      if (ext === '.docx') {
        // mammoth уже в зависимостях для ArtifactPreview
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mammoth = require('mammoth') as { extractRawText: (opts: { path: string }) => Promise<{ value: string }> }
        const result = await mammoth.extractRawText({ path: filePath })
        emitActivity(ctx, call, 'ok', 'convert_file', `${relPath} · DOCX → text`)
        return { id: call.id, name: call.name, result: scanText(result.value.slice(0, 20000)).redacted }
      }

      if (ext === '.json') {
        const text = readFileSync(filePath, 'utf-8')
        emitActivity(ctx, call, 'ok', 'convert_file', `${relPath} · JSON`)
        return { id: call.id, name: call.name, result: '```json\n' + scanText(text.slice(0, 10000)).redacted + '\n```' }
      }

      if (ext === '.xml') {
        const text = readFileSync(filePath, 'utf-8')
        emitActivity(ctx, call, 'ok', 'convert_file', `${relPath} · XML`)
        return { id: call.id, name: call.name, result: scanText(text.slice(0, 10000)).redacted }
      }

      return {
        id: call.id, name: call.name,
        result: `Формат ${ext} не поддерживается. Поддерживаемые: .csv, .html, .htm, .docx, .json, .xml`
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

export const editSpreadsheetHandler: ToolHandler = {
  mode: 'confirm-write',
  async handle(call, ctx) {
    try {
      const path = String(call.args.path ?? '')
      if (!path) {
        return { id: call.id, name: call.name, result: '', error: 'edit_spreadsheet: path обязателен' }
      }
      const sheet = call.args.sheet ? String(call.args.sheet) : undefined
      const rawEdits = Array.isArray(call.args.edits) ? call.args.edits : []
      const edits = rawEdits
        .filter((e: unknown): e is Record<string, unknown> => typeof e === 'object' && e !== null)
        .map((e) => ({ cell: String((e as Record<string, unknown>).cell ?? ''), value: String((e as Record<string, unknown>).value ?? '') }))
        .filter(e => e.cell.length > 0)
      if (edits.length === 0) {
        return { id: call.id, name: call.name, result: '', error: 'edit_spreadsheet: edits обязателен и не должен быть пустым' }
      }

      // Mode policy — как write_file: ask/accept-edits/auto/bypass/plan
      const decision = decide('edit_spreadsheet', ctx.agentMode)
      if (decision === 'block') {
        const reason = blockReason('edit_spreadsheet', ctx.agentMode)
        return { id: call.id, name: call.name, result: '', error: reason }
      }
      const summary = `Правка таблицы ${path}${sheet ? ` · лист ${sheet}` : ''}: ${edits.map(e => `${e.cell}=${e.value}`).join(', ').slice(0, 300)}`
      let accepted: boolean
      if (decision === 'auto-accept') {
        ctx.sender.send('ai:event', {
          id: ctx.sendId,
          event: { type: 'tool-activity', callId: call.id, name: 'edit_spreadsheet', label: 'edit_spreadsheet (авто)', detail: summary, status: 'ok' }
        })
        accepted = true
      } else {
        ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'pending-command', callId: call.id, command: summary } })
        accepted = await awaitCommandConfirm(ctx, call.id)
      }
      if (!accepted) {
        ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'command-result', callId: call.id, command: summary, status: 'rejected' } })
        return { id: call.id, name: call.name, result: summary, error: 'User rejected' }
      }

      const { editSpreadsheet } = await import('../../ai/office')
      const res = await editSpreadsheet(ctx.projectPath, path, sheet, edits)
      try { ctx.recordJournal(ctx.projectPath, 'tool', `📊 Правка xlsx: ${path}`, `${res.applied} ячеек на листе "${res.sheet}"`) } catch { /* journal not critical */ }
      emitActivity(ctx, call, 'ok', 'edit_spreadsheet', `${res.applied} ячеек · лист ${res.sheet}`)
      return { id: call.id, name: call.name, result: `Применено ${res.applied} правок в "${path}" (лист "${res.sheet}").` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}
