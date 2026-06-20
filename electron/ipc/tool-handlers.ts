/**
 * Tool handlers — extracted from runApiConversation.
 *
 * Each handler takes a normalized ToolContext + the tool call, and returns a
 * ToolResult. Handlers also have side-effects (UI events, journal entries,
 * attachment collection) that they perform via ctx callbacks.
 *
 * The dispatch table (HANDLER_REGISTRY) maps tool name → handler entry.
 * `mode` controls how the agentic loop schedules execution:
 *
 *   'parallel-read' — pure-info tools (read_file/list_directory/search_project/
 *                     find_files/get_project_map/refresh_project_map).
 *                     Fired in parallel via Promise.all — no UI side effects
 *                     or shared mutable state.
 *
 *   'sequential'    — tools that need to run in order or have UI effects
 *                     (run_command, browser_*, list_connectors,
 *                     connector_query, create_plan).
 *
 *   'confirm-write' — tools that go through the multi-file diff confirm
 *                     modal (write_file, apply_patch, propose_edits). Collected
 *                     into writePromises and awaited together so the user gets
 *                     ONE modal for all writes in a turn.
 */

import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { join, resolve, relative, isAbsolute } from 'path'
import type { Attachment, ToolCall, ToolResult } from '../ai/types'
import { applySearchReplaceBlocks, type FileTools } from '../ai/tools'
import { decide, blockReason, type AgentMode } from '../ai/mode-policy'
import { planSpecFeedback } from '../ai/task-spec-check'
import { classifyMcpToolScope, mcpDecision, mcpBlockReason } from '../ai/mcp-policy'
import { getRolePrompt } from '../ai/agent-roles'
import { invalidateProjectMap, markFileDirty } from '../ai/project-map'
import { scanText, isForbiddenPath } from '../ai/secret-scanner'
import { safeRealJoin } from '../ai/path-policy'
import type { McpClient } from '../mcp/client'
import type { ProviderId, CreateOptions } from '../ai/registry'
import type { VerificationArtifact, VerificationCheck, VerificationChangedFile } from '../ai/verification'
import { createSshBackend, makeSshExec, parseSshProjectPath } from '../projects/ssh-backend'

const execFileAsync = promisify(execFile)

// Таймаут на одну делегированную подзадачу. Поднят с 60с (one-shot эра) до 180с:
// субагент теперь крутит agent-loop с tool-вызовами (read/patch/run_command),
// что требует заметно больше времени. Лимит итераций (MAX_SUB_ITERATIONS) —
// вторая, независимая граница; таймаут страхует от зависшего провайдера/команды.
const SUB_TASK_TIMEOUT_MS = 180_000

// Cost-cap на ОДИН delegate_parallel вызов (помимо cap всей сессии из Settings).
// Защищает от батча из 30 задач, который один пожрёт весь бюджет: при превышении
// оставшиеся задачи батча не стартуют. В центах. Дефолт $3 — можно переопределить
// аргументом cost_cap_usd у delegate_parallel.
const DEFAULT_BATCH_COST_CAP_CENTS = 300

// Типы и общие хелперы вынесены в ./tool-handlers/shared (распил монолита tool-handlers.ts).
import { emitActivity, awaitCommandConfirm } from './tool-handlers/shared'
import type { SendId, TaggedSender, ConnectorRegistry, ToolContext, ToolMode, ToolHandler } from './tool-handlers/shared'
// Реэкспорт типов для внешних импортов (sub-agent-loop импортит ToolContext отсюда).
export type { SendId, TaggedSender, ConnectorRegistry, ToolContext, ToolMode, ToolHandler }
import { renderChartHandler, generateHtmlHandler, generateDocxHandler } from './tool-handlers/artifacts'

export function summarizeToolCall(name: string, args: Record<string, unknown>, result: unknown): { label: string; detail: string } | null {
  if (name === 'read_file') {
    const p = String(args.path ?? '')
    const len = typeof result === 'string' ? result.length : 0
    return { label: 'read_file', detail: `${p} · ${len} символов` }
  }
  if (name === 'list_directory') {
    const p = String(args.path ?? '.')
    const count = Array.isArray(result) ? result.length : 0
    return { label: 'list_directory', detail: `${p} · ${count} элементов` }
  }
  if (name === 'search_project') {
    const q = String(args.query ?? '')
    const r = result as { matches?: unknown[] } | undefined
    const hits = Array.isArray(r?.matches) ? r!.matches!.length : 0
    return { label: 'search_project', detail: `"${q}" · ${hits} совпадений` }
  }
  if (name === 'find_files') {
    const pattern = String(args.pattern ?? '')
    const r = result as { files?: unknown[] } | undefined
    const hits = Array.isArray(r?.files) ? r!.files!.length : 0
    return { label: 'find_files', detail: `${pattern} · ${hits} файлов` }
  }
  if (name === 'list_connectors') {
    const arr = typeof result === 'string' ? JSON.parse(result) as Array<{ label?: string }> : []
    return { label: 'list_connectors', detail: `${arr.length} коннекторов` }
  }
  if (name === 'connector_query') {
    return { label: 'connector_query', detail: `${String(args.id ?? '?')}${args.entity ? ` · ${args.entity}` : ''}` }
  }
  if (name === 'browser_navigate') {
    return { label: 'browser_navigate', detail: String(args.url ?? '') }
  }
  if (name === 'browser_read_page') {
    return { label: 'browser_read_page', detail: args.selector ? String(args.selector) : '(вся страница)' }
  }
  if (name === 'browser_screenshot') {
    return { label: 'browser_screenshot', detail: '' }
  }
  if (name === 'get_project_map' || name === 'refresh_project_map') {
    return { label: name, detail: '' }
  }
  return null
}

// ============================================================================
// Default handler for read-only / pure-info tools
// ============================================================================

const readHandler: ToolHandler = {
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
  const decision = decide(call.name, ctx.agentMode)
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

const writeFileHandler: ToolHandler = {
  mode: 'confirm-write',
  async handle(call, ctx) {
    const path = String(call.args.path)
    const before = await readBeforeContent(ctx, path)
    const after = String(call.args.content ?? '')
    return diffConfirmWrite(call, ctx, path, before, after)
  }
}

const applyPatchHandler: ToolHandler = {
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

const proposeEditsHandler: ToolHandler = {
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

// ============================================================================
// Command: run_command
// ============================================================================

const runCommandHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    const command = String(call.args.command ?? '')
    const verdict = ctx.tools.classifyCommand(command)
    if (!verdict.allowed) {
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-blocked', callId: call.id, name: 'run_command', command, reason: verdict.reason ?? 'denylist' }
      })
      return {
        id: call.id, name: call.name,
        result: `Command: ${command}`,
        error: `Blocked by safety policy: ${verdict.reason ?? 'denylist'}`
      }
    }
    // Mode policy: plan blocks, ask confirms, auto/bypass auto-accept,
    // accept-edits still confirms commands (only edits auto-pass).
    const decision = decide('run_command', ctx.agentMode)
    if (decision === 'block') {
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-blocked', callId: call.id, name: 'run_command', command, reason: blockReason('run_command', ctx.agentMode) }
      })
      return { id: call.id, name: call.name, result: '', error: blockReason('run_command', ctx.agentMode) }
    }
    let accepted: boolean
    if (decision === 'auto-accept') {
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-activity', callId: call.id, name: 'run_command', label: 'run_command (авто)', detail: command, status: 'ok' }
      })
      accepted = true
    } else {
      ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'pending-command', callId: call.id, command } })
      accepted = await awaitCommandConfirm(ctx, call.id)
    }
    if (!accepted) {
      ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'command-result', callId: call.id, command, status: 'rejected' } })
      return { id: call.id, name: call.name, result: `Command: ${command}`, error: 'User rejected' }
    }
    try {
      const result = await ctx.tools.runCommand(command)
      // Редактируем оба потока через secret-scanner ДО отправки в UI и
      // возврата модели — иначе ключи/токены из stdout/stderr утекают в
      // контекст и в Timeline.
      const stdout = scanText(result.stdout).redacted
      const stderr = scanText(result.stderr).redacted
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'command-result', callId: call.id, command, status: 'ok', exitCode: result.exitCode, stdout, stderr }
      })
      // Timeline задачи (Фаза 4): run_command не идёт через emitActivity, поэтому
      // пишем событие здесь, рядом с command-result. exitCode≠0 → status='error'.
      try { ctx.recordRunEvent?.('tool_call', { label: 'run_command', detail: command, status: result.exitCode === 0 ? 'ok' : 'error' }) } catch { /* best-effort */ }
      return { id: call.id, name: call.name, result: { stdout, stderr, exitCode: result.exitCode } }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'command-result', callId: call.id, command, status: 'error', error: msg }
      })
      try { ctx.recordRunEvent?.('tool_call', { label: 'run_command', detail: msg, status: 'error' }) } catch { /* best-effort */ }
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

// ============================================================================
// Browser: navigate / read_page / screenshot
// ============================================================================

async function dispatchBrowser(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  try {
    // Args are JSON-stringified once and embedded via JSON.stringify(JSON.stringify(...))
    // so the runtime JSON.parse is the only thing that touches LLM-supplied data.
    const argsLiteral = JSON.stringify(JSON.stringify(call.args ?? {}))
    let action: string
    if (call.name === 'browser_navigate') {
      action = `return await api.navigate(String(a.url ?? ''));`
    } else if (call.name === 'browser_read_page') {
      action = `const text = await api.readPage(a.selector ? String(a.selector) : undefined);
                return { url: api.getURL(), title: api.getTitle(), text };`
    } else {
      action = `const dataUrl = await api.screenshot();
                return { url: api.getURL(), dataUrl };`
    }
    const snippet = `(async () => {
      const api = window.verstakBrowser;
      if (!api) return { __err: 'Вкладка Browser не открыта — попроси пользователя открыть её' };
      const a = JSON.parse(${argsLiteral});
      ${action}
    })()`
    const result = await ctx.sender.exec(snippet)
    if (result && typeof result === 'object' && '__err' in result) {
      return { id: call.id, name: call.name, result: '', error: String((result as { __err: unknown }).__err) }
    }
    return { id: call.id, name: call.name, result: result ?? '' }
  } catch (err) {
    return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
  }
}

const browserHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    const result = await dispatchBrowser(call, ctx)
    // Journal what AI looked at on the web
    try {
      if (!result.error) {
        const url = String(call.args.url ?? '')
        const label = call.name === 'browser_navigate' ? `Браузер → ${url}`
                    : call.name === 'browser_read_page' ? `Браузер: прочитан текст`
                    : `Браузер: скриншот`
        ctx.recordJournal(ctx.projectPath, 'tool', label, null)
      }
    } catch { /* journal not critical */ }
    // Screenshot → queue as attachment for next user message
    if (call.name === 'browser_screenshot' && !result.error) {
      const r = result.result as { dataUrl?: string; url?: string } | string
      const dataUrl = typeof r === 'object' && r ? r.dataUrl : undefined
      if (dataUrl && dataUrl.startsWith('data:image/')) {
        const m = /^data:(image\/[\w+-]+);base64,(.+)$/.exec(dataUrl)
        if (m) {
          ctx.pendingAttachments.push({
            name: `screenshot-${Date.now()}.png`,
            mimeType: m[1],
            data: m[2],
            size: Math.floor(m[2].length * 0.75)
          })
          result.result = { url: typeof r === 'object' ? r.url : null, attached: true }
        }
      }
    }
    const s = summarizeToolCall(call.name, call.args, undefined)
    if (s) emitActivity(ctx, call, result.error ? 'error' : 'ok', s.label, s.detail)
    return result
  }
}

// ============================================================================
// Connectors: list_connectors, connector_query
// ============================================================================

const listConnectorsHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    const list = ctx.connectors.list()
    const result = JSON.stringify(list)
    const s = summarizeToolCall(call.name, call.args, result)
    if (s) emitActivity(ctx, call, 'ok', s.label, s.detail)
    return { id: call.id, name: call.name, result }
  }
}

const connectorQueryHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const cid = String(call.args.id ?? '')
      if (!cid) {
        return { id: call.id, name: call.name, result: '', error: 'connector_query: id обязателен' }
      }
      // Mode policy: коннекторы трогают внешние системы (SSH, HTTP POST, Telegram,
      // публикация), поэтому гейтятся как команда — plan блокирует, ask подтверждает,
      // auto/bypass авто-принимают. Описание запроса показываем пользователю в модалке.
      const entity = call.args.entity ? ` · ${call.args.entity}` : ''
      const path = call.args.path ? ` · ${call.args.path}` : ''
      const summary = `Коннектор ${cid}${entity}${path}`
      const decision = decide('connector_query', ctx.agentMode)
      if (decision === 'block') {
        const reason = blockReason('connector_query', ctx.agentMode)
        ctx.sender.send('ai:event', {
          id: ctx.sendId,
          event: { type: 'tool-blocked', callId: call.id, name: 'connector_query', command: summary, reason }
        })
        return { id: call.id, name: call.name, result: '', error: reason }
      }
      let accepted: boolean
      if (decision === 'auto-accept') {
        accepted = true
      } else {
        // 'confirm' — переиспользуем pending-command поток (та же модалка подтверждения)
        ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'pending-command', callId: call.id, command: summary } })
        accepted = await awaitCommandConfirm(ctx, call.id)
      }
      if (!accepted) {
        ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'command-result', callId: call.id, command: summary, status: 'rejected' } })
        return { id: call.id, name: call.name, result: summary, error: 'User rejected' }
      }
      const { id: _omit, ...rest } = call.args as Record<string, unknown> & { id?: unknown }
      void _omit
      // Я.Диск upload читает локальный файл по local_path. Без guard'а агент мог
      // выгрузить ЛЮБОЙ файл системы (включая .env/.ssh/creds) в облако клиента.
      // Загоняем local_path в границы проекта (тем же safeRealJoin, что и tools),
      // отсекаем выход за корень и секретные файлы. Артефакты в
      // {project}/.verstak/artifacts проходят автоматически — они внутри корня.
      if (cid === 'yandex_disk' && rest.local_path != null) {
        if (!ctx.projectPath) {
          return { id: call.id, name: call.name, result: '', error: 'Я.Диск upload запрещён без открытого проекта' }
        }
        const lp = String(rest.local_path)
        const relCheck = relative(ctx.projectPath, resolve(ctx.projectPath, lp))
        if (relCheck.startsWith('..') || isAbsolute(relCheck)) {
          return { id: call.id, name: call.name, result: '', error: 'Я.Диск upload: путь вне проекта запрещён' }
        }
        const safe = await safeRealJoin(ctx.projectPath, lp)  // бросит при symlink-escape
        if (isForbiddenPath(relative(ctx.projectPath, safe))) {
          return { id: call.id, name: call.name, result: '', error: 'Я.Диск upload: секретные файлы (.env/.key/creds) запрещены' }
        }
        rest.local_path = safe
      }
      // Аудит B4: у коннекторов нет собственного таймаута — зависший хост
      // (медленный 1С / упавший OAuth-endpoint) повесил бы весь agent-loop до
      // ручного Stop. Комбинируем ctx.signal (ручной Stop / отмена роя) с
      // 30-секундным таймаутом запроса. Чинит все 31 коннектора разом.
      const connAc = new AbortController()
      const onParentAbort = () => connAc.abort()
      const connTimeout = setTimeout(() => connAc.abort(), 30_000)
      ctx.signal.addEventListener('abort', onParentAbort, { once: true })
      if (ctx.signal.aborted) connAc.abort()
      let result: unknown
      try {
        result = await ctx.connectors.query(cid, rest, connAc.signal)
      } catch (e) {
        if (connAc.signal.aborted && !ctx.signal.aborted) {
          return { id: call.id, name: call.name, result: '', error: `Коннектор ${cid}: таймаут запроса (30с) — хост не ответил` }
        }
        throw e
      } finally {
        clearTimeout(connTimeout)
        ctx.signal.removeEventListener('abort', onParentAbort)
      }
      const s = summarizeToolCall(call.name, call.args, undefined)
      if (s) emitActivity(ctx, call, 'ok', s.label, s.detail)
      // Journal connector queries
      try {
        const entity = call.args.entity ? ` · ${call.args.entity}` : ''
        const path = call.args.path ? ` · ${call.args.path}` : ''
        ctx.recordJournal(ctx.projectPath, 'tool', `Коннектор ${cid}${entity}${path}`, null)
      } catch { /* journal not critical */ }
      // Аудит M2: тело коннектора и его ошибки могут содержать эхо токена
      // (многие API отражают auth-параметр). scanText — последний рубеж перед
      // тем, как результат уйдёт в контекст модели и transcript.
      const rawResult = typeof result === 'string' ? result : JSON.stringify(result)
      return { id: call.id, name: call.name, result: scanText(rawResult).redacted }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const safeMsg = scanText(msg).redacted
      emitActivity(ctx, call, 'error', call.name, safeMsg)
      try { ctx.recordJournal(ctx.projectPath, 'tool', `Коннектор упал: ${String(call.args.id ?? '?')}`, safeMsg) } catch { /* journal not critical */ }
      return { id: call.id, name: call.name, result: '', error: safeMsg }
    }
  }
}

