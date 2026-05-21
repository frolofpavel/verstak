import { ipcMain } from 'electron'
import { createFileTools, TOOL_DEFS } from '../ai/tools'
import { createProvider, PROVIDERS, type ProviderId } from '../ai/registry'
import { prepareSystemContext } from '../ai/compose-system'
import type { AgentMode } from '../ai/mode-policy'
import type { ChatMessage, ToolCall, ToolResult, ChatProvider, Attachment } from '../ai/types'
import { lookupHandler, type ToolContext, type TaggedSender as HandlerTaggedSender } from './tool-handlers'

export type { ProviderId } from '../ai/registry'

interface AiDeps {
  getSecret: (key: string) => string | null
  getProviderId: () => ProviderId
  getProviderModel: (id: ProviderId) => string | null
  /** Persist a write so the user can ↶ revert it later. */
  recordWrite: (projectPath: string, filePath: string, before: string, after: string) => void
  /** Fetch the N most recent accepted writes for the Context Pack. */
  recentWrites: (projectPath: string, limit: number) => Array<{ filePath: string; createdAt: number }>
  /** Persist a plan emitted by the AI. */
  recordPlan: (projectPath: string, title: string, steps: Array<{ title: string; detail?: string | null }>) => { id: number }
  /** Auto-append a brief entry to the dev journal (file write, command, plan, session summary). */
  recordJournal: (projectPath: string, kind: 'tool' | 'session' | 'note', title: string, detail?: string | null) => void
  /** Read recent journal entries — exposed to the AI as the read_journal tool. */
  readJournal: (projectPath: string, limit: number) => Array<{ kind: string; title: string; detail: string | null; createdAt: number }>
  /** Connector registry (list / query external services like 1C). */
  connectors: {
    list: () => Array<{ id: string; label: string; kind: string; status: string; detail?: string }>
    query: (id: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
  }
  /** Active agent mode — auto-accept / confirm / block per tool category. */
  getAgentMode: () => AgentMode
}

let currentSendId = 0
const activeAborts = new Map<number, AbortController>()

// Local TaggedSender alias — shape-compatible with tool-handlers.TaggedSender.
type TaggedSender = HandlerTaggedSender

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

// Keyed by `${sendId}::${callId}` so concurrent ai:send invocations cannot
// resolve each other's pending confirmations. The renderer still identifies
// modals by callId (it doesn't know about sendId), so we look up by callId
// suffix when resolving — but isolation is enforced when CLEARING (ai:stop).
interface PendingWrite { sendId: number; resolve: (accept: boolean) => void }
const pendingWrites = new Map<string, PendingWrite>()

interface PendingCommand { sendId: number; resolve: (accept: boolean) => void }
const pendingCommands = new Map<string, PendingCommand>()

function scopedKey(sendId: number, callId: string): string {
  return `${sendId}::${callId}`
}

export function registerAiIpc(deps: AiDeps): void {
  /**
   * Optional overrides for ai:send. Used by Explicit Review feature: the
   * reviewer needs a DIFFERENT provider from the chat's main provider, must
   * skip tool dispatch (review is read-only synthesis), and may use a custom
   * system prompt (REVIEWER_SYSTEM_PROMPT) instead of the project's system
   * layer. Without overrides, ai:send behaves exactly as before.
   */
  interface AiSendOverrides {
    providerId?: ProviderId
    model?: string | null
    /** Force plain (no-tools) mode even if provider supports tools. */
    noTools?: boolean
    /** Replace assembled system prompt entirely. When set, project's user-layer
     *  / context-pack is NOT prepended — caller owns the full system message. */
    systemPrompt?: string
  }

  ipcMain.handle('ai:send', async (e, messages: ChatMessage[], projectPath: string | null, budget?: number, overrides?: AiSendOverrides) => {
    const providerId = overrides?.providerId ?? deps.getProviderId()
    const descriptor = PROVIDERS[providerId]
    const sendId = ++currentSendId
    const ctrl = new AbortController()
    activeAborts.set(sendId, ctrl)
    /**
     * Cleanup MUST handle every dangling state owned by this sendId. Per Gemini
     * audit finding 2.1 + 2.5: previously cleanup only wiped activeAborts,
     * leaving pending confirmations (and their pending Promises) alive
     * forever if the session crashed/aborted before user clicked. That was a
     * silent memory leak AND a source of weird "ghost confirmations" on the
     * next session with similar callId.
     */
    const cleanup = () => {
      activeAborts.delete(sendId)
      // Drain pending confirmations for this sendId — resolving with false so
      // any awaiter unwinds cleanly instead of leaking the Promise.
      for (const [k, p] of pendingWrites) {
        if (p.sendId === sendId) { p.resolve(false); pendingWrites.delete(k) }
      }
      for (const [k, p] of pendingCommands) {
        if (p.sendId === sendId) { p.resolve(false); pendingCommands.delete(k) }
      }
      // sendIdToChatId mapping cleared via separate ai:event done handler in
      // renderer — no need to touch from main.
    }

    // Load project's user-layer (AGENTS.md / CLAUDE.md / GEMINI.md / our RULES.md)
    // and prepend the immutable system layer + user layer as a single system message.
    // CLI providers run their own agent inside, so we don't inject for them — the
    // user's AGENTS.md is already picked up by Claude Code / Codex / Grok Build natively.
    //
    // OVERRIDE path (Explicit Review): caller passes its own system prompt
    // (REVIEWER_SYSTEM_PROMPT) and we don't want to also inject the project's
    // user_layer — reviewer prompt is self-contained.
    let messagesWithSystem = messages
    if (overrides?.systemPrompt) {
      messagesWithSystem = [{ role: 'system', content: overrides.systemPrompt }, ...messages]
    } else if (descriptor.transport === 'API') {
      // Same assembly path as CLI providers — see ai/compose-system.ts.
      const composed = await prepareSystemContext({
        projectPath,
        messages,
        recentWrites: projectPath ? deps.recentWrites(projectPath, 8) : []
      })
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

    const model = (overrides?.model ?? deps.getProviderModel(providerId)) ?? descriptor.defaultModel
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

    // Force-plain path: review uses no tools regardless of provider capability.
    const useToolsPath = !overrides?.noTools && descriptor.supportsTools && projectPath
    if (useToolsPath) {
      const tools = createFileTools(projectPath, ctrl.signal)
      const turnsBudget = Math.min(MAX_BUDGET_TURNS, Math.max(DEFAULT_AGENT_TURNS, budget ?? DEFAULT_AGENT_TURNS))
      void runApiConversation(taggedSender, sendId, provider, tools, projectPath, messagesWithSystem, ctrl.signal, deps.recordWrite, deps.recordPlan, deps.recordJournal, deps.readJournal, deps.connectors, deps.getAgentMode(), turnsBudget).finally(cleanup)
    } else {
      void runPlainConversation(taggedSender, sendId, provider, projectPath, messagesWithSystem, ctrl.signal, deps.recordJournal).finally(cleanup)
    }
    return sendId
  })

  ipcMain.handle('ai:stop', (_e, sendId: number) => {
    // sendId <= 0 → emergency abort: stop EVERY active stream + reject all pending
    // confirmations. Used by Shift+Esc when the UI feels stuck.
    if (sendId <= 0) {
      for (const [k, c] of activeAborts) { c.abort(); activeAborts.delete(k) }
      for (const [k, p] of pendingWrites) { p.resolve(false); pendingWrites.delete(k) }
      for (const [k, p] of pendingCommands) { p.resolve(false); pendingCommands.delete(k) }
      return true
    }
    const ctrl = activeAborts.get(sendId)
    if (!ctrl) return false
    ctrl.abort()
    activeAborts.delete(sendId)
    // Reject ONLY this session's pending confirmations — other concurrent
    // ai:send streams (background sessions) keep theirs intact.
    for (const [k, p] of pendingWrites) {
      if (p.sendId === sendId) { p.resolve(false); pendingWrites.delete(k) }
    }
    for (const [k, p] of pendingCommands) {
      if (p.sendId === sendId) { p.resolve(false); pendingCommands.delete(k) }
    }
    return true
  })

  ipcMain.handle('ai:resolve-write', (_e, callId: string, accept: boolean, sendId?: number) => {
    // If renderer knows sendId (it should — Chat.tsx stores it after ai:send),
    // use strict key lookup. Fallback to suffix scan for backward compat with
    // older renderer code paths.
    if (typeof sendId === 'number' && sendId > 0) {
      const key = scopedKey(sendId, callId)
      const exact = pendingWrites.get(key)
      if (exact) { exact.resolve(accept); pendingWrites.delete(key); return }
    }
    for (const [k, p] of pendingWrites) {
      if (k.endsWith('::' + callId)) {
        p.resolve(accept)
        pendingWrites.delete(k)
        return
      }
    }
  })

  /**
   * Count tokens for an outgoing prompt before send. Lets the renderer show a
   * "≈ N tokens, ~$X" preview in the composer. Only implemented for providers
   * that expose a real countTokens API — others get a rough estimate.
   */
  ipcMain.handle('ai:count-tokens', async (_e, text: string, projectPath: string | null, historyMessages?: ChatMessage[]) => {
    const providerId = deps.getProviderId()
    const descriptor = PROVIDERS[providerId]
    const apiKey = descriptor.secretKey ? deps.getSecret(descriptor.secretKey) : null
    // No API key or CLI provider — fall back to a rough heuristic (~4 chars/token)
    if (!apiKey || descriptor.transport !== 'API') {
      const rough = Math.ceil((text?.length ?? 0) / 4)
      return { tokens: rough, exact: false, providerId }
    }
    try {
      // Currently we have a true countTokens path only for Gemini API. Others
      // use the heuristic — extend as we add adapters.
      if (providerId === 'gemini-api') {
        const { GoogleGenAI } = await import('@google/genai')
        const client = new GoogleGenAI({ apiKey })
        const model = deps.getProviderModel(providerId) ?? descriptor.defaultModel
        // Same compose path as ai:send — keeps countTokens estimate aligned
        // with what actually gets sent on the next ai:send.
        // Build the FULL context the next ai:send would see: system + history
        // + draft text. Without history the estimate could be off by orders of
        // magnitude on long conversations (50+ msgs → ~20k tokens of history).
        const history = Array.isArray(historyMessages) ? historyMessages : []
        const composed = await prepareSystemContext({
          projectPath,
          messages: history,
          recentWrites: projectPath ? deps.recentWrites(projectPath, 8) : []
        })
        // Full context size: system + every prior turn + the draft text.
        const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [
          { role: 'user', parts: [{ text: composed.system }] }
        ]
        for (const m of history) {
          if (m.role === 'system') continue  // already in composed.system
          contents.push({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content ?? '' }]
          })
        }
        if (text) contents.push({ role: 'user', parts: [{ text }] })
        const res = await (client.models as unknown as {
          countTokens: (opts: { model: string; contents: typeof contents }) => Promise<{ totalTokens?: number }>
        }).countTokens({ model, contents })
        return { tokens: res.totalTokens ?? 0, exact: true, providerId }
      }
    } catch (err) {
      console.error('[count-tokens]', err instanceof Error ? err.message : err)
    }
    return { tokens: Math.ceil((text?.length ?? 0) / 4), exact: false, providerId }
  })

