import { ipcMain } from 'electron'
import { createFileTools, TOOL_DEFS } from '../ai/tools'
import { createProvider, PROVIDERS, type ProviderId } from '../ai/registry'
import { loadUserLayer } from '../ai/user-layer'
import { composeSystemPrompt } from '../ai/compose-prompt'
import type { ChatMessage, ToolCall, ToolResult, ChatProvider } from '../ai/types'

export type { ProviderId } from '../ai/registry'

interface AiDeps {
  getSecret: (key: string) => string | null
  getProviderId: () => ProviderId
  getProviderModel: (id: ProviderId) => string | null
  /** Persist a write so the user can ↶ revert it later. */
  recordWrite: (projectPath: string, filePath: string, before: string, after: string) => void
  /** Persist a plan emitted by the AI. */
  recordPlan: (projectPath: string, title: string, steps: Array<{ title: string; detail?: string | null }>) => { id: number }
  /** Auto-append a brief entry to the dev journal (file write, command, plan, session summary). */
  recordJournal: (projectPath: string, kind: 'tool' | 'session' | 'note', title: string, detail?: string | null) => void
  /** Connector registry (list / query external services like 1C). */
  connectors: {
    list: () => Array<{ id: string; label: string; kind: string; status: string; detail?: string }>
    query: (id: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
  }
}

let currentSendId = 0
const activeAborts = new Map<number, AbortController>()

type TaggedSender = {
  send: (channel: string, payload: { id: number; event: unknown }) => void
  /** Run JS in the renderer and get its result (used to invoke browser tools). */
  exec: (code: string) => Promise<unknown>
}

/**
 * Tag every ai:event with the project it belongs to so the renderer can route
 * the update to the correct session (background-agent support).
 */
function tagSender(sender: Electron.WebContents, projectPath: string | null): TaggedSender {
  return {
    send: (channel: string, payload: { id: number; event: unknown }) => {
      sender.send(channel, { ...payload, projectPath })
    },
    exec: (code: string) => sender.executeJavaScript(code, true)
  }
}

interface PendingWrite { resolve: (accept: boolean) => void }
const pendingWrites = new Map<string, PendingWrite>()

interface PendingCommand { resolve: (accept: boolean) => void }
const pendingCommands = new Map<string, PendingCommand>()

export function registerAiIpc(deps: AiDeps): void {
  ipcMain.handle('ai:send', async (e, messages: ChatMessage[], projectPath: string | null) => {
    const providerId = deps.getProviderId()
    const descriptor = PROVIDERS[providerId]
    const sendId = ++currentSendId
    const ctrl = new AbortController()
    activeAborts.set(sendId, ctrl)
    const cleanup = () => { activeAborts.delete(sendId) }

    // Load project's user-layer (AGENTS.md / CLAUDE.md / GEMINI.md / our RULES.md)
    // and prepend the immutable system layer + user layer as a single system message.
    // CLI providers run their own agent inside, so we don't inject for them — the
    // user's AGENTS.md is already picked up by Claude Code / Codex / Grok Build natively.
    const injectSystem = descriptor.transport === 'API'
    let messagesWithSystem = messages
    if (injectSystem) {
      const userLayer = await loadUserLayer(projectPath)
      const composed = composeSystemPrompt(userLayer)
      messagesWithSystem = [{ role: 'system', content: composed.system }, ...messages]
    }

    const taggedSender = tagSender(e.sender, projectPath)

    // Resolve API key (or null for CLI)
    const apiKey = descriptor.secretKey ? deps.getSecret(descriptor.secretKey) : null
    if (descriptor.secretKey && !apiKey) {
      taggedSender.send('ai:event', {
        id: 0,
        event: {
          type: 'error',
          message: `API ключ для ${descriptor.name} не задан. Открой настройки и добавь ключ или переключи провайдера.`
        }
      })
      cleanup()
      return 0
    }

    const model = deps.getProviderModel(providerId) ?? descriptor.defaultModel
    let provider: ChatProvider
    try {
      provider = createProvider(providerId, {
        apiKey,
        model,
        cwd: projectPath ?? process.cwd(),
        signal: ctrl.signal
      })
    } catch (err) {
      taggedSender.send('ai:event', {
        id: 0,
        event: { type: 'error', message: err instanceof Error ? err.message : String(err) }
      })
      cleanup()
      return 0
    }

    if (descriptor.supportsTools && projectPath) {
      const tools = createFileTools(projectPath)
      void runApiConversation(taggedSender, sendId, provider, tools, projectPath, messagesWithSystem, ctrl.signal, deps.recordWrite, deps.recordPlan, deps.recordJournal, deps.connectors).finally(cleanup)
    } else {
      void runPlainConversation(taggedSender, sendId, provider, messagesWithSystem, ctrl.signal).finally(cleanup)
    }
    return sendId
  })

  ipcMain.handle('ai:stop', (_e, sendId: number) => {
    const ctrl = activeAborts.get(sendId)
    if (!ctrl) return false
    ctrl.abort()
    activeAborts.delete(sendId)
    for (const [k, p] of pendingWrites) { p.resolve(false); pendingWrites.delete(k) }
    for (const [k, p] of pendingCommands) { p.resolve(false); pendingCommands.delete(k) }
    return true
  })

  ipcMain.handle('ai:resolve-write', (_e, callId: string, accept: boolean) => {
    const p = pendingWrites.get(callId)
    if (p) { p.resolve(accept); pendingWrites.delete(callId) }
  })

  ipcMain.handle('ai:resolve-command', (_e, callId: string, accept: boolean) => {
    const p = pendingCommands.get(callId)
    if (p) { p.resolve(accept); pendingCommands.delete(callId) }
  })
}

/**
 * Plain streaming conversation — no tools, no multi-turn. Used for providers
 * that don't support function calling yet (Claude/Grok/OpenAI/Gemini CLI).
 */
async function runPlainConversation(
  sender: TaggedSender,
  sendId: number,
  provider: ChatProvider,
  messages: ChatMessage[],
  signal: AbortSignal
): Promise<void> {
  for await (const event of provider.send(messages, [])) {
    if (signal.aborted) {
      sender.send('ai:event', { id: sendId, event: { type: 'done' } })
      return
    }
    sender.send('ai:event', { id: sendId, event })
    if (event.type === 'done' || event.type === 'error') return
  }
  sender.send('ai:event', { id: sendId, event: { type: 'done' } })
}

// Type re-exports for renderer (api.d.ts)
export type { UsageDelta } from '../ai/types'

/**
 * Full agentic loop with file tools + diff confirmation + command sandbox.
 * Only providers that support function calling go through here.
 */
const MAX_AGENT_TURNS = 8

function callSignature(call: ToolCall): string {
  return `${call.name}::${JSON.stringify(call.args)}`
}

async function runApiConversation(
  sender: TaggedSender,
  sendId: number,
  provider: ChatProvider,
  tools: ReturnType<typeof createFileTools>,
  projectPath: string,
  initialMessages: ChatMessage[],
  signal: AbortSignal,
  recordWrite: (projectPath: string, filePath: string, before: string, after: string) => void,
  recordPlan: (projectPath: string, title: string, steps: Array<{ title: string; detail?: string | null }>) => { id: number },
  recordJournal: (projectPath: string, kind: 'tool' | 'session' | 'note', title: string, detail?: string | null) => void,
  connectors: {
    list: () => Array<{ id: string; label: string; kind: string; status: string; detail?: string }>
    query: (id: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
  }
): Promise<void> {
  const currentMessages = [...initialMessages]
  // Loop detection — same tool+args appearing 2+ times in a row is a bad sign.
  const recentSignatures: string[] = []
  // Tally tool activity over the whole session so we can write one journal summary at the end.
  const filesTouched = new Set<string>()
  const commandsRun: string[] = []
  let lastAssistantText = ''

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    if (signal.aborted) {
      sender.send('ai:event', { id: sendId, event: { type: 'done' } })
      return
    }
    const toolCalls: ToolCall[] = []
    let assistantText = ''
    for await (const event of provider.send(currentMessages, TOOL_DEFS)) {
      if (signal.aborted) {
        sender.send('ai:event', { id: sendId, event: { type: 'done' } })
        return
      }
      if (event.type === 'text') {
        assistantText += event.text
        lastAssistantText = assistantText
        sender.send('ai:event', { id: sendId, event })
      } else if (event.type === 'tool-call') {
        toolCalls.push(event.call)
      } else if (event.type === 'usage') {
        sender.send('ai:event', { id: sendId, event })
      } else if (event.type === 'done') {
        if (toolCalls.length === 0) {
          writeSessionJournal(recordJournal, projectPath, lastAssistantText, filesTouched, commandsRun)
          sender.send('ai:event', { id: sendId, event })
          return
        }
      } else if (event.type === 'error') {
        sender.send('ai:event', { id: sendId, event })
        return
      }
    }
    if (toolCalls.length === 0) {
      writeSessionJournal(recordJournal, projectPath, lastAssistantText, filesTouched, commandsRun)
      sender.send('ai:event', { id: sendId, event: { type: 'done' } })
      return
    }

    // Loop detection — check if AI repeated the same tool call this turn
    const loopHits: ToolCall[] = []
    for (const c of toolCalls) {
      const sig = callSignature(c)
      const seen = recentSignatures.filter(s => s === sig).length
      if (seen >= 2) loopHits.push(c)
      recentSignatures.push(sig)
    }
    // Keep window small
    while (recentSignatures.length > 8) recentSignatures.shift()

    currentMessages.push({ role: 'assistant', content: assistantText, toolCalls })

    if (loopHits.length > 0) {
      sender.send('ai:event', {
        id: sendId,
        event: {
          type: 'tool-blocked',
          callId: loopHits[0].id,
          name: loopHits[0].name,
          reason: `Зацикливание: один и тот же вызов повторён 3+ раза подряд. Цикл остановлен.`
        }
      })
      // Feed back a supervisor note instead of executing again
      currentMessages.push({
        role: 'user',
        content: '',
        toolResults: loopHits.map(c => ({
          id: c.id,
          name: c.name,
          result: '',
          error: 'Supervisor: вы зациклились — этот же вызов повторён несколько раз. Смените подход или сообщите пользователю что нужна помощь.'
        }))
      })
      sender.send('ai:event', { id: sendId, event: { type: 'done' } })
      return
    }

    const toolResults: ToolResult[] = new Array(toolCalls.length)
    const writePromises: Array<{ idx: number; promise: Promise<ToolResult> }> = []
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]
      if (call.name === 'write_file') {
        // Fire pending-write event immediately and queue the resolve promise.
        // The renderer will accumulate all pending writes into one multi-file modal.
        writePromises.push({ idx: i, promise: handleWriteFile(sender, sendId, tools, call, projectPath, recordWrite) })
        continue
      }
      if (call.name === 'run_command') {
        toolResults[i] = await handleRunCommand(sender, sendId, tools, call)
        continue
      }
      if (call.name === 'browser_navigate' || call.name === 'browser_read_page' || call.name === 'browser_screenshot') {
        toolResults[i] = await handleBrowserTool(sender, call)
        const s = summarizeToolCall(call.name, call.args, undefined)
        if (s) sender.send('ai:event', { id: sendId, event: { type: 'tool-activity', callId: call.id, name: call.name, label: s.label, detail: s.detail, status: toolResults[i].error ? 'error' : 'ok' } })
        continue
      }
      if (call.name === 'list_connectors') {
        const list = connectors.list()
        toolResults[i] = { id: call.id, name: call.name, result: JSON.stringify(list) }
        const s = summarizeToolCall(call.name, call.args, JSON.stringify(list))
        if (s) sender.send('ai:event', { id: sendId, event: { type: 'tool-activity', callId: call.id, name: call.name, label: s.label, detail: s.detail, status: 'ok' } })
        continue
      }
      if (call.name === 'connector_query') {
        try {
          const cid = String(call.args.id ?? '')
          if (!cid) {
            toolResults[i] = { id: call.id, name: call.name, result: '', error: 'connector_query: id обязателен' }
            continue
          }
          const { id: _omit, ...rest } = call.args as Record<string, unknown> & { id?: unknown }
          void _omit
          const result = await connectors.query(cid, rest, signal)
          toolResults[i] = { id: call.id, name: call.name, result: typeof result === 'string' ? result : JSON.stringify(result) }
          const s = summarizeToolCall(call.name, call.args, undefined)
          if (s) sender.send('ai:event', { id: sendId, event: { type: 'tool-activity', callId: call.id, name: call.name, label: s.label, detail: s.detail, status: 'ok' } })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          toolResults[i] = { id: call.id, name: call.name, result: '', error: msg }
          sender.send('ai:event', { id: sendId, event: { type: 'tool-activity', callId: call.id, name: call.name, label: call.name, detail: msg, status: 'error' } })
        }
        continue
      }
      if (call.name === 'create_plan') {
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
            toolResults[i] = { id: call.id, name: call.name, result: '', error: 'create_plan: пустой список шагов' }
          } else {
            const plan = recordPlan(projectPath, title, steps)
            try { recordJournal(projectPath, 'note', `План: ${title}`, `${steps.length} шагов`) } catch { /* journal not critical */ }
            sender.send('ai:event', { id: sendId, event: { type: 'plan-created', planId: plan.id, title, stepCount: steps.length } })
            toolResults[i] = { id: call.id, name: call.name, result: `Plan #${plan.id} created with ${steps.length} steps. User will execute/confirm in the Plan view.` }
          }
        } catch (err) {
          toolResults[i] = { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
        }
        continue
      }
      // Read-only / pure-info tools — emit an activity event so user sees what AI is doing.
      try {
        const result = await tools.execute(call.name, call.args)
        const summary = summarizeToolCall(call.name, call.args, result)
        if (summary) {
          sender.send('ai:event', { id: sendId, event: { type: 'tool-activity', callId: call.id, name: call.name, label: summary.label, detail: summary.detail, status: 'ok' } })
        }
        toolResults[i] = { id: call.id, name: call.name, result }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        sender.send('ai:event', { id: sendId, event: { type: 'tool-activity', callId: call.id, name: call.name, label: call.name, detail: msg, status: 'error' } })
        toolResults[i] = {
          id: call.id,
          name: call.name,
          result: '',
          error: msg
        }
      }
    }
    // All non-write tools finished. Now wait for user to resolve every pending write
    // (multi-file modal accumulates them on the renderer side).
    for (const { idx, promise } of writePromises) {
      toolResults[idx] = await promise
    }
    // Tally tool usage for the end-of-session journal summary
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]
      const result = toolResults[i]
      if (!result) continue
      if (call.name === 'write_file' && !result.error) {
        const p = String(call.args.path ?? '')
        if (p) filesTouched.add(p)
      } else if (call.name === 'run_command' && !result.error) {
        const cmd = String(call.args.command ?? '')
        if (cmd) commandsRun.push(cmd)
      }
    }
    currentMessages.push({ role: 'user', content: '', toolResults })
  }
  // Max turns reached — warn user and exit
  writeSessionJournal(recordJournal, projectPath, lastAssistantText, filesTouched, commandsRun)
  sender.send('ai:event', {
    id: sendId,
    event: {
      type: 'tool-blocked',
      callId: 'maxturns',
      name: 'agent-loop',
      reason: `Достигнут лимит ${MAX_AGENT_TURNS} итераций агента. Цикл остановлен — задача может быть не завершена.`
    }
  })
  sender.send('ai:event', { id: sendId, event: { type: 'done' } })
}

