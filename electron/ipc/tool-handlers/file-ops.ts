// File-хендлеры: read / write_file / apply_patch / propose_edits + diffConfirmWrite. Вынесено при распиле.
import type { ToolHandler, ToolContext } from './shared'
import type { ToolCall, ToolResult } from '../../ai/types'
import { emitActivity, summarizeToolCall } from './shared'
import { existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { decide, blockReason } from '../../ai/mode-policy'
import { applySearchReplaceBlocks } from '../../ai/tools'
import { markFileDirty } from '../../ai/project-map'

export const readHandler: ToolHandler = {
  mode: 'parallel-read',
  async handle(call, ctx) {
    try {
      const result = await ctx.tools.execute(call.name, call.args)
      const s = summarizeToolCall(call.name, call.args, result)
      if (s) emitActivity(ctx, call, 'ok', s.label, s.detail)
      return { id: call.id, name: call.name, result }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

// ============================================================================
// File ops: write_file, apply_patch, propose_edits
// ============================================================================

async function diffConfirmWrite(call: ToolCall, ctx: ToolContext, path: string, before: string, after: string): Promise<ToolResult> {
  const decision = decide(call.name, ctx.agentMode, ctx.autoApprove)
  if (decision === 'block') {
    return { id: call.id, name: call.name, result: '', error: blockReason(call.name, ctx.agentMode) }
  }
  let accepted: boolean
  if (decision === 'auto-accept') {
    // Skip user prompt — still surface the diff via tool-activity for visibility
    ctx.sender.send('ai:event', {
      id: ctx.sendId,
      event: { type: 'tool-activity', callId: call.id, name: call.name, label: `${call.name} (авто)`, detail: path, status: 'ok' }
    })
    accepted = true
  } else {
    // 'confirm' — show diff modal and wait. Ожидание привязано к ctx.signal:
    // для суба это taskAc.signal (per-task таймаут/отмена), для главного агента —
    // ctrl.signal. Раньше Promise не слушал abort → суб-executor с write в
    // ask-режиме висел, и per-task таймаут его не разрывал (до 50 модалок).
    ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'pending-write', callId: call.id, path, before, after } })
    const key = ctx.scopedKey(ctx.sendId, call.id)
    accepted = await new Promise<boolean>(resolve => {
      let settled = false
      const finish = (v: boolean) => {
        if (settled) return  // guard от двойного resolve (abort + ai:resolve-write)
        settled = true
        ctx.pendingWrites.delete(key)
        ctx.signal.removeEventListener('abort', onAbort)
        resolve(v)
      }
      // Таймаут/отмена субзадачи (или родителя) → трактуем как reject.
      const onAbort = () => finish(false)
      ctx.pendingWrites.set(key, { sendId: ctx.sendId, resolve: finish })
      if (ctx.signal.aborted) { onAbort(); return }
      ctx.signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  if (!accepted) {
    return { id: call.id, name: call.name, result: `User rejected write to ${path}`, error: 'User rejected' }
  }
  // Существовал ли файл ДО записи: для undo важно отличать «файла не было»
  // (revert → unlink) от «был, но пустой» (revert → восстановить пустым). Иначе
  // before='' для существующего пустого файла трактовался как «не было» и revert
  // удалял его (B4). null = не существовал, '' = существовал пустым.
  const existedBefore = existsSync(join(ctx.projectPath, path))
  try {
    await ctx.tools.execute('write_file', { path, content: after })
    try { ctx.recordWrite(ctx.projectPath, path, existedBefore ? before : null, after) } catch { /* undo not critical */ }
    // Incremental project map update — mark file dirty instead of full rebuild
    markFileDirty(ctx.projectPath, join(ctx.projectPath, path))
    // Timeline задачи (Фаза 4): принятая запись файла. ref/label = путь (панель
    // строит секцию «Файлы» из событий file_write). best-effort.
    try { ctx.recordRunEvent?.('file_write', { label: path, ref: path, status: 'ok' }) } catch { /* best-effort */ }
    return { id: call.id, name: call.name, result: `Applied ${call.name === 'apply_patch' ? 'patch' : 'write'} to ${path}` }
  } catch (err) {
    return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
  }
}

async function readBeforeContent(ctx: ToolContext, path: string): Promise<string> {
  try {
    let before = await ctx.tools.execute('read_file', { path }) as string
    // Strip the secret-scanner header line from read_file output before
    // computing the patch — it isn't actually in the file.
    if (before.startsWith('[secret-scanner: redacted')) {
      const nl = before.indexOf('\n')
      if (nl >= 0) before = before.slice(nl + 1)
    }
    return before
  } catch { return '' }
}

export const writeFileHandler: ToolHandler = {
  mode: 'confirm-write',
  async handle(call, ctx) {
    const path = String(call.args.path)
    const before = await readBeforeContent(ctx, path)
    const after = String(call.args.content ?? '')
    return diffConfirmWrite(call, ctx, path, before, after)
  }
}

export const applyPatchHandler: ToolHandler = {
  mode: 'confirm-write',
  async handle(call, ctx) {
    const path = String(call.args.path)
    const before = await readBeforeContent(ctx, path)
    // Anti-redacted-writeback: read_file отдаёт модели [REDACTED:...] вместо
    // реальных секретов. Если модель строит патч поверх такого «before», она
    // перепишет реальные значения плейсхолдерами. Блокируем — пусть правит
    // файл вручную вне приложения.
    if (before.includes('[REDACTED:')) {
      return { id: call.id, name: call.name, result: '', error: 'apply_patch заблокирован: файл содержит секреты, скрытые secret-scanner ([REDACTED:...]). Патч переписал бы плейсхолдеры поверх реальных значений. Отредактируй файл вручную вне приложения.' }
    }
    const anchorHash = call.args.anchor_hash ? String(call.args.anchor_hash) : undefined
    let after: string
    try {
      after = applySearchReplaceBlocks(before, String(call.args.diff ?? ''), anchorHash)
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
    return diffConfirmWrite(call, ctx, path, before, after)
  }
}

interface ProposeEdit { path: string; content: string; reason?: string }

export const proposeEditsHandler: ToolHandler = {
  mode: 'confirm-write',
  async handle(call, ctx) {
    const rawEdits = Array.isArray(call.args.edits) ? call.args.edits : []
    const edits: ProposeEdit[] = rawEdits
      .filter((e: unknown): e is Record<string, unknown> => typeof e === 'object' && e !== null)
      .map((e) => ({
        path: String((e as Record<string, unknown>).path ?? ''),
        content: String((e as Record<string, unknown>).content ?? ''),
        reason: (e as Record<string, unknown>).reason != null ? String((e as Record<string, unknown>).reason) : undefined
      }))
      .filter(e => e.path.length > 0)
    if (edits.length === 0) {
      return { id: call.id, name: call.name, result: '', error: 'propose_edits: no edits in batch' }
    }
    // Fan out: one synthetic confirm-write per edit. They all hit the same
    // multi-file modal (renderer accumulates pending writes).
    const subResults: ToolResult[] = []
    for (const edit of edits) {
      const subId = `${call.id}::${randomUUID()}`
      const before = await readBeforeContent(ctx, edit.path)
      const subCall: ToolCall = {
        id: subId,
        name: 'write_file',
        args: { path: edit.path, content: edit.content },
        ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {})
      }
      const r = await diffConfirmWrite(subCall, ctx, edit.path, before, edit.content)
      subResults.push(r)
    }
    const ok = subResults.filter(r => !r.error).length
    const total = subResults.length
    // #12: принятые файлы — структурно (filesWritten), чтобы agent-loop добавил
    // их в filesTouched для attest-сверки claimed-vs-actual. Текст "Applied ok/total"
    // не давал per-file accept (частичный accept структурно не виден).
    const filesWritten = edits.filter((_e, i) => !subResults[i].error).map(e => e.path)
    return {
      id: call.id,
      name: call.name,
      result: `Applied ${ok}/${total} edits. ${subResults.map(r => r.error ? `✗ ${r.error}` : `✓ ${r.result}`).join('; ')}`,
      ...(filesWritten.length ? { filesWritten } : {}),
      ...(ok === 0 ? { error: 'All edits rejected or failed' } : {})
    }
  }
}