// ============================================================================
// Plans: create_plan
// ============================================================================

const readJournalHandler: ToolHandler = {
  mode: 'parallel-read',
  async handle(call, ctx) {
    const requestedLimit = typeof call.args.limit === 'number' ? Math.max(1, Math.min(100, Math.floor(call.args.limit))) : 30
    const kindFilter = typeof call.args.kind === 'string' ? call.args.kind : null
    try {
      const all = ctx.readJournal(ctx.projectPath, requestedLimit * 3)
      const filtered = kindFilter ? all.filter(e => e.kind === kindFilter) : all
      const result = filtered.slice(0, requestedLimit).map(e => ({
        kind: e.kind,
        title: e.title,
        detail: e.detail ? e.detail.slice(0, 500) : null,  // cap so journal doesn't blow context
        when: new Date(e.createdAt).toISOString()
      }))
      emitActivity(ctx, call, 'ok', 'read_journal', `${result.length} записей${kindFilter ? ` · kind=${kindFilter}` : ''}`)
      return { id: call.id, name: call.name, result: JSON.stringify(result) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

// ============================================================================
// Sub-provider create-options — добор секретов под 18 провайдеров (Фаза 1)
// ============================================================================

/**
 * Собрать опции для createProvider субагента. grok-версия ограничивалась
 * {apiKey, model, cwd, signal} — для verstak этого мало: российские и custom
 * провайдеры требуют дополнительные секреты:
 *   - yandex-gpt    → yandexFolderId (yandex_folder_id)
 *   - gigachat      → gigachatClientSecret (gigachat_client_secret)
 *   - custom-openai → customBaseUrl/customModels (custom_openai_baseurl/_models)
 *   - claude-cli    → claudeOauthToken (claude_code_oauth_token, для headless+Max)
 * Секреты добираются через ctx.getSecretForDelegate (тот же reader, что и в
 * главном ai.ts:405-427). Без этого суб на 4+ провайдерах падает «Folder ID
 * не задан / Client Secret не задан / Base URL не задан».
 */
function buildSubCreateOptions(
  providerId: ProviderId,
  apiKey: string | null,
  model: string,
  signal: AbortSignal,
  ctx: ToolContext
): CreateOptions {
  const getSecret = ctx.getSecretForDelegate
  let customModels: string[] | undefined
  if (providerId === 'custom-openai') {
    const modelsRaw = getSecret?.('custom_openai_models')
    if (modelsRaw) customModels = modelsRaw.split(',').map(s => s.trim()).filter(Boolean)
  }
  return {
    apiKey,
    model,
    cwd: ctx.projectPath,
    signal,
    claudeOauthToken: providerId === 'claude-cli' ? (getSecret?.('claude_code_oauth_token') ?? null) : undefined,
    customBaseUrl: providerId === 'custom-openai' ? (getSecret?.('custom_openai_baseurl') ?? undefined) : undefined,
    customModels,
    yandexFolderId: providerId === 'yandex-gpt' ? (getSecret?.('yandex_folder_id') ?? undefined) : undefined,
    gigachatClientSecret: providerId === 'gigachat' ? (getSecret?.('gigachat_client_secret') ?? undefined) : undefined,
    gigachatTlsVerify: providerId === 'gigachat' ? (getSecret?.('gigachat_tls_verify') === 'true') : undefined,
    agentMode: ctx.agentMode
  }
}

// ============================================================================
// delegate_task — мультиагент V1
// ============================================================================

/**
 * Нормализует и дедуплицирует поле `id` у элементов батча IN-PLACE. Пустой id →
 * `<prefix>-N`, повтор → `id#2`, `id#3`… Нужно потому что subCallId строится как
 * `${call.id}:${item.id}` — дубль id схлопывает карточки субагентов (upsert по
 * callId) и ломает дерево суб-сессий. id — модельный ввод, программно не уникален.
 */
export function dedupeTaskIds(items: Array<{ id: string }>, prefix = 'task'): void {
  const seen = new Set<string>()
  items.forEach((item, i) => {
    let id = String(item.id ?? '').trim() || `${prefix}-${i + 1}`
    if (seen.has(id)) {
      let n = 2
      while (seen.has(`${id}#${n}`)) n++
      id = `${id}#${n}`
    }
    seen.add(id)
    item.id = id
  })
}

const delegateTaskHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const skillId = call.args.skill_id ? String(call.args.skill_id) : null
      const providerOverride = call.args.provider_id ? String(call.args.provider_id) : null
      const modelOverride = call.args.model ? String(call.args.model) : null
      const role = call.args.role ? String(call.args.role) : null
      const prompt = String(call.args.prompt ?? '').trim()
      if (!prompt) {
        return { id: call.id, name: call.name, result: '', error: 'delegate_task: prompt обязателен' }
      }

      // Фаза 4 (Идея 3): гейт глубины + общего числа агентов. Главный агент имеет
      // depth=0; каждый суб увеличивает depth на 1. Если глубина исчерпана или
      // достигнут потолок числа агентов — отказываем понятной ошибкой. Резерв
      // считается ДО запуска, чтобы вложенное дерево не обошло лимит.
      const depth = ctx.delegationDepth ?? 0
      if (ctx.agentCounter) {
        const gate = ctx.agentCounter.tryReserve(depth, 1)
        if (!gate.allowed) {
          return { id: call.id, name: call.name, result: '', error: `delegate_task: ${gate.reason}` }
        }
      }

      // Скилл — опционально. Если задан, тащим его системный промпт + default provider/model.
      const skills = ctx.skillRegistry ? ctx.skillRegistry.list() : []
      const skill = skillId ? skills.find(s => s.id === skillId) ?? null : null

      const subProvider = providerOverride
        ?? skill?.default_provider
        ?? null  // null → ai:send возьмёт текущий default из settings
      const subModel = modelOverride ?? skill?.default_model ?? null
      // Промпт субагента: роль (если задана) + скилл/generic. Роль определяет
      // и поведение, и набор tools (getRoleToolset). С tool-enabled loop'ом
      // важно явно сказать субу, что у него ЕСТЬ инструменты.
      const rolePrompt = role ? getRolePrompt(role) : null
      const systemPrompt = rolePrompt
        ?? skill?.systemPrompt
        ?? 'Ты — sub-agent с доступом к инструментам (чтение файлов, поиск по проекту). Выполни узкую задачу, при необходимости используй tools, ответь по существу.'

      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: {
          type: 'tool-activity',
          callId: call.id,
          name: 'delegate_task',
          label: 'delegate_task',
          detail: `${skill?.name ?? skillId ?? role ?? 'generic'} via ${subProvider ?? 'auto'}`,
          status: 'ok'
        }
      })

      // subagent-run visibility (fan-out V1) — additive card в чате. label/skill/
      // provider/task + status running → done/error + tool-счётчик (Фаза 1).
      const subLabel = skill?.name ?? skillId ?? role ?? 'sub-agent'
      let toolCount = 0
      const emitSubagent = (status: 'running' | 'done' | 'error', result?: string) => {
        ctx.sender.send('ai:event', {
          id: ctx.sendId,
          event: {
            type: 'subagent-run',
            callId: call.id,
            label: subLabel,
            provider: subProvider ?? undefined,
            skill: skillId ?? undefined,
            role: role ?? undefined,
            toolCount,
            task: prompt,
            status,
            result
          }
        })
      }
      emitSubagent('running')

      // Персистентная суб-сессия (Фаза 2, Идея 1): создаём строку kind='subagent',
      // привязанную к главному чату. Промпт суба сохраняем как первое сообщение.
      // Без subSessions фасада — работает как прежде (только эфемерная карточка).
      let subSessionId: number | null = null
      if (ctx.subSessions) {
        try {
          subSessionId = ctx.subSessions.create({
            projectPath: ctx.projectPath,
            parentChatId: ctx.parentChatId ?? null,
            role, task: prompt, callId: call.id,
            providerId: subProvider ?? ctx.currentProviderId ?? null,
            model: subModel ?? null,
            depth: depth + 1, parentCallId: ctx.parentCallId ?? null
          })
          ctx.subSessions.appendMessage(subSessionId, ctx.projectPath, 'user', prompt)
        } catch { /* persist не критично — карточка всё равно покажется */ }
      }
      const finalizeSub = (status: string, assistant?: string) => {
        if (subSessionId == null || !ctx.subSessions) return
        try {
          if (assistant) ctx.subSessions.appendMessage(subSessionId, ctx.projectPath, 'assistant', assistant)
          ctx.subSessions.update(subSessionId, { status, endedAt: Date.now() })
        } catch { /* persist не критично */ }
      }

      const { createProvider, PROVIDERS } = await import('../ai/registry')
      const { runSubAgentLoop } = await import('../ai/sub-agent-loop')
      const { getRoleToolset } = await import('../ai/role-tools')
      const fallbackProvider = subProvider ?? ctx.currentProviderId ?? null
      if (!fallbackProvider) {
        ctx.agentCounter?.release(1)  // суб не стартовал — возвращаем слот
        emitSubagent('error', 'нет провайдера')
        finalizeSub('error')
        return { id: call.id, name: call.name, result: '', error: 'delegate_task: provider_id не задан и у текущего чата нет провайдера. Укажи provider_id явно.' }
      }
      const descriptor = PROVIDERS[fallbackProvider as keyof typeof PROVIDERS]
      if (!descriptor) {
        ctx.agentCounter?.release(1)
        emitSubagent('error', `неизвестный provider ${fallbackProvider}`)
        finalizeSub('error')
        return { id: call.id, name: call.name, result: '', error: `delegate_task: неизвестный provider ${fallbackProvider}` }
      }
      const apiKey = descriptor.secretKey ? ctx.getSecretForDelegate?.(descriptor.secretKey) ?? null : null
      if (descriptor.secretKey && !apiKey) {
        ctx.agentCounter?.release(1)
        emitSubagent('error', `нет API key для ${fallbackProvider}`)
        finalizeSub('error')
        return { id: call.id, name: call.name, result: '', error: `delegate_task: нет API key для ${fallbackProvider}` }
      }

      // Per-task signal: проброс родительского abort + таймаут на весь loop.
      // 180с (было 60с для one-shot) — loop с tool-вызовами требует больше времени.
      const taskAc = new AbortController()
      const timeoutId = setTimeout(() => taskAc.abort(), SUB_TASK_TIMEOUT_MS)
      const parentAbortHandler = () => taskAc.abort()
      ctx.signal.addEventListener('abort', parentAbortHandler, { once: true })

      // Глобальная очередь (Идея 6): ждём слот в семафоре процесса. Группа —
      // опциональный group-тег, чтобы суб можно было отменить массово.
      const { subAgentQueue } = await import('../ai/sub-queue')
      const groupTag = call.args.group ? String(call.args.group) : null
      let queueSlot: { release: () => void; ticketId: number } | null = null
      try {
        queueSlot = await subAgentQueue.enter({ group: groupTag, role, abort: () => taskAc.abort() }, taskAc.signal)
      } catch {
        clearTimeout(timeoutId)
        ctx.signal.removeEventListener('abort', parentAbortHandler)
        ctx.agentCounter?.release(1)  // суб не стартовал — возвращаем слот
        emitSubagent('error', 'отменён в очереди')
        finalizeSub('cancelled')
        return { id: call.id, name: call.name, result: '', error: 'delegate_task: задача отменена в очереди' }
      }

      try {
        const resolvedModel = subModel ?? descriptor.defaultModel
        const provider = createProvider(
          fallbackProvider as ProviderId,
          buildSubCreateOptions(fallbackProvider as ProviderId, apiKey, resolvedModel, taskAc.signal, ctx)
        )
        // Whitelist tools по роли + глубине суба (Фаза 4): на разрешённой глубине
        // суб-исполнитель получает delegate_* и может строить поддерево.
        const allowedTools = getRoleToolset(role, { depth: depth + 1 })
        const subCtx: ToolContext = {
          ...ctx,
          subProviderId: fallbackProvider as ProviderId,
          subModel: resolvedModel,
          // Дерево делегирования: суб глубже на 1, его родитель — этот вызов.
          delegationDepth: depth + 1,
          parentCallId: call.id
        }
        const messages = [
          { role: 'system' as const, content: systemPrompt },
          { role: 'user' as const, content: prompt }
        ]
        const res = await runSubAgentLoop({
          provider, messages, allowedToolNames: allowedTools, ctx: subCtx,
          signal: taskAc.signal, role,
          onToolActivity: () => { toolCount++; emitSubagent('running') }
        })
        if (res.exitReason === 'error') {
          emitSubagent('error', res.error)
          finalizeSub('error', res.text.trim() || undefined)
          // Timeline задачи (Фаза 4): делегирование завершилось ошибкой.
          try { ctx.recordRunEvent?.('delegate', { label: subLabel, detail: res.error, ref: call.id, status: 'error' }) } catch { /* best-effort */ }
          return { id: call.id, name: call.name, result: '', error: `delegate_task error: ${res.error}` }
        }
        const trimmed = res.text.trim()
        if (!trimmed) {
          emitSubagent('error', 'sub-agent вернул пустой ответ')
          finalizeSub('error')
          try { ctx.recordRunEvent?.('delegate', { label: subLabel, detail: 'пустой ответ', ref: call.id, status: 'error' }) } catch { /* best-effort */ }
          return { id: call.id, name: call.name, result: '', error: 'delegate_task: sub-agent вернул пустой ответ' }
        }
        emitSubagent('done', trimmed.length > 1200 ? trimmed.slice(0, 1200) + '…' : trimmed)
        finalizeSub(res.exitReason === 'aborted' ? 'cancelled' : 'done', trimmed)
        // Timeline задачи (Фаза 4): делегирование завершено. label=роль/скилл/
        // провайдер суба, ref=callId, detail — число tool-вызовов суба.
        try { ctx.recordRunEvent?.('delegate', { label: subLabel, detail: `${res.toolCallCount} tools via ${subProvider ?? fallbackProvider}`, ref: call.id, status: 'ok' }) } catch { /* best-effort */ }
        try {
          ctx.recordJournal(ctx.projectPath, 'note',
            `🎭 Делегирование → ${skill?.name ?? skillId ?? role ?? fallbackProvider} (${res.toolCallCount} tools, ${res.exitReason})`,
            `Запрос: ${prompt.slice(0, 200)}\n---\nОтвет: ${trimmed.slice(0, 600)}${trimmed.length > 600 ? '…' : ''}`)
        } catch { /* journal не критично */ }
        return { id: call.id, name: call.name, result: `[Delegate from ${skill?.name ?? skillId ?? role ?? fallbackProvider}]\n\n${trimmed}` }
      } finally {
        clearTimeout(timeoutId)
        ctx.signal.removeEventListener('abort', parentAbortHandler)
        queueSlot?.release()
      }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

// ============================================================================
// delegate_parallel — мультиагент V2: параллельное выполнение N задач
// ============================================================================

const delegateParallelHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const tasks = call.args.tasks as Array<{ id: string; prompt: string; provider_id?: string; model?: string; role?: string }> | undefined
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return { id: call.id, name: call.name, result: '', error: 'delegate_parallel: tasks обязателен и не должен быть пустым' }
      }
      // Потолок поднят до 50 (было 12): задачи держатся в глобальной очереди
      // (sub-queue), а одновременно стримит не больше GLOBAL_SUB_CONCURRENCY —
      // т.е. 50 в очереди не убивают провайдер. См. Фаза 2, Идея 6.
      const MAX_PARALLEL = 50
      if (tasks.length > MAX_PARALLEL) {
        return { id: call.id, name: call.name, result: '', error: `delegate_parallel: максимум ${MAX_PARALLEL} задач в одном батче` }
      }

      // Нормализация-дедуп task.id: subCallId = `${call.id}:${task.id}` должен быть
      // уникальным в батче, иначе карточки субагентов сливаются (upsert по callId)
      // и связь суб-сессий/дерева рушится. Пустой id → task-N, дубль → id#2/#3…
      dedupeTaskIds(tasks)

      // Фаза 4 (Идея 3): гейт глубины + общего числа агентов. Резервируем сразу
      // ВЕСЬ батч (tasks.length) — если квота/глубина не позволяют, не стартуем
      // вообще (иначе вложенный fan-out обошёл бы потолок). depth берётся из ctx.
      const depth = ctx.delegationDepth ?? 0
      if (ctx.agentCounter) {
        const gate = ctx.agentCounter.tryReserve(depth, tasks.length)
        if (!gate.allowed) {
          return { id: call.id, name: call.name, result: '', error: `delegate_parallel: ${gate.reason}` }
        }
      }

      // Группа/тег батча — для массовой отмены «по тегу» (Идея 6). Если не задан
      // явно — используем callId как авто-группу, чтобы можно было отменить весь
      // этот конкретный delegate_parallel разом.
      const groupTag = call.args.group ? String(call.args.group) : call.id

      // Cost-cap на весь батч (Идея 6): помимо cap всей сессии. Параметр
      // cost_cap_usd опционален; дефолт — DEFAULT_BATCH_COST_CAP_CENTS.
      const batchCapCents = typeof call.args.cost_cap_usd === 'number' && call.args.cost_cap_usd > 0
        ? Math.round(call.args.cost_cap_usd * 100)
        : DEFAULT_BATCH_COST_CAP_CENTS
      // Стартовая стоимость сессии — батч считаем как прирост сверх неё.
      const batchStartCents = ctx.subCostGuard?.current() ?? 0
      // Флаг «батч превысил cap» — взводится первой задачей, которая увидела
      // превышение; остальные ожидающие задачи в очереди не стартуют.
      let batchCapped = false

      const { createProvider, PROVIDERS } = await import('../ai/registry')
      const { subAgentQueue, GLOBAL_SUB_CONCURRENCY } = await import('../ai/sub-queue')

      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: {
          type: 'tool-activity',
          callId: call.id,
          name: 'delegate_parallel',
          label: 'delegate_parallel',
          detail: `${tasks.length} задач (очередь, ≤${GLOBAL_SUB_CONCURRENCY} разом)`,
          status: 'ok'
        }
      })

      const { runSubAgentLoop } = await import('../ai/sub-agent-loop')
      const { getRoleToolset } = await import('../ai/role-tools')

      // Запускаем ВСЕ задачи сразу — глобальный семафор сам ограничит реальную
      // одновременность. Это даёт честную очередь (а не локальные батчи по 4).
      const results = await Promise.allSettled(tasks.map(async (task) => {
        // Provider задаётся per-task → в одном батче можно смешивать разные
        // провайдеры (например API и CLI). Здесь каждая задача независимо
        // резолвит свой провайдер.
        const providerId = task.provider_id ?? ctx.currentProviderId ?? 'gemini-api'

        // subagent-run visibility (fan-out V2) — каждая параллельная задача
        // показывается как своя карточка. Distinct callId `${call.id}:${task.id}`
        // → upsert по callId, обновление status running → done/error в месте.
        const subCallId = `${call.id}:${task.id}`
        let toolCount = 0
        const emitSubagent = (status: 'running' | 'done' | 'error', result?: string) => {
          ctx.sender.send('ai:event', {
            id: ctx.sendId,
            event: {
              type: 'subagent-run',
              callId: subCallId,
              label: task.role ?? task.id,
              provider: providerId,
              role: task.role,
              toolCount,
              task: task.prompt,
              status,
              result
            }
          })
        }
        emitSubagent('running')

        // Персистентная суб-сессия (Идея 1). Каждая задача батча — своя сессия.
        let subSessionId: number | null = null
        if (ctx.subSessions) {
          try {
            subSessionId = ctx.subSessions.create({
              projectPath: ctx.projectPath,
              parentChatId: ctx.parentChatId ?? null,
              role: task.role ?? null, task: task.prompt, group: groupTag, callId: subCallId,
              providerId, model: task.model ?? null,
              depth: depth + 1, parentCallId: ctx.parentCallId ?? null
            })
            ctx.subSessions.appendMessage(subSessionId, ctx.projectPath, 'user', task.prompt)
          } catch { /* persist не критично */ }
        }
        const finalizeSub = (status: string, assistant?: string) => {
          if (subSessionId == null || !ctx.subSessions) return
          try {
            if (assistant) ctx.subSessions.appendMessage(subSessionId, ctx.projectPath, 'assistant', assistant)
            ctx.subSessions.update(subSessionId, { status, toolCount, endedAt: Date.now() })
          } catch { /* persist не критично */ }
        }

        const descriptor = PROVIDERS[providerId as keyof typeof PROVIDERS]
        if (!descriptor) {
          ctx.agentCounter?.release(1)  // суб не стартовал — возвращаем слот
          emitSubagent('error', `неизвестный provider ${providerId}`)
          finalizeSub('error')
          throw new Error(`неизвестный provider ${providerId}`)
        }
        const apiKey = descriptor.secretKey ? ctx.getSecretForDelegate?.(descriptor.secretKey) ?? null : null
        if (descriptor.secretKey && !apiKey) {
          ctx.agentCounter?.release(1)
          emitSubagent('error', `нет API key для ${providerId}`)
          finalizeSub('error')
          throw new Error(`нет API key для ${providerId}`)
        }

        // Per-task AbortController. Таймаут поднят с 60с до 180с — субагент
        // теперь крутит tool-loop. Родительский signal прерывает подзадачу.
        const taskAc = new AbortController()
        const timeoutId = setTimeout(() => taskAc.abort(), SUB_TASK_TIMEOUT_MS)
        const parentAbortHandler = () => taskAc.abort()
        ctx.signal.addEventListener('abort', parentAbortHandler, { once: true })

        // Глобальная очередь: ждём слот. Если батч уже превысил cost-cap пока
        // мы стояли в очереди — не стартуем (экономим деньги).
        let queueSlot: { release: () => void; ticketId: number } | null = null
        try {
          queueSlot = await subAgentQueue.enter({ group: groupTag, role: task.role ?? null, abort: () => taskAc.abort() }, taskAc.signal)
        } catch {
          clearTimeout(timeoutId)
          ctx.signal.removeEventListener('abort', parentAbortHandler)
          ctx.agentCounter?.release(1)  // суб не стартовал — возвращаем слот
          emitSubagent('error', 'отменён в очереди')
          finalizeSub('cancelled')
          throw new Error('отменён в очереди')
        }
        if (batchCapped) {
          clearTimeout(timeoutId)
          ctx.signal.removeEventListener('abort', parentAbortHandler)
          queueSlot.release()
          ctx.agentCounter?.release(1)  // суб не стартовал — возвращаем слот
          emitSubagent('error', 'батч остановлен по cost-cap')
          finalizeSub('cancelled')
          throw new Error('батч остановлен по cost-cap')
        }

        try {
          const subModel = task.model ?? descriptor.defaultModel
          const provider = createProvider(
            providerId as ProviderId,
            buildSubCreateOptions(providerId as ProviderId, apiKey, subModel, taskAc.signal, ctx)
          )
          const rolePrompt = task.role ? getRolePrompt(task.role) : null
          // Идея 8 (handoff): просим суб дать СТРУКТУРИРОВАННЫЙ итог, чтобы при
          // 20+ параллельных субах главный агент получал сжатые выводы, а не
          // простыни. researcher/verifier также сохраняют находки через memory_save.
          const baseContent = rolePrompt
            ?? 'Ты — sub-agent с доступом к инструментам (чтение файлов, поиск по проекту). Выполни узкую задачу, при необходимости используй tools, ответь по существу.'
          const systemContent = `${baseContent}\n\nВ финале дай СТРУКТУРИРОВАННЫЙ итог тремя короткими блоками:\nСДЕЛАЛ: ...\nНАШЁЛ: ...\nРЕКОМЕНДУЮ: ...\nКлючевые находки сохраняй через memory_save (если доступен).`
          const messages = [
            { role: 'system' as const, content: systemContent },
            { role: 'user' as const, content: task.prompt }
          ]
          // Whitelist tools по роли задачи + глубине (Фаза 4): суб-исполнитель
          // на разрешённой глубине может делегировать дальше.
          const allowedTools = getRoleToolset(task.role, { depth: depth + 1 })
          const subCtx: ToolContext = {
            ...ctx,
            signal: taskAc.signal,
            subProviderId: providerId as ProviderId,
            subModel,
            delegationDepth: depth + 1,
            parentCallId: subCallId
          }
          const res = await runSubAgentLoop({
            provider, messages, allowedToolNames: allowedTools, ctx: subCtx,
            signal: taskAc.signal, role: task.role,
            onToolActivity: () => { toolCount++; emitSubagent('running') }
          })
          // Cost-cap батча: после каждой задачи смотрим прирост стоимости сессии.
          // Превысили — взводим флаг + отменяем ещё бегущие/ждущие задачи группы.
          if (ctx.subCostGuard) {
            const spentByBatch = ctx.subCostGuard.current() - batchStartCents
            if (spentByBatch >= batchCapCents && !batchCapped) {
              batchCapped = true
              subAgentQueue.cancel({ group: groupTag })
            }
          }
          if (res.exitReason === 'error') { finalizeSub('error', res.text.trim() || undefined); throw new Error(res.error ?? 'sub-agent error') }
          const trimmed = res.text.trim()
          if (!trimmed) { finalizeSub('error'); throw new Error('sub-agent вернул пустой ответ') }
          emitSubagent('done', trimmed.length > 1200 ? trimmed.slice(0, 1200) + '…' : trimmed)
          finalizeSub(res.exitReason === 'aborted' ? 'cancelled' : 'done', trimmed)
          return { id: task.id, result: trimmed }
        } catch (taskErr) {
          // Любой неожиданный throw (createProvider, abort/timeout) — карточка
          // не должна застрять на 'running'. Rethrow → Promise.allSettled reject.
          emitSubagent('error', taskErr instanceof Error ? taskErr.message : String(taskErr))
          finalizeSub('error')
          throw taskErr
        } finally {
          clearTimeout(timeoutId)
          ctx.signal.removeEventListener('abort', parentAbortHandler)
          queueSlot?.release()
        }
      }))

      const output = results.map((r, i) => {
        const taskId = tasks[i].id
        if (r.status === 'fulfilled') {
          return `## ${taskId}\n${r.value.result}`
        } else {
          const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
          return `## ${taskId}\n❌ Ошибка: ${msg}`
        }
      }).join('\n\n---\n\n')

      const successCount = results.filter(r => r.status === 'fulfilled').length
      try {
        ctx.recordJournal(ctx.projectPath, 'note',
          `🔀 delegate_parallel — ${successCount}/${tasks.length} успешно${batchCapped ? ' (стоп по cost-cap батча)' : ''}`,
          tasks.map(t => t.id).join(', '))
      } catch { /* journal не критично */ }

      const capNote = batchCapped
        ? `\n\n---\n\n⚠️ Батч остановлен: превышен cost-cap $${(batchCapCents / 100).toFixed(2)} на один delegate_parallel. Оставшиеся задачи не выполнены.`
        : ''
      return { id: call.id, name: call.name, result: output + capNote }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

