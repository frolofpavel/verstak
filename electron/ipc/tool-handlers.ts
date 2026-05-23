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
import type { Attachment, ToolCall, ToolResult } from '../ai/types'
import { applySearchReplaceBlocks, type FileTools } from '../ai/tools'
import { decide, blockReason, type AgentMode } from '../ai/mode-policy'

// ============================================================================
// Types
// ============================================================================

/** Stable identifier for an in-flight `ai:send` call. */
export type SendId = number

export interface TaggedSender {
  send: (channel: string, payload: { id: SendId; event: unknown }) => void
  exec: (code: string) => Promise<unknown>
}

export interface ConnectorRegistry {
  list: () => Array<{ id: string; label: string; kind: string; status: string; detail?: string }>
  query: (id: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
}

/** Context every tool handler receives. */
export interface ToolContext {
  sender: TaggedSender
  sendId: SendId
  signal: AbortSignal
  projectPath: string
  tools: FileTools
  recordWrite: (projectPath: string, filePath: string, before: string, after: string) => void
  recordPlan: (projectPath: string, title: string, steps: Array<{ title: string; detail?: string | null }>) => { id: number }
  recordJournal: (projectPath: string, kind: 'tool' | 'session' | 'note', title: string, detail?: string | null) => void
  /** Read recent journal entries — used by the `read_journal` AI tool for self-reflection. */
  readJournal: (projectPath: string, limit: number) => Array<{ kind: string; title: string; detail: string | null; createdAt: number }>
  connectors: ConnectorRegistry
  /** Mutated by browser_screenshot; flushed by the agent loop into next user msg. */
  pendingAttachments: Attachment[]
  /** Shared maps used by the diff-confirm flow. */
  pendingWrites: Map<string, { sendId: SendId; resolve: (accept: boolean) => void }>
  pendingCommands: Map<string, { sendId: SendId; resolve: (accept: boolean) => void }>
  scopedKey: (sendId: SendId, callId: string) => string
  /** Active agent mode — controls auto-accept / confirm / block per tool. */
  agentMode: AgentMode
  /** Skill registry для delegate_task (опционально — V3 фича). */
  skillRegistry?: {
    list: () => Array<{ id: string; name?: string; default_provider?: string; default_model?: string; systemPrompt: string }>
  }
  /** Secret reader для delegate_task — нужен чтобы достать API key
   *  альтернативного провайдера. */
  getSecretForDelegate?: (key: string) => string | null
}

export type ToolMode = 'parallel-read' | 'sequential' | 'confirm-write'

export interface ToolHandler {
  mode: ToolMode
  handle(call: ToolCall, ctx: ToolContext): Promise<ToolResult>
}

// ============================================================================
// Activity event helper
// ============================================================================

function emitActivity(ctx: ToolContext, call: ToolCall, status: 'ok' | 'error', label: string, detail: string): void {
  ctx.sender.send('ai:event', {
    id: ctx.sendId,
    event: { type: 'tool-activity', callId: call.id, name: call.name, label, detail, status }
  })
}

/** Short human-readable summary of a tool call for the activity stream. */
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
    // 'confirm' — show diff modal and wait
    ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'pending-write', callId: call.id, path, before, after } })
    accepted = await new Promise<boolean>(resolve => {
      ctx.pendingWrites.set(ctx.scopedKey(ctx.sendId, call.id), { sendId: ctx.sendId, resolve })
    })
  }
  if (!accepted) {
    return { id: call.id, name: call.name, result: `User rejected write to ${path}`, error: 'User rejected' }
  }
  try {
    await ctx.tools.execute('write_file', { path, content: after })
    try { ctx.recordWrite(ctx.projectPath, path, before, after) } catch { /* undo not critical */ }
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
    let after: string
    try {
      after = applySearchReplaceBlocks(before, String(call.args.diff ?? ''))
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
    return {
      id: call.id,
      name: call.name,
      result: `Applied ${ok}/${total} edits. ${subResults.map(r => r.error ? `✗ ${r.error}` : `✓ ${r.result}`).join('; ')}`,
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
      accepted = await new Promise<boolean>(resolve => {
        ctx.pendingCommands.set(ctx.scopedKey(ctx.sendId, call.id), { sendId: ctx.sendId, resolve })
      })
    }
    if (!accepted) {
      ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'command-result', callId: call.id, command, status: 'rejected' } })
      return { id: call.id, name: call.name, result: `Command: ${command}`, error: 'User rejected' }
    }
    try {
      const result = await ctx.tools.runCommand(command)
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'command-result', callId: call.id, command, status: 'ok', exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
      })
      return { id: call.id, name: call.name, result }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'command-result', callId: call.id, command, status: 'error', error: msg }
      })
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
      const api = window.geminigrokBrowser;
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
      const { id: _omit, ...rest } = call.args as Record<string, unknown> & { id?: unknown }
      void _omit
      const result = await ctx.connectors.query(cid, rest, ctx.signal)
      const s = summarizeToolCall(call.name, call.args, undefined)
      if (s) emitActivity(ctx, call, 'ok', s.label, s.detail)
      // Journal connector queries
      try {
        const entity = call.args.entity ? ` · ${call.args.entity}` : ''
        const path = call.args.path ? ` · ${call.args.path}` : ''
        ctx.recordJournal(ctx.projectPath, 'tool', `Коннектор ${cid}${entity}${path}`, null)
      } catch { /* journal not critical */ }
      return { id: call.id, name: call.name, result: typeof result === 'string' ? result : JSON.stringify(result) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitActivity(ctx, call, 'error', call.name, msg)
      try { ctx.recordJournal(ctx.projectPath, 'tool', `Коннектор упал: ${String(call.args.id ?? '?')}`, msg) } catch { /* journal not critical */ }
      return { id: call.id, name: call.name, result: '', error: msg }
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
// delegate_task — мультиагент V1
// ============================================================================

const delegateTaskHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const skillId = call.args.skill_id ? String(call.args.skill_id) : null
      const providerOverride = call.args.provider_id ? String(call.args.provider_id) : null
      const modelOverride = call.args.model ? String(call.args.model) : null
      const prompt = String(call.args.prompt ?? '').trim()
      if (!prompt) {
        return { id: call.id, name: call.name, result: '', error: 'delegate_task: prompt обязателен' }
      }

      // Скилл — опционально. Если задан, тащим его системный промпт + default provider/model.
      const skills = ctx.skillRegistry ? ctx.skillRegistry.list() : []
      const skill = skillId ? skills.find(s => s.id === skillId) ?? null : null

      const subProvider = providerOverride
        ?? skill?.default_provider
        ?? null  // null → ai:send возьмёт текущий default из settings
      const subModel = modelOverride ?? skill?.default_model ?? null
      const systemPrompt = skill?.systemPrompt
        ?? 'Ты — sub-agent. Выполни узкую задачу, ответь в 1-3 параграфа. Без лишних tools / markdown.'

      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: {
          type: 'tool-activity',
          callId: call.id,
          name: 'delegate_task',
          label: 'delegate_task',
          detail: `${skill?.name ?? skillId ?? 'generic'} via ${subProvider ?? 'auto'}`,
          status: 'ok'
        }
      })

      // Внутренний one-shot call — реализуем через прямой вызов provider'а,
      // без новой ipc-сессии (никаких дополнительных sendId, событий, и т.п.).
      const { createProvider, PROVIDERS } = await import('../ai/registry')
      const fallbackProvider = subProvider ?? 'claude'
      const descriptor = PROVIDERS[fallbackProvider as keyof typeof PROVIDERS]
      if (!descriptor) {
        return { id: call.id, name: call.name, result: '', error: `delegate_task: неизвестный provider ${fallbackProvider}` }
      }
      const apiKey = descriptor.secretKey ? ctx.getSecretForDelegate?.(descriptor.secretKey) ?? null : null
      if (descriptor.secretKey && !apiKey) {
        return { id: call.id, name: call.name, result: '', error: `delegate_task: нет API key для ${fallbackProvider}` }
      }
      const provider = createProvider(fallbackProvider as keyof typeof PROVIDERS, {
        apiKey,
        model: subModel ?? descriptor.defaultModel,
        cwd: ctx.projectPath,
        signal: ctx.signal
      })
      const messages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: prompt }
      ]
      let collected = ''
      try {
        for await (const event of provider.send(messages, [])) {
          if (ctx.signal.aborted) break
          if (event.type === 'text' && typeof event.text === 'string') collected += event.text
          else if (event.type === 'error') {
            return { id: call.id, name: call.name, result: '', error: `delegate_task error: ${event.message}` }
          } else if (event.type === 'done') break
        }
      } catch (err) {
        return { id: call.id, name: call.name, result: '', error: `delegate_task crashed: ${err instanceof Error ? err.message : String(err)}` }
      }
      const trimmed = collected.trim()
      if (!trimmed) {
        return { id: call.id, name: call.name, result: '', error: 'delegate_task: sub-agent вернул пустой ответ' }
      }
      // Логируем в journal — для аудита
      try {
        ctx.recordJournal(ctx.projectPath, 'note',
          `🎭 Делегирование → ${skill?.name ?? skillId ?? fallbackProvider}`,
          `Запрос: ${prompt.slice(0, 200)}\n---\nОтвет: ${trimmed.slice(0, 600)}${trimmed.length > 600 ? '…' : ''}`)
      } catch { /* journal не критично */ }
      return { id: call.id, name: call.name, result: `[Delegate from ${skill?.name ?? skillId ?? fallbackProvider}]\n\n${trimmed}` }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