/**
 * Write a brief journal summary for the just-finished agent session.
 * Skipped if nothing meaningful happened (no text, no files, no commands).
 */
function writeSessionJournal(
  recordJournal: (projectPath: string, kind: 'tool' | 'session' | 'note', title: string, detail?: string | null) => void,
  projectPath: string,
  lastAssistantText: string,
  filesTouched: Set<string>,
  commandsRun: string[]
): void {
  const hasFiles = filesTouched.size > 0
  const hasCommands = commandsRun.length > 0
  const text = lastAssistantText.trim()
  if (!hasFiles && !hasCommands && text.length < 40) return
  // Title: first sentence of the assistant's reply, capped at 100 chars.
  const firstLine = text.split(/\n+/)[0] ?? ''
  const title = (firstLine.length > 0 ? firstLine : 'AI-сессия').slice(0, 100)
  const detailLines: string[] = []
  if (hasFiles) detailLines.push(`Файлы (${filesTouched.size}): ${[...filesTouched].slice(0, 8).join(', ')}${filesTouched.size > 8 ? ' …' : ''}`)
  if (hasCommands) detailLines.push(`Команды (${commandsRun.length}): ${commandsRun.slice(0, 5).join(' · ')}${commandsRun.length > 5 ? ' …' : ''}`)
  if (text && text.length > firstLine.length) {
    const rest = text.slice(firstLine.length).trim()
    if (rest) detailLines.push(rest.slice(0, 600))
  }
  try { recordJournal(projectPath, 'session', title, detailLines.join('\n') || null) } catch { /* journal not critical */ }
}