// ============================================================================
// orchestrate — Smart Orchestrator + авто-декомпозиция (Фаза 3, Идея 5)
// ============================================================================

export interface DecomposedSubtask { id: string; prompt: string; role: string }

/**
 * Чистый парсер ответа планировщика → список подзадач. Устойчив: берёт первый
 * '[' … последний ']', валидирует роли, режет до maxSubtasks. Если распарсить не
 * удалось — фоллбэк: одна executor-подзадача = вся цель. Экспортируется для тестов.
 */
export function parseDecomposition(text: string, goal: string, maxSubtasks: number): DecomposedSubtask[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  let parsed: unknown = null
  if (start >= 0 && end > start) {
    try { parsed = JSON.parse(text.slice(start, end + 1)) } catch { /* фоллбэк ниже */ }
  }
  const validRoles = new Set(['researcher', 'executor', 'verifier', 'critic', 'planner'])
  const tasks: DecomposedSubtask[] = []
  if (Array.isArray(parsed)) {
    for (let i = 0; i < parsed.length && tasks.length < maxSubtasks; i++) {
      const o = parsed[i]
      if (typeof o !== 'object' || o === null) continue
      const r = o as Record<string, unknown>
      const prompt = String(r.prompt ?? '').trim()
      if (!prompt) continue
      const role = validRoles.has(String(r.role)) ? String(r.role) : 'executor'
      const id = String(r.id ?? `task-${i + 1}`).slice(0, 40) || `task-${i + 1}`
      tasks.push({ id, prompt, role })
    }
  }
  if (tasks.length === 0) {
    tasks.push({ id: 'task-1', prompt: goal, role: 'executor' })
  }
  return tasks
}