// ============================================================================
// Artifact handlers — generate_html / generate_docx
// ============================================================================

const renderChartHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const { renderChartSvg } = await import('../ai/charts')
      const { artifactsDir } = await import('../ai/artifacts')
      const { mkdir, writeFile } = await import('fs/promises')
      const { join } = await import('path')
      const filename = String(call.args.filename ?? 'chart').replace(/[^a-zA-Z0-9а-яА-ЯёЁ_\-.,()\s]/g, '_').slice(0, 100) + '.svg'
      const kind = String(call.args.kind ?? 'bar') as 'bar' | 'line' | 'pie'
      const labels = Array.isArray(call.args.labels) ? call.args.labels.map(String) : []
      const values = Array.isArray(call.args.values) ? call.args.values.map(Number) : []
      if (labels.length === 0 || labels.length !== values.length) {
        return { id: call.id, name: call.name, result: '', error: 'render_chart: labels и values должны быть одинаковой длины и непустые' }
      }
      const svg = renderChartSvg({
        kind, labels, values,
        title: call.args.title ? String(call.args.title) : undefined,
        xAxisLabel: call.args.x_axis_label ? String(call.args.x_axis_label) : undefined,
        yAxisLabel: call.args.y_axis_label ? String(call.args.y_axis_label) : undefined
      })
      const dir = artifactsDir(ctx.projectPath)
      await mkdir(dir, { recursive: true })
      const path = join(dir, filename)
      await writeFile(path, svg, 'utf8')
      try { ctx.recordJournal(ctx.projectPath, 'tool', `📊 Диаграмма ${kind}: ${filename}`, `${svg.length} bytes → ${path}`) } catch { /* */ }
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-activity', callId: call.id, name: 'render_chart', label: 'render_chart', detail: `${filename} · ${kind} · ${labels.length} точек`, status: 'ok' }
      })
      return { id: call.id, name: call.name, result: `Chart saved: ${path}\nKind: ${kind}, ${labels.length} data points.\nИспользуй в HTML: <img src="${filename}"> (относительно той же папки артефактов).` }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

const generateHtmlHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const { generateHtml } = await import('../ai/artifacts')
      const filename = String(call.args.filename ?? 'untitled')
      const title = call.args.title ? String(call.args.title) : undefined
      const content = String(call.args.content_html ?? '')
      if (!content) return { id: call.id, name: call.name, result: '', error: 'generate_html: content_html обязателен' }
      const res = await generateHtml(ctx.projectPath, { filename, title, content_html: content })
      try { ctx.recordJournal(ctx.projectPath, 'tool', `📄 Артефакт HTML: ${res.filename}`, `${res.sizeBytes} bytes → ${res.path}`) } catch { /* */ }
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-activity', callId: call.id, name: 'generate_html', label: 'generate_html', detail: `${res.filename} · ${(res.sizeBytes / 1024).toFixed(1)}KB`, status: 'ok' }
      })
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'artifact-created', callId: call.id, kind: 'html', filename: res.filename, path: res.path, sizeBytes: res.sizeBytes }
      })
      return { id: call.id, name: call.name, result: `HTML artifact saved: ${res.path}\nSize: ${res.sizeBytes} bytes` }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

const generateDocxHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    try {
      const { generateDocx } = await import('../ai/artifacts')
      const filename = String(call.args.filename ?? 'untitled')
      const title = call.args.title ? String(call.args.title) : undefined
      const sections = Array.isArray(call.args.sections) ? call.args.sections as Array<{ heading?: string; level?: number; paragraphs?: string[]; bullets?: string[] }> : []
      if (sections.length === 0) return { id: call.id, name: call.name, result: '', error: 'generate_docx: sections обязательны (>= 1)' }
      const res = await generateDocx(ctx.projectPath, { filename, title, sections })
      try { ctx.recordJournal(ctx.projectPath, 'tool', `📄 Артефакт DOCX: ${res.filename}`, `${res.sizeBytes} bytes → ${res.path}`) } catch { /* */ }
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-activity', callId: call.id, name: 'generate_docx', label: 'generate_docx', detail: `${res.filename} · ${(res.sizeBytes / 1024).toFixed(1)}KB`, status: 'ok' }
      })
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'artifact-created', callId: call.id, kind: 'docx', filename: res.filename, path: res.path, sizeBytes: res.sizeBytes }
      })
      return { id: call.id, name: call.name, result: `DOCX artifact saved: ${res.path}\nSize: ${res.sizeBytes} bytes` }
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
      return { id: call.id, name: call.name, result: `Plan #${plan.id} created with ${steps.length} steps. User will execute/confirm in the Plan view.` }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
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
  'read_journal': readJournalHandler,
  'generate_html': generateHtmlHandler,
  'generate_docx': generateDocxHandler,
  'render_chart': renderChartHandler,
  'delegate_task': delegateTaskHandler
}

/**
 * Look up the handler for a tool call. Falls back to the generic parallel-read
 * handler (which calls into ctx.tools.execute) for anything not explicitly
 * registered — that's the safe default for new pure-info tools.
 */
export function lookupHandler(name: string): ToolHandler {
  return HANDLER_REGISTRY[name] ?? readHandler
}