  ipcMain.handle('ai:resolve-command', (_e, callId: string, accept: boolean, sendId?: number) => {
    if (typeof sendId === 'number' && sendId > 0) {
      const key = scopedKey(sendId, callId)
      const exact = pendingCommands.get(key)
      if (exact) { exact.resolve(accept); pendingCommands.delete(key); return }
    }
    for (const [k, p] of pendingCommands) {
      if (k.endsWith('::' + callId)) {
        p.resolve(accept)
        pendingCommands.delete(k)
        return
      }
    }
  })
}

/**
 * Plain streaming conversation — no tools, no multi-turn. Used for providers
 * that don't support function calling yet (Claude/Grok/OpenAI/Gemini CLI).
 *
 * Per Grok audit 2026-05-21 (CLI parity, finding 2.1/2.2/2.5): previously this
 * path was 17 lines with zero journaling, no lastAssistantText capture, no
 * usage tracking, no exit-reason. CLI sessions left no trail in dev-journal —
 * the same gap we already closed for the API path. Now mirrors the API
 * lifecycle: collect text/usage during the stream, write a session journal in
 * try/finally regardless of how the stream ended.
 */
async function runPlainConversation(
  sender: TaggedSender,
  sendId: number,
  provider: ChatProvider,
  projectPath: string | null,
  messages: ChatMessage[],
  signal: AbortSignal,
  recordJournal: AiDeps['recordJournal']
): Promise<void> {
  let lastAssistantText = ''
  const sessionUsage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } = {
    inputTokens: 0, outputTokens: 0, cachedInputTokens: 0
  }
  let exitReason: ExitReason = 'completed'
  try {
    for await (const event of provider.send(messages, [])) {
      if (signal.aborted) {
        exitReason = 'aborted'
        sender.send('ai:event', { id: sendId, event: { type: 'done' } })
        return
      }
      // Accumulate stream into lastAssistantText so journal has a real summary.
      // CLI providers stream text in chunks via { type: 'text' } — same shape
      // as API providers.
      if (event.type === 'text' && typeof event.text === 'string') {
        lastAssistantText += event.text
      } else if (event.type === 'usage' && event.usage) {
        sessionUsage.inputTokens += event.usage.inputTokens ?? 0
        sessionUsage.outputTokens += event.usage.outputTokens ?? 0
        sessionUsage.cachedInputTokens += event.usage.cachedInputTokens ?? 0
      } else if (event.type === 'error') {
        exitReason = 'error'
      }
      sender.send('ai:event', { id: sendId, event })
      if (event.type === 'done' || event.type === 'error') return
    }
    sender.send('ai:event', { id: sendId, event: { type: 'done' } })
  } catch (err) {
    exitReason = 'crashed'
    sender.send('ai:event', {
      id: sendId,
      event: { type: 'error', message: err instanceof Error ? err.message : String(err) }
    })
    sender.send('ai:event', { id: sendId, event: { type: 'done' } })
  } finally {
    // Same guarantee as runApiConversation: every exit path writes a journal
    // entry. Skipped when there's no projectPath (background sessions in the
    // future may not have one).
    if (projectPath) {
      try {
        writeSessionJournal(
          recordJournal,
          projectPath,
          lastAssistantText,
          new Set<string>(),   // CLI path: no tool-driven file writes tracked here
          [],                  // CLI path: no command-tool dispatch (CLI runs them inside)
          sessionUsage,
          exitReason
        )
      } catch (err) {
        console.error('[ai.ts] writeSessionJournal (plain) failed in finally:', err)
      }
    }
  }
}