/**
 * Декомпозиция цели через вызов модели-планировщика. Просим вернуть JSON-массив
 * подзадач с ролями. Парс — через чистый parseDecomposition (тестируемый).
 */
export async function decomposeGoal(
  goal: string,
  maxSubtasks: number,
  providerId: ProviderId,
  apiKey: string | null,
  model: string,
  ctx: ToolContext,
  signal: AbortSignal
): Promise<DecomposedSubtask[]> {
  const { createProvider } = await import('../ai/registry')
  // buildSubCreateOptions добирает yandexFolderId/gigachatClientSecret/customBaseUrl/
  // claudeOauthToken под российские/custom провайдеры (Фаза 1 helper).
  const provider = createProvider(providerId, buildSubCreateOptions(providerId, apiKey, model, signal, ctx))
  const sys = 'Ты — планировщик-декомпозитор. Разбей цель пользователя на независимые подзадачи, каждую с ролью из набора: researcher (анализ/поиск), executor (правка кода), verifier (проверка), critic (ревью), planner (под-план). Верни СТРОГО JSON-массив объектов {"id": "краткий-id", "prompt": "что сделать", "role": "роль"} и ничего больше. Подзадачи должны быть атомарными и параллелизуемыми.'
  const user = `Цель: ${goal}\n\nМаксимум подзадач: ${maxSubtasks}. Верни только JSON-массив.`
  let text = ''
  for await (const event of provider.send([
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ], [], undefined, signal)) {
    if (signal.aborted) break
    if (event.type === 'text' && typeof event.text === 'string') text += event.text
    else if (event.type === 'usage' && event.usage) {
      // Токены планировщика — платный API-вызов до старта батча. Учитываем их в
      // session cost guard, иначе orchestrate недосчитывает стоимость (асимметрия
      // с runSubAgentLoop, который usage обрабатывает). providerId/model здесь =
      // baseProviderId/plannerModel из orchestrate, поэтому модель совпадёт с PRICES.
      const guard = ctx.subCostGuard
      if (guard) {
        guard.recordAndCheck(providerId, model, event.usage.inputTokens ?? 0, event.usage.outputTokens ?? 0, event.usage.cachedInputTokens ?? 0)
      }
    }
    else if (event.type === 'error') throw new Error(event.message)
    else if (event.type === 'done') break
  }
  return parseDecomposition(text, goal, maxSubtasks)
}

const orchestrateHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const goal = String(call.args.goal ?? '').trim()
      if (!goal) {
        return { id: call.id, name: call.name, result: '', error: 'orchestrate: goal обязателен' }
      }
      const maxSubtasks = Math.max(1, Math.min(12, typeof call.args.max_subtasks === 'number' ? Math.floor(call.args.max_subtasks) : 5))
      const batchCapCents = typeof call.args.cost_cap_usd === 'number' && call.args.cost_cap_usd > 0
        ? Math.round(call.args.cost_cap_usd * 100)
        : DEFAULT_BATCH_COST_CAP_CENTS

      const { createProvider, PROVIDERS } = await import('../ai/registry')
      const { estimateComplexity, recommendModel } = await import('../ai/smart-router')
      const { runSubAgentLoop } = await import('../ai/sub-agent-loop')
      const { getRoleToolset } = await import('../ai/role-tools')
      const { getRolePrompt } = await import('../ai/agent-roles')
      const { subAgentQueue } = await import('../ai/sub-queue')

      const baseProviderId = (ctx.currentProviderId ?? 'gemini-api') as ProviderId
      const descriptor = PROVIDERS[baseProviderId]
      if (!descriptor) {
        return { id: call.id, name: call.name, result: '', error: `orchestrate: неизвестный provider ${baseProviderId}` }
      }
      const apiKey = descriptor.secretKey ? ctx.getSecretForDelegate?.(descriptor.secretKey) ?? null : null
      if (descriptor.secretKey && !apiKey) {
        return { id: call.id, name: call.name, result: '', error: `orchestrate: нет API key для ${baseProviderId}` }
      }

      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-activity', callId: call.id, name: 'orchestrate', label: 'orchestrate', detail: `декомпозиция цели · ${baseProviderId}`, status: 'ok' }
      })

      // 1) Декомпозиция через модель-планировщик (дешёвая модель достаточна).
      const plannerModel = recommendModel(baseProviderId, 'moderate') ?? descriptor.defaultModel
      const subtasks = await decomposeGoal(goal, maxSubtasks, baseProviderId, apiKey, plannerModel, ctx, ctx.signal)
      // Дедуп id подзадач — планировщик-модель может выдать одинаковые id, а
      // subCallId = `${call.id}:${task.id}` должен быть уникальным (см. dedupeTaskIds).
      dedupeTaskIds(subtasks)

      // 2) Создаём todo-лист из подзадач (TodoGate, Идея 2 — связь).
      if (ctx.sessionTodos) {
        try {
          ctx.sessionTodos.createBatch({
            projectPath: ctx.projectPath, sessionId: ctx.parentChatId ?? null,
            goal, titles: subtasks.map(t => `[${t.role}] ${t.prompt.slice(0, 120)}`)
          })
          ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'todo-updated' } })
        } catch { /* todo не критично для прогона */ }
      }

      // Группа батча = callId оркестратора (массовая отмена через панель).
      const groupTag = call.id
      const batchStartCents = ctx.subCostGuard?.current() ?? 0
      let batchCapped = false

      // Фаза 4: оркестратор работает на глубине главного агента (depth 0) и
      // порождает субов depth 1. Резервируем всё дерево подзадач в общий счётчик.
      const depth = ctx.delegationDepth ?? 0
      if (ctx.agentCounter) {
        const gate = ctx.agentCounter.tryReserve(depth, subtasks.length)
        if (!gate.allowed) {
          return { id: call.id, name: call.name, result: '', error: `orchestrate: ${gate.reason}` }
        }
      }

      // 3) Параллельный запуск подзадач с умным выбором модели на каждую.
      const results = await Promise.allSettled(subtasks.map(async (task) => {
        // Smart-router: оцениваем сложность подзадачи по её промпту → модель.
        // Простую → дешёвая модель, сложную → дорогая (полный verstak recommendModel).
        const complexity = estimateComplexity([{ role: 'user', content: task.prompt }], [])
        const subModel = recommendModel(baseProviderId, complexity) ?? descriptor.defaultModel

        const subCallId = `${call.id}:${task.id}`
        let toolCount = 0
        const emitSubagent = (status: 'running' | 'done' | 'error', result?: string) => {
          ctx.sender.send('ai:event', {
            id: ctx.sendId,
            event: { type: 'subagent-run', callId: subCallId, label: `${task.role} (${complexity})`, provider: baseProviderId, role: task.role, toolCount, task: task.prompt, status, result }
          })
        }
        emitSubagent('running')

        let subSessionId: number | null = null
        if (ctx.subSessions) {
          try {
            subSessionId = ctx.subSessions.create({
              projectPath: ctx.projectPath, parentChatId: ctx.parentChatId ?? null,
              role: task.role, task: task.prompt, group: groupTag, callId: subCallId,
              providerId: baseProviderId, model: subModel,
              depth: depth + 1, parentCallId: ctx.parentCallId ?? call.id
            })
            ctx.subSessions.appendMessage(subSessionId, ctx.projectPath, 'user', task.prompt)
          } catch { /* persist не критично */ }
        }
        const finalizeSub = (status: string, assistant?: string) => {
          if (subSessionId == null || !ctx.subSessions) return
          try {
            if (assistant) ctx.subSessions.appendMessage(subSessionId, ctx.projectPath, 'assistant', assistant)
            ctx.subSessions.update(subSessionId, { status, toolCount, endedAt: Date.now() })
          } catch { /* persist не критично */ }
        }

        const taskAc = new AbortController()
        const timeoutId = setTimeout(() => taskAc.abort(), SUB_TASK_TIMEOUT_MS)
        const parentAbortHandler = () => taskAc.abort()
        ctx.signal.addEventListener('abort', parentAbortHandler, { once: true })

        let queueSlot: { release: () => void; ticketId: number } | null = null
        try {
          queueSlot = await subAgentQueue.enter({ group: groupTag, role: task.role, abort: () => taskAc.abort() }, taskAc.signal)
        } catch {
          clearTimeout(timeoutId)
          ctx.signal.removeEventListener('abort', parentAbortHandler)
          ctx.agentCounter?.release(1)  // суб не стартовал — возвращаем слот
          emitSubagent('error', 'отменён в очереди')
          finalizeSub('cancelled')
          throw new Error('отменён в очереди')
        }
        if (batchCapped) {
          clearTimeout(timeoutId)
          ctx.signal.removeEventListener('abort', parentAbortHandler)
          queueSlot.release()
          ctx.agentCounter?.release(1)  // суб не стартовал — возвращаем слот
          emitSubagent('error', 'остановлен по cost-cap')
          finalizeSub('cancelled')
          throw new Error('остановлен по cost-cap')
        }

        try {
          const provider = createProvider(
            baseProviderId,
            buildSubCreateOptions(baseProviderId, apiKey, subModel, taskAc.signal, ctx)
          )
          // Идея 8: просим суб выдать СТРУКТУРИРОВАННЫЙ итог (handoff-формат), чтобы
          // главный агент получал сжатые выводы, а не простыни при 20+ субах.
          const rolePrompt = getRolePrompt(task.role) ?? 'Ты — sub-agent с доступом к инструментам.'
          const systemContent = `${rolePrompt}\n\nВ финале дай СТРУКТУРИРОВАННЫЙ итог тремя короткими блоками:\nСДЕЛАЛ: ...\nНАШЁЛ: ...\nРЕКОМЕНДУЮ: ...\nКлючевые находки сохраняй через memory_save (если доступен).`
          const allowedTools = getRoleToolset(task.role, { depth: depth + 1 })
          const subCtx: ToolContext = {
            ...ctx, signal: taskAc.signal,
            subProviderId: baseProviderId, subModel,
            delegationDepth: depth + 1,
            parentCallId: subCallId
          }
          const res = await runSubAgentLoop({
            provider, messages: [
              { role: 'system', content: systemContent },
              { role: 'user', content: task.prompt }
            ], allowedToolNames: allowedTools, ctx: subCtx, signal: taskAc.signal, role: task.role,
            onToolActivity: () => { toolCount++; emitSubagent('running') }
          })
          if (ctx.subCostGuard) {
            const spent = ctx.subCostGuard.current() - batchStartCents
            if (spent >= batchCapCents && !batchCapped) {
              batchCapped = true
              subAgentQueue.cancel({ group: groupTag })
            }
          }
          if (res.exitReason === 'error') { finalizeSub('error', res.text.trim() || undefined); throw new Error(res.error ?? 'sub-agent error') }
          const trimmed = res.text.trim()
          if (!trimmed) { finalizeSub('error'); throw new Error('sub-agent вернул пустой ответ') }
          emitSubagent('done', trimmed.length > 1200 ? trimmed.slice(0, 1200) + '…' : trimmed)
          finalizeSub(res.exitReason === 'aborted' ? 'cancelled' : 'done', trimmed)
          return { id: task.id, role: task.role, model: subModel, result: trimmed }
        } catch (taskErr) {
          emitSubagent('error', taskErr instanceof Error ? taskErr.message : String(taskErr))
          finalizeSub('error')
          throw taskErr
        } finally {
          clearTimeout(timeoutId)
          ctx.signal.removeEventListener('abort', parentAbortHandler)
          queueSlot?.release()
        }
      }))

      // 4) Сжатый handoff главному агенту: по подзадаче — роль/модель + итог суба.
      const successCount = results.filter(r => r.status === 'fulfilled').length
      const blocks = results.map((r, i) => {
        const t = subtasks[i]
        if (r.status === 'fulfilled') {
          return `## ${t.id} — ${r.value.role} (${r.value.model})\n${r.value.result}`
        }
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
        return `## ${t.id} — ${t.role}\n❌ ${msg}`
      }).join('\n\n---\n\n')

      try {
        ctx.recordJournal(ctx.projectPath, 'note',
          `🧭 orchestrate — ${successCount}/${subtasks.length} подзадач${batchCapped ? ' (стоп по cost-cap)' : ''}`,
          `Цель: ${goal.slice(0, 200)}\nРоли: ${subtasks.map(t => t.role).join(', ')}`)
      } catch { /* journal не критично */ }

      const capNote = batchCapped ? `\n\n---\n\n⚠️ Оркестратор остановлен: превышен cost-cap $${(batchCapCents / 100).toFixed(2)}.` : ''
      const header = `🧭 Оркестратор разбил цель на ${subtasks.length} подзадач (${successCount} успешно). Сводка выводов:\n\n`
      return { id: call.id, name: call.name, result: header + blocks + capNote }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

// ============================================================================
// swarm — Agent Swarms с консенсусом-арбитром (Фаза 4, Идея 10)
// ============================================================================

export interface SwarmMember { id: string; role: string; angle: string }