async function handleWriteFile(
  sender: TaggedSender,
  sendId: number,
  tools: ReturnType<typeof createFileTools>,
  call: ToolCall,
  projectPath: string,
  recordWrite: (projectPath: string, filePath: string, before: string, after: string) => void
): Promise<ToolResult> {
  const path = String(call.args.path)
  const after = String(call.args.content)
  let before = ''
  try { before = await tools.execute('read_file', { path }) as string } catch { before = '' }
  sender.send('ai:event', { id: sendId, event: { type: 'pending-write', callId: call.id, path, before, after } })
  const accepted = await new Promise<boolean>(resolve => { pendingWrites.set(call.id, { resolve }) })
  if (accepted) {
    try {
      await tools.execute('write_file', call.args)
      // Save the before/after pair so the user can ↶ revert this write later
      try { recordWrite(projectPath, path, before, after) } catch { /* undo storage failure shouldn't block the write */ }
      return { id: call.id, name: call.name, result: `Applied write to ${path}` }
    } catch (err) {
      return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
  return { id: call.id, name: call.name, result: `User rejected write to ${path}`, error: 'User rejected' }
}

/** Short human-readable summary of a read-only tool call for the activity stream. */
function summarizeToolCall(name: string, args: Record<string, unknown>, result: unknown): { label: string; detail: string } | null {
  if (name === 'read_file') {
    const p = String(args.path ?? '')
    const len = typeof result === 'string' ? result.length : 0
    return { label: `read_file`, detail: `${p} · ${len} символов` }
  }
  if (name === 'list_directory') {
    const p = String(args.path ?? '.')
    const count = Array.isArray(result) ? result.length : 0
    return { label: `list_directory`, detail: `${p} · ${count} элементов` }
  }
  if (name === 'search_project') {
    const q = String(args.query ?? '')
    const r = result as { matches?: unknown[] } | undefined
    const hits = Array.isArray(r?.matches) ? r!.matches!.length : 0
    return { label: `search_project`, detail: `"${q}" · ${hits} совпадений` }
  }
  if (name === 'find_files') {
    const pattern = String(args.pattern ?? '')
    const r = result as { files?: unknown[] } | undefined
    const hits = Array.isArray(r?.files) ? r!.files!.length : 0
    return { label: `find_files`, detail: `${pattern} · ${hits} файлов` }
  }
  if (name === 'list_connectors') {
    const arr = typeof result === 'string' ? JSON.parse(result) as Array<{ label?: string }> : []
    return { label: `list_connectors`, detail: `${arr.length} коннекторов` }
  }
  if (name === 'connector_query') {
    return { label: `connector_query`, detail: `${String(args.id ?? '?')}${args.entity ? ` · ${args.entity}` : ''}` }
  }
  if (name === 'browser_navigate') {
    return { label: `browser_navigate`, detail: String(args.url ?? '') }
  }
  if (name === 'browser_read_page') {
    return { label: `browser_read_page`, detail: args.selector ? String(args.selector) : '(вся страница)' }
  }
  return null
}

async function handleBrowserTool(sender: TaggedSender, call: ToolCall): Promise<ToolResult> {
  try {
    // Build a JS snippet that calls the renderer-side BrowserView dispatcher
    // and returns a JSON-encoded result. executeJavaScript awaits any returned
    // Promise automatically, so we can use an async IIFE.
    const argsJson = JSON.stringify(call.args ?? {})
    let snippet = ''
    if (call.name === 'browser_navigate') {
      snippet = `(async () => {
        const api = window.geminigrokBrowser;
        if (!api) return { __err: 'Вкладка Browser не открыта — попроси пользователя открыть её' };
        const a = ${argsJson};
        return await api.navigate(String(a.url ?? ''));
      })()`
    } else if (call.name === 'browser_read_page') {
      snippet = `(async () => {
        const api = window.geminigrokBrowser;
        if (!api) return { __err: 'Вкладка Browser не открыта — попроси пользователя открыть её' };
        const a = ${argsJson};
        const text = await api.readPage(a.selector ? String(a.selector) : undefined);
        return { url: api.getURL(), title: api.getTitle(), text };
      })()`
    } else {
      snippet = `(async () => {
        const api = window.geminigrokBrowser;
        if (!api) return { __err: 'Вкладка Browser не открыта — попроси пользователя открыть её' };
        const dataUrl = await api.screenshot();
        return { url: api.getURL(), dataUrl };
      })()`
    }
    const result = await sender.exec(snippet)
    if (result && typeof result === 'object' && '__err' in result) {
      return { id: call.id, name: call.name, result: '', error: String((result as { __err: unknown }).__err) }
    }
    return { id: call.id, name: call.name, result: result ?? '' }
  } catch (err) {
    return { id: call.id, name: call.name, result: '', error: err instanceof Error ? err.message : String(err) }
  }
}

async function handleRunCommand(
  sender: TaggedSender,
  sendId: number,
  tools: ReturnType<typeof createFileTools>,
  call: ToolCall
): Promise<ToolResult> {
  const command = String(call.args.command ?? '')
  const verdict = tools.classifyCommand(command)
  if (!verdict.allowed) {
    sender.send('ai:event', {
      id: sendId,
      event: { type: 'tool-blocked', callId: call.id, name: 'run_command', command, reason: verdict.reason ?? 'denylist' }
    })
    return {
      id: call.id,
      name: call.name,
      result: `Command: ${command}`,
      error: `Blocked by safety policy: ${verdict.reason ?? 'denylist'}`
    }
  }

  sender.send('ai:event', { id: sendId, event: { type: 'pending-command', callId: call.id, command } })
  const accepted = await new Promise<boolean>(resolve => { pendingCommands.set(call.id, { resolve }) })
  if (!accepted) {
    sender.send('ai:event', {
      id: sendId,
      event: { type: 'command-result', callId: call.id, command, status: 'rejected' }
    })
    return { id: call.id, name: call.name, result: `Command: ${command}`, error: 'User rejected' }
  }

  try {
    const result = await tools.runCommand(command)
    sender.send('ai:event', {
      id: sendId,
      event: { type: 'command-result', callId: call.id, command, status: 'ok', exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
    })
    return { id: call.id, name: call.name, result }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sender.send('ai:event', {
      id: sendId,
      event: { type: 'command-result', callId: call.id, command, status: 'error', error: msg }
    })
    return { id: call.id, name: call.name, result: '', error: msg }
  }
}