// Type re-exports for renderer (api.d.ts)
export type { UsageDelta } from '../ai/types'

/**
 * Full agentic loop with file tools + diff confirmation + command sandbox.
 * Only providers that support function calling go through here.
 */
const DEFAULT_AGENT_TURNS = 8
const MAX_BUDGET_TURNS = 40  // hard ceiling even with continues — prevents infinite-budget abuse

/** Quick verify-script detection for inline hints after accepted writes. */
async function detectVerifyScriptsForHint(projectPath: string): Promise<string[]> {
  const { readFile } = await import('fs/promises')
  const { join } = await import('path')
  const hints: string[] = []
  try {
    const raw = await readFile(join(projectPath, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> }
    const s = pkg.scripts ?? {}
    if (s.test) hints.push('npm test')
    if (s['type-check'] || s.typecheck) hints.push('npm run type-check')
    if (s.lint) hints.push('npm run lint')
  } catch { /* not node */ }
  try {
    await readFile(join(projectPath, 'tsconfig.json'), 'utf8')
    if (!hints.some(h => h.includes('tsc') || h.includes('type-check'))) {
      hints.push('npx tsc --noEmit')
    }
  } catch { /* no tsconfig */ }
  return hints
}

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
  readJournal: (projectPath: string, limit: number) => Array<{ kind: string; title: string; detail: string | null; createdAt: number }>,
  connectors: {
    list: () => Array<{ id: string; label: string; kind: string; status: string; detail?: string }>
    query: (id: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
  },
  agentMode: AgentMode,
  turnsBudget: number = DEFAULT_AGENT_TURNS
): Promise<void> {
  const currentMessages = [...initialMessages]
  // Loop detection: per-signature occurrence counter across the whole agent
  // loop. We block when a single tool+args combination has been called 3 times
  // (the threshold the UI tells the user). Tracking via Map avoids the
  // sliding-window eviction problem of the previous flat-array approach.
  const signatureCounts = new Map<string, number>()
  const LOOP_THRESHOLD = 3
  // Accumulate token usage across all turns of this session for the final journal entry.
  const sessionUsage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } = {
    inputTokens: 0, outputTokens: 0, cachedInputTokens: 0
  }
  // Tally tool activity over the whole session so we can write one journal summary at the end.
  const filesTouched = new Set<string>()
  const commandsRun: string[] = []
  let lastAssistantText = ''
  // Attachments collected from browser_screenshot etc. — flushed into the
  // next user message so vision-capable providers see them.
  const pendingAttachments: Attachment[] = []
  // Exit reason for the finally-block journal write. Mutated as the loop hits
  // various terminal conditions. 'crashed' is the default — if the function
  // returns abnormally (uncaught exception during streaming) the journal
  // still captures it. Per Gemini audit 2.2 + Idea B.
  let exitReason: ExitReason = 'crashed'

  try {

  for (let turn = 0; turn < turnsBudget; turn++) {
    if (signal.aborted) {
      exitReason = 'aborted'
      sender.send('ai:event', { id: sendId, event: { type: 'done' } })
      return
    }
    const toolCalls: ToolCall[] = []
    let assistantText = ''
    for await (const event of provider.send(currentMessages, TOOL_DEFS)) {
      if (signal.aborted) {
        exitReason = 'aborted'
        sender.send('ai:event', { id: sendId, event: { type: 'done' } })
        return
      }
      if (event.type === 'text') {
        assistantText += event.text
        lastAssistantText = assistantText
        sender.send('ai:event', { id: sendId, event })
      } else if (event.type === 'thought') {
        // Forward chain-of-thought verbatim — renderer accumulates into the
        // assistant message's `thinking` field for collapsed display.
        sender.send('ai:event', { id: sendId, event })
      } else if (event.type === 'tool-call') {
        toolCalls.push(event.call)
      } else if (event.type === 'usage') {
        sessionUsage.inputTokens += event.usage.inputTokens ?? 0
        sessionUsage.outputTokens += event.usage.outputTokens ?? 0
        sessionUsage.cachedInputTokens += event.usage.cachedInputTokens ?? 0
        sender.send('ai:event', { id: sendId, event })
      } else if (event.type === 'done') {
        if (toolCalls.length === 0) {
          exitReason = 'completed'
          sender.send('ai:event', { id: sendId, event })
          return
        }
      } else if (event.type === 'error') {
        exitReason = 'error'
        sender.send('ai:event', { id: sendId, event })
        return
      }
    }
    if (toolCalls.length === 0) {
      exitReason = 'completed'
      sender.send('ai:event', { id: sendId, event: { type: 'done' } })
      return
    }

    // Defence-in-depth dedupe: даже если провайдер эмитит один и тот же
    // tool-call дважды в одном turn (был баг в gemini.ts с двойной
    // экстракцией), сворачиваем дубли. Ключ — name + JSON args.
    {
      const seen = new Set<string>()
      const deduped: ToolCall[] = []
      for (const c of toolCalls) {
        const sig = callSignature(c)
        if (seen.has(sig)) continue
        seen.add(sig)
        deduped.push(c)
      }
      if (deduped.length !== toolCalls.length) {
        console.warn(`[agent] dropped ${toolCalls.length - deduped.length} duplicate tool calls in turn ${turn}`)
        toolCalls.length = 0
        toolCalls.push(...deduped)
      }
    }

    // Loop detection — increment counter per signature; block when any tool
    // call has been issued LOOP_THRESHOLD (3) times across the whole loop.
    const loopHits: ToolCall[] = []
    for (const c of toolCalls) {
      const sig = callSignature(c)
      const next = (signatureCounts.get(sig) ?? 0) + 1
      signatureCounts.set(sig, next)
      if (next >= LOOP_THRESHOLD) loopHits.push(c)
    }

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
      exitReason = 'loop-detected'
      sender.send('ai:event', { id: sendId, event: { type: 'done' } })
      return
    }

    const toolResults: ToolResult[] = new Array(toolCalls.length)

    // Dispatch via tool-handlers registry. Each handler knows its own scheduling
    // mode (parallel-read / sequential / confirm-write); the loop honours it.
    const ctx: ToolContext = {
      sender, sendId, signal, projectPath, tools,
      recordWrite, recordPlan, recordJournal, readJournal, connectors,
      pendingAttachments, pendingWrites, pendingCommands, scopedKey,
      agentMode
    }
    const writePromises: Array<{ idx: number; promise: Promise<ToolResult> }> = []
    const readPromises: Array<{ idx: number; promise: Promise<ToolResult> }> = []
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]
      const handler = lookupHandler(call.name)
      if (handler.mode === 'parallel-read') {
        readPromises.push({ idx: i, promise: handler.handle(call, ctx) })
      } else if (handler.mode === 'confirm-write') {
        // confirm-write tools all hit the same multi-file diff modal; they run
        // concurrently from this side and the user accepts/rejects together.
        writePromises.push({ idx: i, promise: handler.handle(call, ctx) })
      } else {
        // sequential — must finish before next tool (run_command, browser_*,
        // connectors, create_plan all have ordered UI side effects)
        toolResults[i] = await handler.handle(call, ctx)
      }
    }
    // Parallel reads finish without user input
    for (const { idx, promise } of readPromises) {
      toolResults[idx] = await promise
    }
    // Then wait for user to resolve every pending write
    for (const { idx, promise } of writePromises) {
      toolResults[idx] = await promise
    }
    // Tally tool usage for the end-of-session journal summary
    let acceptedWritesThisTurn = 0
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]
      const result = toolResults[i]
      if (!result) continue
      if ((call.name === 'write_file' || call.name === 'apply_patch') && !result.error) {
        const p = String(call.args.path ?? '')
        if (p) filesTouched.add(p)
        acceptedWritesThisTurn++
      } else if (call.name === 'run_command' && !result.error) {
        const cmd = String(call.args.command ?? '')
        if (cmd) commandsRun.push(cmd)
      }
    }
    // If user just accepted writes, gently nudge the model on the next turn
    // to verify (run tests / typecheck / lint). The context-pack already
    // showed verify_scripts; we re-surface as an inline reminder so the model
    // pays attention this turn specifically.
    let verifyHint = ''
    if (acceptedWritesThisTurn > 0) {
      const hints = await detectVerifyScriptsForHint(projectPath)
      if (hints.length > 0) {
        verifyHint = `[system: пользователь принял ${acceptedWritesThisTurn} write(s). Перед "готово" запусти проверку через run_command — варианты: ${hints.slice(0, 2).join(' / ')}. Если уверен что проверка избыточна — объясни почему.]`
      }
    }
    const nextUserMsg: ChatMessage = { role: 'user', content: verifyHint, toolResults }
    if (pendingAttachments.length > 0) {
      nextUserMsg.attachments = [...pendingAttachments]
      pendingAttachments.length = 0
    }
    currentMessages.push(nextUserMsg)
  }
  // Budget exhausted — emit a dedicated event so the UI can offer "+N turns".
  // The renderer re-sends the current conversation with a larger budget if the
  // user clicks Continue.
  exitReason = 'max-turns'
  const canContinue = turnsBudget < MAX_BUDGET_TURNS
  sender.send('ai:event', {
    id: sendId,
    event: {
      type: 'turns-exhausted',
      used: turnsBudget,
      maxBudget: MAX_BUDGET_TURNS,
      canContinue,
      suggestedAdd: Math.min(10, MAX_BUDGET_TURNS - turnsBudget)
    }
  })
  sender.send('ai:event', { id: sendId, event: { type: 'done' } })
  } finally {
    // GUARANTEED journal write on every exit path — completion, abort, error,
    // max-turns, loop-detected, crashed (uncaught). Per Gemini audit Idea B:
    // 'любое завершение runApiConversation обязано вызвать writeSessionJournal'.
    try {
      writeSessionJournal(recordJournal, projectPath, lastAssistantText, filesTouched, commandsRun, sessionUsage, exitReason)
    } catch (err) {
      console.error('[ai.ts] writeSessionJournal failed in finally:', err)
    }
  }
}