/**
 * Чистый билдер ростера роя: одна цель → N агентов, атакующих её с РАЗНЫХ углов.
 * В отличие от orchestrate (декомпозиция на подзадачи) рой делает N независимых
 * ПОПЫТОК решить ту же цель целиком + критика. Углы детерминированы (тестируется).
 *
 * Состав для size=4: 2 executor с разными стратегиями + 1 researcher + 1 critic.
 * Масштабируется: лишние слоты — дополнительные executor-варианты с новыми углами.
 */
export function buildSwarmRoster(size: number): SwarmMember[] {
  const n = Math.max(2, Math.min(8, Math.floor(size) || 4))
  // Углы-стратегии для executor-вариантов — разные «характеры» решения.
  const angles = [
    'самое прямое и минимальное решение',
    'максимально надёжное решение с проверкой edge cases',
    'решение с упором на читаемость и поддерживаемость',
    'нестандартный подход — найди обходной/более простой путь',
    'решение с упором на производительность',
    'решение с упором на безопасность и валидацию входных данных'
  ]
  const members: SwarmMember[] = []
  // Первый слот — researcher (соберёт контекст под общую цель).
  members.push({ id: 'scout', role: 'researcher', angle: 'разведка: собери релевантный контекст и ограничения для цели' })
  // Последний слот — critic (оценит варианты независимо).
  // Между ними — executor-варианты с разными углами.
  const executorSlots = n - 2  // минус researcher и critic
  for (let i = 0; i < executorSlots; i++) {
    members.push({ id: `solver-${i + 1}`, role: 'executor', angle: angles[i % angles.length] })
  }
  members.push({ id: 'critic', role: 'critic', angle: 'найди слабые места во всех подходах к цели' })
  return members
}

const swarmHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const goal = String(call.args.goal ?? '').trim()
      if (!goal) {
        return { id: call.id, name: call.name, result: '', error: 'swarm: goal обязателен' }
      }
      const strategy = call.args.strategy ? String(call.args.strategy).trim() : ''
      const roster = buildSwarmRoster(typeof call.args.size === 'number' ? call.args.size : 4)
      // Дедуп id членов роя — buildSwarmRoster даёт уникальные id по построению,
      // но subCallId = `${call.id}:${m.id}` требует гарантии (см. dedupeTaskIds).
      dedupeTaskIds(roster, 'member')
      const batchCapCents = typeof call.args.cost_cap_usd === 'number' && call.args.cost_cap_usd > 0
        ? Math.round(call.args.cost_cap_usd * 100)
        : DEFAULT_BATCH_COST_CAP_CENTS

      const { createProvider, PROVIDERS } = await import('../ai/registry')
      const { runSubAgentLoop } = await import('../ai/sub-agent-loop')
      const { getRoleToolset } = await import('../ai/role-tools')
      const { getRolePrompt } = await import('../ai/agent-roles')
      const { subAgentQueue } = await import('../ai/sub-queue')

      const baseProviderId = (ctx.currentProviderId ?? 'gemini-api') as ProviderId
      const descriptor = PROVIDERS[baseProviderId]
      if (!descriptor) {
        return { id: call.id, name: call.name, result: '', error: `swarm: неизвестный provider ${baseProviderId}` }
      }
      const apiKey = descriptor.secretKey ? ctx.getSecretForDelegate?.(descriptor.secretKey) ?? null : null
      if (descriptor.secretKey && !apiKey) {
        return { id: call.id, name: call.name, result: '', error: `swarm: нет API key для ${baseProviderId}` }
      }

      // Фаза 4 (Идея 3): резервируем весь рой + арбитра в общий счётчик агентов.
      // Рой работает на depth главного агента; его члены — depth+1.
      const depth = ctx.delegationDepth ?? 0
      if (ctx.agentCounter) {
        const gate = ctx.agentCounter.tryReserve(depth, roster.length + 1) // +1 арбитр
        if (!gate.allowed) {
          return { id: call.id, name: call.name, result: '', error: `swarm: ${gate.reason}` }
        }
      }

      // Группа батча = callId роя (массовая отмена через панель). UI пометит группу.
      const groupTag = call.id
      const batchStartCents = ctx.subCostGuard?.current() ?? 0
      let batchCapped = false

      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-activity', callId: call.id, name: 'swarm', label: 'swarm', detail: `рой из ${roster.length} + арбитр · ${baseProviderId}`, status: 'ok' }
      })

      const runMember = async (m: SwarmMember) => {
        const subCallId = `${call.id}:${m.id}`
        let toolCount = 0
        const emitSubagent = (status: 'running' | 'done' | 'error', result?: string) => {
          ctx.sender.send('ai:event', {
            id: ctx.sendId,
            event: { type: 'subagent-run', callId: subCallId, label: `🐝 ${m.role}/${m.id}`, provider: baseProviderId, role: m.role, swarm: groupTag, toolCount, task: goal, status, result }
          })
        }
        emitSubagent('running')

        let subSessionId: number | null = null
        if (ctx.subSessions) {
          try {
            subSessionId = ctx.subSessions.create({
              projectPath: ctx.projectPath, parentChatId: ctx.parentChatId ?? null,
              role: m.role, task: `[swarm] ${goal}`, group: groupTag, callId: subCallId,
              providerId: baseProviderId, model: descriptor.defaultModel,
              depth: depth + 1, parentCallId: ctx.parentCallId ?? call.id
            })
            ctx.subSessions.appendMessage(subSessionId, ctx.projectPath, 'user', goal)
          } catch { /* persist не критично */ }
        }
        const finalizeSub = (status: string, assistant?: string) => {
          if (subSessionId == null || !ctx.subSessions) return
          try {
            if (assistant) ctx.subSessions.appendMessage(subSessionId, ctx.projectPath, 'assistant', assistant)
            ctx.subSessions.update(subSessionId, { status, toolCount, endedAt: Date.now() })
          } catch { /* persist не критично */ }
        }

        const taskAc = new AbortController()
        const timeoutId = setTimeout(() => taskAc.abort(), SUB_TASK_TIMEOUT_MS)
        const parentAbortHandler = () => taskAc.abort()
        ctx.signal.addEventListener('abort', parentAbortHandler, { once: true })

        let queueSlot: { release: () => void; ticketId: number } | null = null
        try {
          queueSlot = await subAgentQueue.enter({ group: groupTag, role: m.role, abort: () => taskAc.abort() }, taskAc.signal)
        } catch {
          clearTimeout(timeoutId); ctx.signal.removeEventListener('abort', parentAbortHandler)
          ctx.agentCounter?.release(1)  // член роя не стартовал — возвращаем слот
          emitSubagent('error', 'отменён в очереди'); finalizeSub('cancelled')
          throw new Error('отменён в очереди')
        }
        if (batchCapped) {
          clearTimeout(timeoutId); ctx.signal.removeEventListener('abort', parentAbortHandler); queueSlot.release()
          ctx.agentCounter?.release(1)  // член роя не стартовал — возвращаем слот
          emitSubagent('error', 'остановлен по cost-cap'); finalizeSub('cancelled')
          throw new Error('остановлен по cost-cap')
        }

        try {
          const provider = createProvider(
            baseProviderId,
            buildSubCreateOptions(baseProviderId, apiKey, descriptor.defaultModel, taskAc.signal, ctx)
          )
          const rolePrompt = getRolePrompt(m.role) ?? 'Ты — sub-agent с доступом к инструментам.'
          // Угол/стратегия члена роя + общая стратегия-подсказка → разнообразие попыток.
          const strategyLine = strategy ? `\nОбщая стратегия роя: ${strategy}.` : ''
          const systemContent = `${rolePrompt}\n\nТы — участник РОЯ агентов, работающих над ОДНОЙ целью независимо. Твой угол: ${m.angle}.${strategyLine}\n\nДай законченный вариант решения/вывода по цели целиком (не часть). В финале — краткий итог: ПОДХОД / РЕЗУЛЬТАТ / РИСКИ.`
          const allowedTools = getRoleToolset(m.role, { depth: depth + 1 })
          const subCtx: ToolContext = {
            ...ctx, signal: taskAc.signal,
            subProviderId: baseProviderId, subModel: descriptor.defaultModel,
            delegationDepth: depth + 1, parentCallId: subCallId
          }
          const res = await runSubAgentLoop({
            provider, messages: [
              { role: 'system', content: systemContent },
              { role: 'user', content: goal }
            ], allowedToolNames: allowedTools, ctx: subCtx, signal: taskAc.signal, role: m.role,
            onToolActivity: () => { toolCount++; emitSubagent('running') }
          })
          if (ctx.subCostGuard) {
            const spent = ctx.subCostGuard.current() - batchStartCents
            if (spent >= batchCapCents && !batchCapped) { batchCapped = true; subAgentQueue.cancel({ group: groupTag }) }
          }
          if (res.exitReason === 'error') { finalizeSub('error', res.text.trim() || undefined); throw new Error(res.error ?? 'swarm member error') }
          const trimmed = res.text.trim()
          if (!trimmed) { finalizeSub('error'); throw new Error('участник роя вернул пустой ответ') }
          emitSubagent('done', trimmed.length > 1200 ? trimmed.slice(0, 1200) + '…' : trimmed)
          finalizeSub(res.exitReason === 'aborted' ? 'cancelled' : 'done', trimmed)
          return { id: m.id, role: m.role, angle: m.angle, result: trimmed }
        } catch (taskErr) {
          emitSubagent('error', taskErr instanceof Error ? taskErr.message : String(taskErr))
          finalizeSub('error')
          throw taskErr
        } finally {
          clearTimeout(timeoutId); ctx.signal.removeEventListener('abort', parentAbortHandler); queueSlot?.release()
        }
      }

      // 1) Запускаем рой параллельно (через общий семафор/очередь).
      const settled = await Promise.allSettled(roster.map(runMember))
      const variants = settled
        .map((r, i) => r.status === 'fulfilled'
          ? { id: roster[i].id, role: roster[i].role, angle: roster[i].angle, result: r.value.result }
          : null)
        .filter((v): v is { id: string; role: string; angle: string; result: string } => v !== null)

      if (variants.length === 0) {
        ctx.agentCounter?.release(1)  // арбитр (+1 в резерве) не стартует — возвращаем слот
        const errs = settled.map((r, i) => r.status === 'rejected' ? `${roster[i].id}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}` : '').filter(Boolean)
        return { id: call.id, name: call.name, result: '', error: `swarm: ни один агент роя не дал результат. ${errs.join('; ')}` }
      }

      // 2) АРБИТР: отдельный агент собирает варианты, оценивает и синтезирует
      // консенсус. Read-only (роль critic) — он не правит код, только выбирает/
      // синтезирует. Если арбитр упал — фоллбэк: вернуть все варианты главному.
      const variantsBlock = variants
        .map((v, i) => `### Вариант ${i + 1} — ${v.role}/${v.id} (угол: ${v.angle})\n${v.result}`)
        .join('\n\n')
      const arbiterSystem = 'Ты — АРБИТР роя агентов. Тебе дают несколько независимых вариантов решения ОДНОЙ цели. Твоя задача: оценить их, выбрать лучший ИЛИ синтезировать консенсус из сильных сторон нескольких. Верни: 1) КОНСЕНСУС — итоговое лучшее решение цели (готовое к использованию); 2) ОБОСНОВАНИЕ — на каких вариантах оно основано и почему (1-3 строки). Будь решительным: один чёткий результат, а не пересказ всех.'
      const arbiterUser = `Цель: ${goal}\n\nВарианты роя (${variants.length}):\n\n${variantsBlock}\n\nВыбери/синтезируй лучший консенсусный результат.`

      let consensus = ''
      let arbiterOk = false
      const arbiterCallId = `${call.id}:arbiter`
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'subagent-run', callId: arbiterCallId, label: '⚖️ arbiter', provider: baseProviderId, role: 'critic', swarm: groupTag, toolCount: 0, task: `консенсус из ${variants.length} вариантов`, status: 'running' }
      })
      let arbiterSessionId: number | null = null
      if (ctx.subSessions) {
        try {
          arbiterSessionId = ctx.subSessions.create({
            projectPath: ctx.projectPath, parentChatId: ctx.parentChatId ?? null,
            role: 'arbiter', task: `[swarm-arbiter] ${goal}`, group: groupTag, callId: arbiterCallId,
            providerId: baseProviderId, model: descriptor.defaultModel,
            depth: depth + 1, parentCallId: ctx.parentCallId ?? call.id
          })
          ctx.subSessions.appendMessage(arbiterSessionId, ctx.projectPath, 'user', arbiterUser)
        } catch { /* persist не критично */ }
      }
      // Per-task таймаут арбитра — тот же паттерн, что у членов роя (runMember).
      // Без него зависший арбитрский провайдер вешал swarm до ручной отмены
      // всего ai:send: signal === ctx.signal не обрывается по таймауту.
      const arbAc = new AbortController()
      const arbTimeoutId = setTimeout(() => arbAc.abort(), SUB_TASK_TIMEOUT_MS)
      const arbAbortHandler = () => arbAc.abort()
      ctx.signal.addEventListener('abort', arbAbortHandler, { once: true })
      try {
        const arbiterProvider = createProvider(
          baseProviderId,
          buildSubCreateOptions(baseProviderId, apiKey, descriptor.defaultModel, arbAc.signal, ctx)
        )
        // Арбитр — read-only (никаких правок при синтезе).
        const res = await runSubAgentLoop({
          provider: arbiterProvider,
          messages: [{ role: 'system', content: arbiterSystem }, { role: 'user', content: arbiterUser }],
          allowedToolNames: getRoleToolset('critic', { depth: depth + 1 }),
          ctx: { ...ctx, subProviderId: baseProviderId, subModel: descriptor.defaultModel, delegationDepth: depth + 1, parentCallId: arbiterCallId },
          signal: arbAc.signal, role: 'critic'
        })
        consensus = res.text.trim()
        arbiterOk = res.exitReason !== 'error' && consensus.length > 0
        ctx.sender.send('ai:event', {
          id: ctx.sendId,
          event: { type: 'subagent-run', callId: arbiterCallId, label: '⚖️ arbiter', provider: baseProviderId, role: 'critic', swarm: groupTag, toolCount: 0, task: `консенсус из ${variants.length} вариантов`, status: arbiterOk ? 'done' : 'error', result: consensus.slice(0, 1200) } })
        if (arbiterSessionId != null && ctx.subSessions) {
          try {
            if (consensus) ctx.subSessions.appendMessage(arbiterSessionId, ctx.projectPath, 'assistant', consensus)
            ctx.subSessions.update(arbiterSessionId, { status: arbiterOk ? 'done' : 'error', endedAt: Date.now() })
          } catch { /* persist не критично */ }
        }
      } catch (arbErr) {
        ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'subagent-run', callId: arbiterCallId, label: '⚖️ arbiter', provider: baseProviderId, role: 'critic', swarm: groupTag, toolCount: 0, task: 'консенсус', status: 'error', result: arbErr instanceof Error ? arbErr.message : String(arbErr) } })
        if (arbiterSessionId != null && ctx.subSessions) {
          try { ctx.subSessions.update(arbiterSessionId, { status: 'error', endedAt: Date.now() }) } catch { /* */ }
        }
      } finally {
        clearTimeout(arbTimeoutId)
        ctx.signal.removeEventListener('abort', arbAbortHandler)
      }

      try {
        ctx.recordJournal(ctx.projectPath, 'note',
          `🐝 swarm — ${variants.length}/${roster.length} вариантов${arbiterOk ? ' + консенсус арбитра' : ' (арбитр не дал ответ)'}${batchCapped ? ' (стоп по cost-cap)' : ''}`,
          `Цель: ${goal.slice(0, 200)}`)
      } catch { /* journal не критично */ }

      const capNote = batchCapped ? `\n\n⚠️ Рой остановлен: превышен cost-cap $${(batchCapCents / 100).toFixed(2)}.` : ''
      if (arbiterOk) {
        return { id: call.id, name: call.name, result: `🐝 Рой из ${variants.length} агентов → консенсус арбитра:\n\n${consensus}${capNote}` }
      }
      // Фоллбэк: арбитр не справился — отдаём главному все варианты, пусть решит сам.
      return { id: call.id, name: call.name, result: `🐝 Рой дал ${variants.length} вариантов (арбитр не синтезировал консенсус — выбери лучший сам):\n\n${variantsBlock}${capNote}` }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

