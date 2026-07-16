import { spawn } from 'child_process'
import { platform } from 'os'
import { existsSync } from 'fs'
import { join } from 'path'
import type { ChatProvider, ChatMessage, ChatEvent, ToolDefinition, ToolResult } from './types'
import { normalizedUsage } from '../../shared/contracts/usage'
import { buildCliPrompt } from './cli-prompt'
import { treeKill } from './child-kill'
import type { AgentMode } from './mode-policy'

/**
 * Аудит M7: gemini-cli шлёт assistant-сообщение accumulated (каждое событие —
 * полный текст с начала), а не дельтой. Без дедупа чат превращается в кашу из
 * нарастающих повторов. Хелпер вычисляет хвост для эмита и новое «прежнее»:
 * - full начинается с prev (accumulated) → delta = хвост, next = full;
 * - иначе (delta-style независимый чанк) → delta = full, next = prev + full.
 * Экспортируется для unit-теста парсера (см. также M11).
 */
export function dedupAccumulatedText(prev: string, full: string): { delta: string; next: string } {
  if (full.startsWith(prev)) return { delta: full.slice(prev.length), next: full }
  return { delta: full, next: prev + full }
}

interface GeminiCliOptions {
  binary?: string  // override path for testing
  cwd?: string
  model?: string
  signal?: AbortSignal
  projectSystemPrompt?: string | null
  /** Промпт активного скилла — наслаивается секцией <skill_layer> в buildCliPrompt. */
  skillPrompt?: string | null
  memories?: Array<{ type: string; content: string; tags: string[] }>
  agentMode?: AgentMode
}

// CLI distinguishes between alias names it actually knows and what we expose
// in the model picker. Alias `gemini-3.5-flash` in the API maps to the same
// underlying model the CLI calls `gemini-3-flash-preview` (per Google docs as
// of 2026-05). Keep aliases that real CLI builds accept; the auth shell
// returns status=error if -m gets an unknown alias.
export const GEMINI_CLI_MODELS = [
  'auto',
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash'
]

function findBinary(): string {
  if (platform() === 'win32') {
    const home = process.env.APPDATA ?? ''
    const candidates = [
      join(home, 'npm', 'gemini.cmd'),
      join(home, 'npm', 'gemini.ps1')
    ]
    for (const c of candidates) if (existsSync(c)) return c
  }
  return 'gemini'
}

interface CliEvent {
  type: 'init' | 'message' | 'result' | 'tool_call' | 'tool_result' | 'usage' | string
  role?: 'user' | 'assistant' | 'system'
  content?: string
  delta?: boolean
  status?: string
  // Token usage — Gemini CLI emits these in `result` and/or `usage` events.
  // Field names vary across CLI versions; we accept several.
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cached_input_tokens?: number
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
  input_tokens?: number
  output_tokens?: number
  cached_input_tokens?: number
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  tokens?: { input?: number; output?: number; cached?: number }
}