/**
 * Write a brief journal summary for the just-finished agent session.
 * Skipped if nothing meaningful happened (no text, no files, no commands).
 */
/** Reason why the agent loop ended — recorded in the journal entry. */
type ExitReason = 'completed' | 'aborted' | 'error' | 'max-turns' | 'loop-detected' | 'crashed'

function writeSessionJournal(
  recordJournal: (projectPath: string, kind: 'tool' | 'session' | 'note', title: string, detail?: string | null) => void,
  projectPath: string,
  lastAssistantText: string,
  filesTouched: Set<string>,
  commandsRun: string[],
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number },
  reason: ExitReason = 'completed'
): void {
  const hasFiles = filesTouched.size > 0
  const hasCommands = commandsRun.length > 0
  const text = lastAssistantText.trim()
  const hasUsage = usage && ((usage.inputTokens ?? 0) > 0 || (usage.outputTokens ?? 0) > 0)
  // For non-completed reasons we ALWAYS write the entry, even empty — closes
  // Gemini audit 2.2: previously aborted/crashed sessions left no trail.
  const hasMaterial = hasFiles || hasCommands || hasUsage || text.length >= 40
  if (reason === 'completed' && !hasMaterial) return
  // Title prefix communicates outcome at a glance
  const tag = reason === 'completed' ? '' :
              reason === 'aborted' ? '⏹ Прерывание · ' :
              reason === 'error' ? '✗ Ошибка · ' :
              reason === 'max-turns' ? '⏸ Лимит ходов · ' :
              reason === 'loop-detected' ? '🔁 Зацикливание · ' :
              '💥 Крах · '
  const firstLine = text.split(/\n+/)[0] ?? ''
  const baseTitle = firstLine.length > 0 ? firstLine : 'AI-сессия'
  const title = (tag + baseTitle).slice(0, 100)
  const detailLines: string[] = []
  if (hasFiles) detailLines.push(`Файлы (${filesTouched.size}): ${[...filesTouched].slice(0, 8).join(', ')}${filesTouched.size > 8 ? ' …' : ''}`)
  if (hasCommands) detailLines.push(`Команды (${commandsRun.length}): ${commandsRun.slice(0, 5).join(' · ')}${commandsRun.length > 5 ? ' …' : ''}`)
  if (hasUsage) {
    const i = usage!.inputTokens ?? 0
    const o = usage!.outputTokens ?? 0
    const c = usage!.cachedInputTokens ?? 0
    detailLines.push(`Токены: ↑${i} ↓${o}${c > 0 ? ` ⟲${c}` : ''}`)
  }
  if (text && text.length > firstLine.length) {
    const rest = text.slice(firstLine.length).trim()
    if (rest) detailLines.push(rest.slice(0, 600))
  }
  if (reason !== 'completed') {
    detailLines.unshift(`Состояние: ${reason}`)
  }
  try { recordJournal(projectPath, 'session', title, detailLines.join('\n') || null) } catch { /* journal not critical */ }
}