// ============================================================================
// TodoGate — todo_create / todo_update / todo_list (Фаза 3, Идея 2)
// ============================================================================

// Общий формат todo-листа для tool-результата (компактно, без шума).
function formatTodoList(todos: Array<{ id: number; title: string; status: string; assigneeCallId?: string | null }>): string {
  if (todos.length === 0) return 'Todo-лист пуст.'
  const icon: Record<string, string> = { pending: '☐', in_progress: '⏳', done: '✅', blocked: '⛔' }
  const lines = todos.map(t => `${icon[t.status] ?? '☐'} #${t.id} ${t.title}${t.assigneeCallId ? ` (assignee: ${t.assigneeCallId})` : ''}`)
  const done = todos.filter(t => t.status === 'done').length
  return `Прогресс: ${done}/${todos.length}\n${lines.join('\n')}`
}

// Эфемерное событие для live-обновления секции Todo в панели Agents.
function emitTodoUpdate(ctx: ToolContext): void {
  ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'todo-updated' } })
}

const todoCreateHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    if (!ctx.sessionTodos) {
      return { id: call.id, name: call.name, result: '', error: 'todo_create: TodoGate недоступен в этом контексте' }
    }
    const rawItems = Array.isArray(call.args.items) ? call.args.items : []
    const titles = rawItems.map(String).map(s => s.trim()).filter(Boolean)
    if (titles.length === 0) {
      return { id: call.id, name: call.name, result: '', error: 'todo_create: items обязателен (непустой массив строк)' }
    }
    const goal = call.args.goal ? String(call.args.goal) : null
    try {
      const created = ctx.sessionTodos.createBatch({
        projectPath: ctx.projectPath,
        sessionId: ctx.parentChatId ?? null,
        goal, titles
      })
      emitTodoUpdate(ctx)
      emitActivity(ctx, call, 'ok', 'todo_create', `${created.length} пунктов${goal ? ` · ${goal.slice(0, 40)}` : ''}`)
      return { id: call.id, name: call.name, result: `Создан todo-лист (${created.length} пунктов):\n${formatTodoList(created)}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

const todoUpdateHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    if (!ctx.sessionTodos) {
      return { id: call.id, name: call.name, result: '', error: 'todo_update: TodoGate недоступен в этом контексте' }
    }
    const sessionId = ctx.parentChatId ?? null
    // Идентификация пункта: по числовому id ИЛИ по точному title (субу удобнее
    // по названию — он не всегда знает id).
    let todoId: number | null = null
    if (typeof call.args.id === 'number') {
      todoId = Math.floor(call.args.id)
    } else if (call.args.title) {
      const found = ctx.sessionTodos.findByTitle(ctx.projectPath, sessionId, String(call.args.title))
      todoId = found?.id ?? null
    }
    if (todoId == null) {
      return { id: call.id, name: call.name, result: '', error: 'todo_update: укажи id (число) или title (точное название существующего пункта)' }
    }
    const status = call.args.status ? String(call.args.status) : undefined
    const allowed = ['pending', 'in_progress', 'done', 'blocked']
    if (status !== undefined && !allowed.includes(status)) {
      return { id: call.id, name: call.name, result: '', error: `todo_update: status должен быть одним из ${allowed.join('/')}` }
    }
    // assignee_call_id опционален — кто взял пункт (callId суба).
    const assigneeCallId = call.args.assignee_call_id !== undefined
      ? (call.args.assignee_call_id ? String(call.args.assignee_call_id) : null)
      : undefined
    try {
      ctx.sessionTodos.update(todoId, { status, assigneeCallId })
      emitTodoUpdate(ctx)
      const list = ctx.sessionTodos.list(ctx.projectPath, sessionId)
      emitActivity(ctx, call, 'ok', 'todo_update', `#${todoId}${status ? ` → ${status}` : ''}`)
      return { id: call.id, name: call.name, result: `Обновлён пункт #${todoId}.\n${formatTodoList(list)}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

const todoListHandler: ToolHandler = {
  mode: 'parallel-read',
  async handle(call, ctx) {
    if (!ctx.sessionTodos) {
      return { id: call.id, name: call.name, result: '', error: 'todo_list: TodoGate недоступен в этом контексте' }
    }
    try {
      const list = ctx.sessionTodos.list(ctx.projectPath, ctx.parentChatId ?? null)
      emitActivity(ctx, call, 'ok', 'todo_list', `${list.length} пунктов`)
      return { id: call.id, name: call.name, result: formatTodoList(list) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

// ============================================================================
// attest_verification — доказательство выполнения (DoD). Verification Фаза 2.
// Доктрина «не верь модели — перепрогони»: статус проверок ставит САМ хендлер
// по реальному exitCode, не модель. Это и отличает доказательство от отчёта.
// ============================================================================

// Потолок проверок-с-командой на один attest — чтобы агент не превратил его в
// способ прогнать 50 команд разом. Ручные проверки сверх лимита не режем.
const MAX_VERIFICATION_CHECKS = 10
// Сколько символов вывода (stdout+stderr) сохраняем в артефакт.
const VERIFICATION_TAIL_CHARS = 800

const attestVerificationHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const { writeVerificationArtifact } = await import('../ai/artifacts')
      const { computeOverall } = await import('../ai/verification')

      const taskSummary = String(call.args.task_summary ?? '').trim()
      if (!taskSummary) return { id: call.id, name: call.name, result: '', error: 'attest_verification: task_summary обязателен' }

      const claimedFiles = Array.isArray(call.args.changed_files)
        ? call.args.changed_files.map(String).map(s => s.trim()).filter(Boolean)
        : []
      const risks = Array.isArray(call.args.risks)
        ? call.args.risks.map(String).map(s => s.trim()).filter(Boolean)
        : []
      const rawChecks = Array.isArray(call.args.checks) ? call.args.checks : []

      // --- Проверки: перепрогон команд через тот же runCommand (denylist+scanner внутри).
      const checks: VerificationCheck[] = []
      let commandRuns = 0
      for (const raw of rawChecks) {
        if (typeof raw !== 'object' || raw === null) continue
        const c = raw as Record<string, unknown>
        const command = c.command != null ? String(c.command).trim() : ''
        const summary = c.summary != null ? String(c.summary).trim() : undefined

        if (!command) {
          // Ручная проверка — статус not_run, берём summary от модели.
          checks.push({ command: null, status: 'not_run', manual: true, summary })
          continue
        }

        // Денилист: классифицируем ДО запуска. Заблокированная команда → not_run+manual,
        // причина в summary (агент сам решит, что с ней делать).
        const verdict = ctx.tools.classifyCommand(command)
        if (!verdict.allowed) {
          checks.push({
            command, status: 'not_run', manual: true,
            summary: summary ? `${summary} · заблокирована: ${verdict.reason ?? 'denylist'}` : `Заблокирована политикой: ${verdict.reason ?? 'denylist'}`
          })
          continue
        }

        // Cap: сверх лимита команды не прогоняем — фиксируем как not_run.
        if (commandRuns >= MAX_VERIFICATION_CHECKS) {
          checks.push({ command, status: 'not_run', manual: true, summary: summary ? `${summary} · не запущена (лимит проверок)` : 'Не запущена — превышен лимит проверок' })
          continue
        }
        commandRuns++

        try {
          const r = await ctx.tools.runCommand(command)
          // Доктрина: статус по exitCode, не по слову модели.
          const status: VerificationCheck['status'] = r.exitCode === 0 ? 'passed' : 'failed'
          // runCommand редактирует через secret-scanner на своём пути, но прогоняем
          // ещё раз на всякий случай — tail попадает в артефакт/контекст.
          const combined = scanText(`${r.stdout}\n${r.stderr}`).redacted.trim()
          const tail = combined.length > VERIFICATION_TAIL_CHARS
            ? combined.slice(-VERIFICATION_TAIL_CHARS)
            : (combined || undefined)
          checks.push({ command, status, manual: false, summary, exitCode: r.exitCode, tail })
          // Эфемерный фидбек в Timeline чата — видно что проверка прогнана.
          ctx.sender.send('ai:event', {
            id: ctx.sendId,
            event: { type: 'tool-activity', callId: call.id, name: 'attest_verification', label: `проверка: ${status === 'passed' ? 'OK' : 'FAIL'}`, detail: `${command} · exit ${r.exitCode}`, status: status === 'passed' ? 'ok' : 'error' }
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          checks.push({ command, status: 'failed', manual: false, summary, tail: scanText(msg).redacted.slice(0, VERIFICATION_TAIL_CHARS) })
        }
      }

      // --- changed_files: сверка claimed (из args) vs actual (реально записано прогоном).
      // actualSet — снимок filesTouched из ai.ts; нормализуем пути к forward-slash для сравнения.
      const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '')
      const actualList = ctx.runFilesTouched ? ctx.runFilesTouched().map(norm) : null
      const actualSet = actualList ? new Set(actualList) : null
      const changedFiles: VerificationChangedFile[] = claimedFiles.map(p => ({
        path: p,
        claimed: true,
        // Если источник actual недоступен — считаем actual=claimed (не блокируем фазу).
        actual: actualSet ? actualSet.has(norm(p)) : true
      }))
      // Файлы, реально тронутые, но НЕ заявленные агентом — тоже в артефакт (claimed=false).
      if (actualList) {
        const claimedNorm = new Set(claimedFiles.map(norm))
        for (const a of actualList) {
          if (!claimedNorm.has(a)) changedFiles.push({ path: a, claimed: false, actual: true })
        }
      }

      // --- UI screenshot: последний browser_screenshot из pendingAttachments (image/png).
      let screenshotPath: string | undefined
      if (call.args.ui_screenshot === true) {
        const shot = [...ctx.pendingAttachments].reverse().find(a => a.mimeType === 'image/png' && a.data)
        if (shot) {
          try {
            const { artifactsDir } = await import('../ai/artifacts')
            const { mkdir, writeFile } = await import('fs/promises')
            const { join } = await import('path')
            const dir = artifactsDir(ctx.projectPath)
            await mkdir(dir, { recursive: true })
            const shotName = `verification-shot-${Date.now()}.png`
            await writeFile(join(dir, shotName), Buffer.from(shot.data, 'base64'))
            // Относительный путь — html артефакт лежит в той же папке.
            screenshotPath = shotName
          } catch { /* скриншот не критичен — пропускаем */ }
        }
      }

      const overall = computeOverall(checks)
      const art: VerificationArtifact = {
        version: 1,
        taskSummary,
        overall,
        changedFiles,
        checks,
        screenshotPath,
        risks,
        createdAt: Date.now(),
        runId: ctx.runId,
        chatId: ctx.parentChatId ?? undefined
      }

      const res = await writeVerificationArtifact(ctx.projectPath, art)
      const checksPassed = checks.filter(c => c.status === 'passed').length

      // Персист (Фаза 3): лёгкая строка истории поверх файла-артефакта. Нужна для
      // verifications.latest(chatId) в Review DoD и панели истории. Best-effort —
      // источник истины это файл, провал записи в БД не ломает attest.
      try {
        ctx.verifications?.insert({
          projectPath: ctx.projectPath,
          chatId: ctx.parentChatId ?? null,
          runId: ctx.runId ?? null,
          overall,
          checksTotal: checks.length,
          checksPassed,
          changedFilesCount: changedFiles.length,
          artifactPath: res.jsonPath,
          htmlPath: res.htmlPath,
          taskSummary,
          createdAt: art.createdAt
        })
      } catch { /* история не критична — файл-артефакт уже записан */ }

      try { ctx.recordJournal(ctx.projectPath, 'session', `${overall === 'passed' ? '✅' : overall === 'failed' ? '✗' : '⚠'} Верификация: ${overall}`, taskSummary) } catch { /* journal not critical */ }

      // artifact-created — как файл-артефакт (pill + preview), kind='verification'.
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'artifact-created', callId: call.id, kind: 'verification', filename: res.filename, path: res.htmlPath, sizeBytes: res.sizeBytes }
      })
      // verification-attested — эфемерный бейдж DoD для UI.
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'verification-attested', callId: call.id, overall, checksTotal: checks.length, checksPassed, changedFilesCount: changedFiles.length }
      })
      // Timeline задачи (Manager): событие verify со статусом overall.
      try { ctx.recordRunEvent?.('verify', { label: `DoD ${checksPassed}/${checks.length}`, detail: taskSummary, ref: res.htmlPath, status: overall }) } catch { /* best-effort */ }

      return {
        id: call.id, name: call.name,
        result: `Verification attested: overall=${overall}, DoD ${checksPassed}/${checks.length} проверок зелёные.\nАртефакт: ${res.htmlPath}\nСтатусы проверок поставлены по реальному exitCode перепрогона.`
      }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

const createPlanHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const title = String(call.args.title ?? 'План без названия')
      const rawSteps = Array.isArray(call.args.steps) ? call.args.steps : []
      const steps = rawSteps
        .filter((s: unknown): s is Record<string, unknown> => typeof s === 'object' && s !== null)
        .map((s) => ({
          title: String((s as Record<string, unknown>).title ?? ''),
          detail: (s as Record<string, unknown>).detail != null
            ? String((s as Record<string, unknown>).detail)
            : null
        }))
        .filter(s => s.title.length > 0)
      if (steps.length === 0) {
        return { id: call.id, name: call.name, result: '', error: 'create_plan: пустой список шагов' }
      }
      const plan = ctx.recordPlan(ctx.projectPath, title, steps)
      try { ctx.recordJournal(ctx.projectPath, 'note', `План: ${title}`, `${steps.length} шагов`) } catch { /* journal not critical */ }
      ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'plan-created', planId: plan.id, title, stepCount: steps.length } })
      // v3 Шаг B (enforcement): фидбэк по тонким ТЗ-шагам — модель уточнит, чтобы
      // дешёвая модель-исполнитель получила точную инструкцию, а не «улучшить X».
      const specFeedback = planSpecFeedback(steps)
      return { id: call.id, name: call.name, result: `Plan #${plan.id} created with ${steps.length} steps. User will execute/confirm in the Plan view.${specFeedback}` }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

// ============================================================================
// preflight — объявление плана перед сложной/деструктивной задачей
// ============================================================================

function toStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).map(s => s.trim()).filter(Boolean) : []
}

const preflightHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const summary = String(call.args.summary ?? '').trim()
      if (!summary) {
        return { id: call.id, name: call.name, result: '', error: 'preflight: summary обязателен' }
      }
      const rawRisk = String(call.args.risk ?? '').trim()
      const risk: 'low' | 'medium' | 'high' = rawRisk === 'high' || rawRisk === 'medium' ? rawRisk : 'low'
      const affectedZones = toStringList(call.args.affectedZones)
      const verifyAfter = toStringList(call.args.verifyAfter)
      const outOfScope = toStringList(call.args.outOfScope)
      const riskReason = String(call.args.riskReason ?? '').trim()

      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'preflight', callId: call.id, summary, affectedZones, risk, riskReason, verifyAfter, outOfScope }
      })
      try { ctx.recordJournal(ctx.projectPath, 'note', `🛫 Preflight (${risk}): ${summary.slice(0, 120)}`, affectedZones.join(', ') || null) } catch { /* journal not critical */ }
      emitActivity(ctx, call, 'ok', 'preflight', `${risk} · ${summary.slice(0, 60)}`)
      return { id: call.id, name: call.name, result: 'preflight shown — продолжай выполнение задачи по объявленному плану.' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

// ============================================================================
// Memory: memory_save / memory_search
// ============================================================================

const memorySaveHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const type = String(call.args.type ?? '')
      const content = String(call.args.content ?? '').trim()
      const tags = Array.isArray(call.args.tags) ? call.args.tags.map(String) : []
      if (!content) {
        return { id: call.id, name: call.name, result: '', error: 'memory_save: content обязателен' }
      }
      const memory = ctx.saveMemory(ctx.projectPath, type, content, tags)
      emitActivity(ctx, call, 'ok', 'memory_save', `${type} · ${content.slice(0, 60)}`)
      return { id: call.id, name: call.name, result: `Сохранено: ${memory.id}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

const memorySearchHandler: ToolHandler = {
  mode: 'parallel-read',
  async handle(call, ctx) {
    try {
      const query = String(call.args.query ?? '').trim()
      const limit = typeof call.args.limit === 'number' ? Math.max(1, Math.min(20, Math.floor(call.args.limit))) : 5
      const results = ctx.searchMemories(ctx.projectPath, query, limit)
      emitActivity(ctx, call, 'ok', 'memory_search', `"${query}" · ${results.length} результатов`)
      if (results.length === 0) {
        return { id: call.id, name: call.name, result: 'Ничего не найдено.' }
      }
      return { id: call.id, name: call.name, result: JSON.stringify(results, null, 2) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

// ============================================================================
// Core Memory: core_memory_append / core_memory_replace / core_memory_remove
// ============================================================================

const coreMemoryAppendHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const { appendCoreMemory } = await import('../ai/core-memory')
      const block = String(call.args.block ?? '')
      const content = String(call.args.content ?? '').trim()
      if (block !== 'memory' && block !== 'user') {
        return { id: call.id, name: call.name, result: '', error: 'core_memory_append: block должен быть "memory" или "user"' }
      }
      if (!content) {
        return { id: call.id, name: call.name, result: '', error: 'core_memory_append: content обязателен' }
      }
      const res = appendCoreMemory(ctx.projectPath, block, content)
      const overflowNote = res.overflow ? ' (контент обрезан по лимиту)' : ''
      emitActivity(ctx, call, 'ok', 'core_memory_append', `${block} · +${content.length} символов${overflowNote}`)
      return { id: call.id, name: call.name, result: `Добавлено в ${block}${overflowNote}.\n\nТекущее содержимое:\n${res.content}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

const coreMemoryReplaceHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const { replaceCoreMemory } = await import('../ai/core-memory')
      const block = String(call.args.block ?? '')
      const oldText = String(call.args.old_text ?? '')
      const newText = String(call.args.new_text ?? '')
      if (block !== 'memory' && block !== 'user') {
        return { id: call.id, name: call.name, result: '', error: 'core_memory_replace: block должен быть "memory" или "user"' }
      }
      if (!oldText) {
        return { id: call.id, name: call.name, result: '', error: 'core_memory_replace: old_text обязателен' }
      }
      const res = replaceCoreMemory(ctx.projectPath, block, oldText, newText)
      if (!res.success) {
        return { id: call.id, name: call.name, result: '', error: `core_memory_replace: фрагмент не найден в ${block}. Текущее содержимое:\n${res.content}` }
      }
      emitActivity(ctx, call, 'ok', 'core_memory_replace', `${block} · замена ${oldText.length} → ${newText.length} символов`)
      return { id: call.id, name: call.name, result: `Обновлено в ${block}.\n\nТекущее содержимое:\n${res.content}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

const coreMemoryRemoveHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const { removeCoreMemory } = await import('../ai/core-memory')
      const block = String(call.args.block ?? '')
      const text = String(call.args.text ?? '')
      if (block !== 'memory' && block !== 'user') {
        return { id: call.id, name: call.name, result: '', error: 'core_memory_remove: block должен быть "memory" или "user"' }
      }
      if (!text) {
        return { id: call.id, name: call.name, result: '', error: 'core_memory_remove: text обязателен' }
      }
      const res = removeCoreMemory(ctx.projectPath, block, text)
      if (!res.success) {
        return { id: call.id, name: call.name, result: '', error: `core_memory_remove: фрагмент не найден в ${block}. Текущее содержимое:\n${res.content}` }
      }
      emitActivity(ctx, call, 'ok', 'core_memory_remove', `${block} · удалено ${text.length} символов`)
      return { id: call.id, name: call.name, result: `Удалено из ${block}.\n\nТекущее содержимое:\n${res.content}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

// ============================================================================
// check_diagnostics — tsc --noEmit, возвращает структурированный список ошибок
// ============================================================================

/**
 * Parse a single line of `tsc --noEmit --pretty false` output.
 * Format: path(line,col): error TSxxxx: message
 * Returns null if the line doesn't match.
 */
function parseTscLine(line: string): { path: string; line: number; col: number; code: string; message: string } | null {
  // Windows paths: C:\...\foo.ts(10,5): error TS2345: ...
  // Unix paths:    src/foo.ts(10,5): error TS2345: ...
  const m = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/.exec(line.trim())
  if (!m) return null
  return { path: m[1], line: parseInt(m[2], 10), col: parseInt(m[3], 10), code: m[4], message: m[5] }
}

export function buildRemoteTscCommand(): string {
  return [
    'if [ ! -f tsconfig.json ]; then',
    'echo __VERSTAK_NO_TSCONFIG__;',
    'elif [ -x ./node_modules/.bin/tsc ]; then',
    './node_modules/.bin/tsc --noEmit --pretty false;',
    'else',
    'npx tsc --noEmit --pretty false;',
    'fi'
  ].join(' ')
}

const checkDiagnosticsHandler: ToolHandler = {
  mode: 'parallel-read',
  async handle(call, ctx) {
    const fileFilter = call.args.file ? String(call.args.file) : null
    const sshTarget = parseSshProjectPath(ctx.projectPath)

    if (sshTarget) {
      let stdout = ''
      let stderr = ''
      let exitCode: number | null = 0

      try {
        const backend = createSshBackend(sshTarget.remoteRoot, makeSshExec(sshTarget, ctx.signal))
        const res = await backend.runCommand(buildRemoteTscCommand())
        stdout = res.stdout
        stderr = res.stderr
        exitCode = res.exitCode
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        emitActivity(ctx, call, 'error', 'check_diagnostics', msg)
        return { id: call.id, name: call.name, result: '', error: `Не удалось выполнить SSH TypeScript diagnostics: ${msg}` }
      }

      if (stdout.includes('__VERSTAK_NO_TSCONFIG__')) {
        emitActivity(ctx, call, 'ok', 'check_diagnostics', 'SSH: нет tsconfig.json')
        return { id: call.id, name: call.name, result: 'SSH-проект: tsconfig.json не найден на удалённой стороне. TypeScript diagnostics пропущена.' }
      }

      const allOutput = (stdout + '\n' + stderr).split('\n')
      const errors = allOutput
        .map(parseTscLine)
        .filter((e): e is NonNullable<typeof e> => e !== null)

      const filtered = fileFilter
        ? errors.filter(e => e.path.replace(/\\/g, '/').includes(fileFilter.replace(/\\/g, '/')))
        : errors

      const raw = (stdout + '\n' + stderr).trim()
      if (filtered.length === 0 && exitCode !== 0) {
        const detail = raw.slice(0, 4000) || `exitCode=${exitCode ?? 'unknown'}`
        emitActivity(ctx, call, 'error', 'check_diagnostics', 'SSH: tsc не выполнен')
        try {
          ctx.recordRunEvent?.('verify', {
            label: 'check_diagnostics',
            detail: 'SSH TypeScript diagnostics не выполнена',
            status: 'fail'
          })
        } catch { /* best-effort */ }
        return { id: call.id, name: call.name, result: `SSH TypeScript diagnostics не выполнена или не дала распознаваемых ошибок:\n\n${detail}` }
      }

      emitActivity(ctx, call, 'ok', 'check_diagnostics', `SSH: ${filtered.length} ошибок${fileFilter ? ` в ${fileFilter}` : ''}`)
      try {
        ctx.recordRunEvent?.('verify', {
          label: 'check_diagnostics',
          detail: `SSH: ${filtered.length} ошибок TypeScript${fileFilter ? ` в ${fileFilter}` : ''}`,
          status: filtered.length === 0 ? 'pass' : 'fail'
        })
      } catch { /* best-effort */ }

      if (filtered.length === 0) {
        return { id: call.id, name: call.name, result: '✅ Нет ошибок TypeScript на SSH-проекте.' }
      }

      const lines = filtered.map(e => `${e.path}:${e.line}:${e.col} — ${e.code}: ${e.message}`)
      const header = `Found ${filtered.length} error${filtered.length === 1 ? '' : 's'}:`
      return { id: call.id, name: call.name, result: `${header}\n\n${lines.join('\n')}` }
    }

    // Проверяем наличие tsconfig.json — если нет, возвращаем понятное сообщение
    const tsconfigPath = join(ctx.projectPath, 'tsconfig.json')
    if (!existsSync(tsconfigPath)) {
      emitActivity(ctx, call, 'ok', 'check_diagnostics', 'нет tsconfig.json')
      return { id: call.id, name: call.name, result: 'tsconfig.json не найден — проект не TypeScript или tsconfig в нестандартном месте.' }
    }

    // Ищем tsc из node_modules проекта, чтобы не требовать глобальной установки
    const localTsc = join(ctx.projectPath, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
    const tscBin = existsSync(localTsc) ? localTsc : 'npx'
    const tscArgs = tscBin === 'npx'
      ? ['tsc', '--noEmit', '--pretty', 'false']
      : ['--noEmit', '--pretty', 'false']

    let stdout = ''
    let stderr = ''
    try {
      const res = await execFileAsync(tscBin, tscArgs, {
        cwd: ctx.projectPath,
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024
      })
      stdout = res.stdout
      stderr = res.stderr
    } catch (err) {
      // tsc exits with non-zero when there are errors — that's expected.
      // We still want to parse the output.
      const e = err as { stdout?: string; stderr?: string; code?: number; message?: string }
      stdout = e.stdout ?? ''
      stderr = e.stderr ?? ''
      // If it's a real spawn error (ENOENT / EACCES), stderr will be empty and message will describe it
      if (!stdout && !stderr && e.message) {
        emitActivity(ctx, call, 'error', 'check_diagnostics', e.message)
        return { id: call.id, name: call.name, result: '', error: `Не удалось запустить tsc: ${e.message}` }
      }
    }

    const allOutput = (stdout + '\n' + stderr).split('\n')
    const errors = allOutput
      .map(parseTscLine)
      .filter((e): e is NonNullable<typeof e> => e !== null)

    const filtered = fileFilter
      ? errors.filter(e => e.path.replace(/\\/g, '/').includes(fileFilter.replace(/\\/g, '/')))
      : errors

    emitActivity(ctx, call, 'ok', 'check_diagnostics', `${filtered.length} ошибок${fileFilter ? ` в ${fileFilter}` : ''}`)
    // Timeline задачи (Фаза 4): check_diagnostics — это верификация. 0 ошибок →
    // pass, иначе fail (waiting_review вычисляется из последнего verify=fail).
    try {
      ctx.recordRunEvent?.('verify', {
        label: 'check_diagnostics',
        detail: `${filtered.length} ошибок TypeScript${fileFilter ? ` в ${fileFilter}` : ''}`,
        status: filtered.length === 0 ? 'pass' : 'fail'
      })
    } catch { /* best-effort */ }

    if (filtered.length === 0) {
      return { id: call.id, name: call.name, result: '✅ Нет ошибок TypeScript.' }
    }

    const lines = filtered.map(e => `${e.path}:${e.line}:${e.col} — ${e.code}: ${e.message}`)
    const header = `Found ${filtered.length} error${filtered.length === 1 ? '' : 's'}:`
    return { id: call.id, name: call.name, result: `${header}\n\n${lines.join('\n')}` }
  }
}

// ============================================================================
// conversation_search — FTS5 search across past chat messages
// ============================================================================

const conversationSearchHandler: ToolHandler = {
  mode: 'parallel-read',
  async handle(call, ctx) {
    try {
      const query = String(call.args.query ?? '').trim()
      const limit = typeof call.args.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(call.args.limit))) : 10
      const results = ctx.searchConversations(ctx.projectPath, query, limit)
      emitActivity(ctx, call, 'ok', 'conversation_search', `"${query}" · ${results.length} результатов`)
      if (results.length === 0) {
        return { id: call.id, name: call.name, result: 'Ничего не найдено в истории разговоров.' }
      }
      const lines: string[] = [`Found ${results.length} results:\n`]
      for (const r of results) {
        const date = new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 16)
        lines.push(`[Session #${r.session_id}, ${date}] ${r.role}:\n${r.content}\n`)
      }
      return { id: call.id, name: call.name, result: lines.join('\n') }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

// ============================================================================
// convert_file — конвертация не-текстовых форматов в markdown/text
// ============================================================================

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
      const { safeRealJoin } = await import('../ai/path-policy')
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

// ============================================================================
// impact_analysis — Feature 6: что сломается при изменении файла/символа
// ============================================================================

const impactAnalysisHandler: ToolHandler = {
  mode: 'parallel-read',
  async handle(call, ctx) {
    try {
      const { getDependencyMap } = await import('../ai/project-map')
      const { readFile } = await import('fs/promises')
      const { safeRealJoin } = await import('../ai/path-policy')

      const file = String(call.args.file ?? '').replace(/\\/g, '/')
      if (!file) {
        return { id: call.id, name: call.name, result: '', error: 'impact_analysis: file обязателен' }
      }
      const symbol = call.args.symbol ? String(call.args.symbol) : null

      const depMap = await getDependencyMap(ctx.projectPath)
      const fileInfo = depMap.files[file]
      if (!fileInfo) {
        // Try to find a close match (with/without extension)
        const candidates = Object.keys(depMap.files).filter(k =>
          k === file || k.startsWith(file + '.') || k.startsWith(file + '/index.')
        )
        if (candidates.length === 0) {
          return { id: call.id, name: call.name, result: `Файл "${file}" не найден в dependency map. Убедись что путь корректный (относительно корня проекта).` }
        }
        // Re-run with the first candidate
        call = { ...call, args: { ...call.args, file: candidates[0] } }
        return impactAnalysisHandler.handle(call, ctx)
      }

      const direct = fileInfo.importedBy
      // Transitive level 2 (max depth 3 total)
      const level2: Map<string, string[]> = new Map()  // file → via which direct dep
      for (const d of direct) {
        const dInfo = depMap.files[d]
        if (!dInfo) continue
        for (const d2 of dInfo.importedBy) {
          if (d2 !== file && !direct.includes(d2)) {
            if (!level2.has(d2)) level2.set(d2, [])
            level2.get(d2)!.push(d)
          }
        }
      }
      const level3: Map<string, string[]> = new Map()  // file → via which l2 dep
      for (const [l2file] of level2) {
        const l2Info = depMap.files[l2file]
        if (!l2Info) continue
        for (const d3 of l2Info.importedBy) {
          if (d3 !== file && !direct.includes(d3) && !level2.has(d3)) {
            if (!level3.has(d3)) level3.set(d3, [])
            level3.get(d3)!.push(l2file)
          }
        }
      }

      const lines: string[] = [`📁 ${file}`]
      if (fileInfo.exports.length > 0) {
        lines.push(`\nЭкспорты: ${fileInfo.exports.join(', ')}`)
      }

      if (direct.length === 0 && level2.size === 0) {
        lines.push('\nНет зависимых файлов — файл ни кем не импортируется.')
      } else {
        lines.push(`\nПрямые зависимости (импортируют этот файл):`)
        if (direct.length === 0) {
          lines.push('  (нет)')
        } else {
          for (const d of direct) lines.push(`  → ${d}`)
        }

        if (level2.size > 0) {
          lines.push(`\nТранзитивные (2-й уровень):`)
          for (const [f, vias] of level2) {
            lines.push(`  → ${f} (через ${vias.join(', ')})`)
          }
        }

        if (level3.size > 0) {
          lines.push(`\nТранзитивные (3-й уровень):`)
          for (const [f, vias] of level3) {
            lines.push(`  → ${f} (через ${vias.join(', ')})`)
          }
        }
      }

      // Symbol search — grep for usage in dependent files
      if (symbol) {
        const symbolHits: string[] = []
        const allDeps = [...direct, ...Array.from(level2.keys()), ...Array.from(level3.keys())]
        for (const dep of allDeps) {
          try {
            const abs = await safeRealJoin(ctx.projectPath, dep)
            const content = await readFile(abs, 'utf8')
            const depLines = content.split('\n')
            for (let i = 0; i < depLines.length; i++) {
              if (depLines[i].includes(symbol)) {
                const snippet = depLines[i].trim().slice(0, 120)
                symbolHits.push(`  → ${dep}:${i + 1} — ${snippet}`)
                break  // one hit per file is enough for overview
              }
            }
          } catch { /* skip unreadable files */ }
        }
        if (symbolHits.length > 0) {
          lines.push(`\nИспользуют символ "${symbol}":`)
          lines.push(...symbolHits)
        } else {
          lines.push(`\nСимвол "${symbol}" не найден в зависимых файлах.`)
        }
      }

      emitActivity(ctx, call, 'ok', 'impact_analysis', `${file} · ${direct.length} прямых зависимостей`)
      return { id: call.id, name: call.name, result: lines.join('\n') }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}

// ============================================================================
// Screen: screen_capture / screen_info
// ============================================================================

const screenCaptureHandler: ToolHandler = {
  mode: 'parallel-read',
  async handle(call, ctx) {
    try {
      // desktopCapturer and screen are Electron main-process APIs — they are
      // not available in Node.js / vitest environments, so we guard carefully.
      const { desktopCapturer, screen: electronScreen } = await import('electron')
      const target = call.args.target === 'window' ? 'window' : 'screen'

      let dataUrl: string | null = null
      let width = 0
      let height = 0

      if (target === 'screen') {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1920, height: 1080 }
        })
        if (sources.length === 0) {
          return { id: call.id, name: call.name, result: 'Не удалось захватить экран — источников не найдено' }
        }
        const img = sources[0].thumbnail
        dataUrl = img.toDataURL()
        const sz = img.getSize()
        width = sz.width
        height = sz.height
      } else {
        // window — захват окна Verstak через screen source
        const primary = electronScreen.getPrimaryDisplay()
        const sources = await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: { width: primary.size.width, height: primary.size.height }
        })
        // Ищем окно Verstak по имени (title / FileDescription: VERSTAK, Verstak, Electron в dev)
        const win = sources.find(s => /verstak|electron/i.test(s.name)) ?? sources[0]
        if (!win) {
          return { id: call.id, name: call.name, result: 'Не найдено окно для захвата' }
        }
        const img = win.thumbnail
        dataUrl = img.toDataURL()
        const sz = img.getSize()
        width = sz.width
        height = sz.height
      }

      // Attach image to next AI message (same pattern as browser_screenshot)
      if (dataUrl && dataUrl.startsWith('data:image/')) {
        const m = /^data:(image\/[\w+-]+);base64,(.+)$/.exec(dataUrl)
        if (m) {
          ctx.pendingAttachments.push({
            name: `screen-${Date.now()}.png`,
            mimeType: m[1],
            data: m[2],
            size: Math.floor(m[2].length * 0.75)
          })
        }
      }

      emitActivity(ctx, call, 'ok', 'screen_capture', `${target} ${width}x${height}`)
      return {
        id: call.id,
        name: call.name,
        result: { target, width, height, attached: true, timestamp: Date.now() }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', 'screen_capture', msg)
      return { id: call.id, name: call.name, result: '', error: `screen_capture недоступен: ${msg}` }
    }
  }
}

const screenInfoHandler: ToolHandler = {
  mode: 'parallel-read',
  async handle(call, ctx) {
    try {
      const { screen: electronScreen } = await import('electron')
      const primary = electronScreen.getPrimaryDisplay()
      const displays = electronScreen.getAllDisplays()
      const lines = displays.map((d, i) => {
        const tag = d.id === primary.id ? ' [primary]' : ''
        return `Monitor ${i + 1}: ${d.size.width}x${d.size.height} (scale ${d.scaleFactor}x) pos=(${d.bounds.x},${d.bounds.y})${tag}`
      })
      const result = lines.join('\n')
      emitActivity(ctx, call, 'ok', 'screen_info', `${displays.length} мониторов`)
      return { id: call.id, name: call.name, result }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', 'screen_info', msg)
      return { id: call.id, name: call.name, result: '', error: `screen_info недоступен: ${msg}` }
    }
  }
}

// ============================================================================
// MCP tool handler — роутит вызов к mcpClient
// ============================================================================

const mcpToolHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    if (!ctx.mcpClient) {
      return { id: call.id, name: call.name, result: '', error: 'MCP client not available' }
    }
    // Определяем serverId: ищем tool среди всех подключённых серверов по имени
    const allMcpTools = ctx.mcpClient.getAllTools()
    const matchedTool = allMcpTools.find(t => t.name === call.name)
    if (!matchedTool) {
      return { id: call.id, name: call.name, result: '', error: `MCP tool "${call.name}" not found in connected servers` }
    }
    // Mode policy: внешние MCP-тулзы — не локальные правки, а side-effects на чужих
    // серверах. Гейтим их так же, как connector_query: scope тулза классифицируем
    // по name + description (read → авто, write/command/network/unknown → команда),
    // затем mcpDecision(scope, mode) даёт block/confirm/auto-accept.
    const scope = classifyMcpToolScope(matchedTool.name, matchedTool.description)
    const decision = mcpDecision(scope, ctx.agentMode)
    // Короткая сводка аргументов для модалки подтверждения (без раскрытия больших значений)
    const argKeys = Object.keys(call.args ?? {})
    const argsSummary = argKeys.length ? argKeys.join(', ') : ''
    const summary = `MCP ${call.name}${argsSummary ? ` · ${argsSummary}` : ''}`
    if (decision === 'block') {
      const reason = mcpBlockReason(call.name, scope, ctx.agentMode)
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-blocked', callId: call.id, name: call.name, command: summary, reason }
      })
      return { id: call.id, name: call.name, result: '', error: reason }
    }
    if (decision === 'confirm') {
      // 'confirm' — переиспользуем pending-command поток (та же модалка подтверждения)
      ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'pending-command', callId: call.id, command: summary } })
      const accepted = await awaitCommandConfirm(ctx, call.id)
      if (!accepted) {
        ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'command-result', callId: call.id, command: summary, status: 'rejected' } })
        return { id: call.id, name: call.name, result: summary, error: 'User rejected' }
      }
    }
    try {
      emitActivity(ctx, call, 'ok', `mcp:${call.name}`, matchedTool.serverId)
      const result = await ctx.mcpClient.callTool(matchedTool.serverId, call.name, call.args)
      // Редактируем вывод внешнего MCP-сервера — он не доверенный, может вернуть
      // токены/ключи, которые иначе утекут в контекст модели.
      const raw = typeof result === 'string' ? result : JSON.stringify(result)
      return { id: call.id, name: call.name, result: scanText(raw).redacted }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', `mcp:${call.name}`, scanText(msg).redacted)
      return { id: call.id, name: call.name, result: '', error: scanText(msg).redacted }
    }
  }
}