export function createGeminiCliProvider(opts: GeminiCliOptions = {}): ChatProvider {
  const binary = opts.binary ?? findBinary()
  const cwd = opts.cwd ?? process.cwd()

  return {
    id: 'gemini-cli',
    name: 'Gemini CLI (subscription)',
    models: GEMINI_CLI_MODELS,

    async *send(messages: ChatMessage[], _tools: ToolDefinition[], _results?: ToolResult[]): AsyncIterable<ChatEvent> {
      let userMessage: string
      try {
        userMessage = await buildCliPrompt({
          providerId: 'gemini-cli',
          projectPath: opts.cwd ?? null,
          messages,
          projectSystemPrompt: opts.projectSystemPrompt,
          skillPrompt: opts.skillPrompt,
          memories: opts.memories,
          agentMode: opts.agentMode
        })
      } catch (err) {
        yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
        return
      }

      const args = ['--output-format', 'stream-json']
      if (opts.model && opts.model !== 'auto') {
        args.push('-m', opts.model)
      }
      const child = spawn(binary, args, {
        cwd,
        shell: binary.endsWith('.cmd') || binary.endsWith('.ps1'),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })

      // Send the user prompt via stdin so quotes/newlines/unicode survive intact.
      try {
        child.stdin.write(userMessage)
        child.stdin.end()
      } catch (err) {
        yield { type: 'error', message: `Не удалось передать промт в Gemini CLI: ${err instanceof Error ? err.message : String(err)}` }
        treeKill(child)
        return
      }

      // Allow the caller to abort by killing the subprocess.
      let abortListener: (() => void) | null = null
      if (opts.signal) {
        abortListener = () => { treeKill(child) }
        opts.signal.addEventListener('abort', abortListener, { once: true })
      }

      let stdoutBuffer = ''
      let stderrBuffer = ''
      const events: ChatEvent[] = []
      let done = false
      let resolve: (() => void) | null = null
      // Аудит M7: gemini-cli шлёт assistant-сообщение accumulated (каждое событие —
      // полный текст с начала, не дельта). Без дедупа чат = нарастающие повторы.
      // Держим предыдущий полный текст и эмитим только новый хвост.
      let prevAssistant = ''

      const wake = () => { if (resolve) { const r = resolve; resolve = null; r() } }

      /** Extract token usage from a CLI event in whatever shape this CLI version uses. */
      function extractUsage(ev: CliEvent): { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | null {
        // Shape 1: ev.usage = { input_tokens, output_tokens, cached_input_tokens }
        if (ev.usage) {
          const u = ev.usage
          const input = u.input_tokens ?? u.prompt_tokens
          const output = u.output_tokens ?? u.completion_tokens
          if (input != null || output != null) {
            return { inputTokens: input, outputTokens: output, cachedInputTokens: u.cached_input_tokens }
          }
        }
        // Shape 2: flat input_tokens/output_tokens on the event
        if (ev.input_tokens != null || ev.output_tokens != null || ev.prompt_tokens != null) {
          return {
            inputTokens: ev.input_tokens ?? ev.prompt_tokens,
            outputTokens: ev.output_tokens ?? ev.completion_tokens,
            cachedInputTokens: ev.cached_input_tokens
          }
        }
        // Shape 3: ev.tokens = { input, output, cached }
        if (ev.tokens && (ev.tokens.input != null || ev.tokens.output != null)) {
          return { inputTokens: ev.tokens.input, outputTokens: ev.tokens.output, cachedInputTokens: ev.tokens.cached }
        }
        return null
      }

      function processLine(line: string) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) return  // skip warnings, status lines
        let ev: CliEvent
        try { ev = JSON.parse(trimmed) } catch { return }

        if (ev.type === 'message' && ev.role === 'assistant' && ev.content) {
          // Accumulated → дельта (см. dedupAccumulatedText).
          const { delta, next } = dedupAccumulatedText(prevAssistant, ev.content)
          prevAssistant = next
          if (delta) {
            events.push({ type: 'text', text: delta })
            wake()
          }
        } else if (ev.type === 'usage') {
          const u = extractUsage(ev)
          if (u) {
            events.push({ type: 'usage', usage: normalizedUsage({ inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cachedInputTokens, inputAccounting: 'unknown', model: opts.model ?? 'gemini-cli' }) })
            wake()
          }
        } else if (ev.type === 'result') {
          // Result event from Gemini CLI also carries final usage — pick it up
          // here too so we don't miss it if the CLI never emits a separate
          // `usage` event between message and result.
          const u = extractUsage(ev)
          if (u) {
            events.push({ type: 'usage', usage: normalizedUsage({ inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cachedInputTokens, inputAccounting: 'unknown', model: opts.model ?? 'gemini-cli' }) })
          }
          if (ev.status === 'success') {
            events.push({ type: 'done' })
          } else {
            const hint = opts.model && opts.model !== 'auto'
              ? ` Возможно модель "${opts.model}" не поддерживается CLI — попробуй "auto" или 2.5-pro/flash.`
              : ''
            const tail = stderrBuffer.trim().slice(-400)
            events.push({
              type: 'error',
              message: `CLI завершился со статусом: ${ev.status ?? 'unknown'}.${hint}${tail ? ` stderr: ${tail}` : ''}`
            })
          }
          wake()
        }
      }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk
        let idx
        while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, idx)
          stdoutBuffer = stdoutBuffer.slice(idx + 1)
          processLine(line)
        }
      })

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => { stderrBuffer += chunk })

      child.on('error', (err) => {
        events.push({ type: 'error', message: `Запуск Gemini CLI не удался: ${err.message}` })
        done = true
        wake()
      })

      child.on('close', (code) => {
        if (stdoutBuffer.length > 0) processLine(stdoutBuffer)
        if (code !== 0 && !events.some(e => e.type === 'done')) {
          events.push({ type: 'error', message: `Gemini CLI вышел с кодом ${code}.${stderrBuffer ? ' ' + stderrBuffer.slice(0, 400) : ''}` })
        }
        done = true
        wake()
      })

      try {
      while (!done || events.length > 0) {
        if (events.length === 0) {
          await new Promise<void>(r => { resolve = r })
          continue
        }
        const ev = events.shift()!
        yield ev
        if (ev.type === 'done' || ev.type === 'error') {
          treeKill(child)
          return
        }
      }
      } finally {
        if (opts.signal && abortListener) {
          try { opts.signal.removeEventListener('abort', abortListener) } catch { /* noop */ }
        }
      }
    }
  }
}