// ============================================================================
// Office: read_spreadsheet / read_document / edit_spreadsheet — «beyond code»
// ============================================================================

// Чтение xlsx/docx — pure-info, идёт через generic readHandler (ctx.tools.execute).
// Здесь только edit_spreadsheet: WRITE-операция, гейтится mode-policy как write_file.
// Diff текстом не показываем (xlsx бинарный) — подтверждаем через ту же модалку
// команды (pending-command), показывая список правок ячеек.

const editSpreadsheetHandler: ToolHandler = {
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

      const { editSpreadsheet } = await import('../ai/office')
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

// ============================================================================
// Registry — single source of truth for tool dispatch
// ============================================================================

const HANDLER_REGISTRY: Record<string, ToolHandler> = {
  // Confirm-write — go through the diff modal
  'write_file': writeFileHandler,
  'apply_patch': applyPatchHandler,
  'propose_edits': proposeEditsHandler,
  // Sequential, side-effecting
  'run_command': runCommandHandler,
  'browser_navigate': browserHandler,
  'browser_read_page': browserHandler,
  'browser_screenshot': browserHandler,
  'list_connectors': listConnectorsHandler,
  'connector_query': connectorQueryHandler,
  'create_plan': createPlanHandler,
  // TodoGate (Фаза 3) — оркестрационный todo-лист сессии
  'todo_create': todoCreateHandler,
  'todo_update': todoUpdateHandler,
  'todo_list': todoListHandler,
  'preflight': preflightHandler,
  'read_journal': readJournalHandler,
  'generate_html': generateHtmlHandler,
  'generate_docx': generateDocxHandler,
  'render_chart': renderChartHandler,
  // Verification Artifact (DoD) — перепрогон проверок, статус по exitCode
  'attest_verification': attestVerificationHandler,
  'delegate_task': delegateTaskHandler,
  'delegate_parallel': delegateParallelHandler,
  'orchestrate': orchestrateHandler,
  // Agent Swarms (Фаза 4, Идея 10) — рой агентов с консенсусом-арбитром
  'swarm': swarmHandler,
  'memory_save': memorySaveHandler,
  'memory_search': memorySearchHandler,
  // Core Memory (Hermes-style) — sequential, file-backed, no user confirmation
  'core_memory_append': coreMemoryAppendHandler,
  'core_memory_replace': coreMemoryReplaceHandler,
  'core_memory_remove': coreMemoryRemoveHandler,
  // Diagnostics — parallel-read, no user confirmation needed
  'check_diagnostics': checkDiagnosticsHandler,
  // Code intelligence — parallel-read
  'impact_analysis': impactAnalysisHandler,
  // Conversation history search — parallel-read, FTS5
  'conversation_search': conversationSearchHandler,
  // File conversion — parallel-read, no user confirmation needed
  'convert_file': convertFileHandler,
  // Screen capture — parallel-read, Electron desktopCapturer
  'screen_capture': screenCaptureHandler,
  'screen_info': screenInfoHandler,
  // Office «beyond code» — чтение parallel-read (через readHandler), правка confirm-write
  'read_spreadsheet': readHandler,
  'read_document': readHandler,
  'edit_spreadsheet': editSpreadsheetHandler
}

/**
 * Look up the handler for a tool call. Falls back to the generic parallel-read
 * handler (which calls into ctx.tools.execute) for anything not explicitly
 * registered — that's the safe default for new pure-info tools.
 *
 * MCP tools: если имя не найдено в registry и передан ctx.mcpClient —
 * роутим к mcpToolHandler. Так как lookupHandler не имеет ctx, проверка
 * происходит в mcpToolHandler.handle через поиск в mcpClient.getAllTools().
 */
export function lookupHandler(name: string, ctx?: { mcpClient?: import('../mcp/client').McpClient }): ToolHandler {
  const registered = HANDLER_REGISTRY[name]
  if (registered) return registered
  // Если есть mcpClient и инструмент среди MCP tools — роутим к MCP handler
  if (ctx?.mcpClient) {
    const allMcpTools = ctx.mcpClient.getAllTools()
    if (allMcpTools.some(t => t.name === name)) {
      return mcpToolHandler
    }
  }
  return readHandler
}
