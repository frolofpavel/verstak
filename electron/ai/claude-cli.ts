import { spawn } from 'child_process'
import { platform } from 'os'
import { existsSync } from 'fs'
import { join } from 'path'
import type { ChatProvider, ChatMessage, ChatEvent, ToolDefinition, ToolResult } from './types'
import { buildCliPrompt } from './cli-prompt'
import { treeKill } from './child-kill'

interface ClaudeCliOptions {
  binary?: string
  cwd?: string
  signal?: AbortSignal
  model?: string
}

export const CLAUDE_CLI_MODELS = [
  'auto',
  'claude-sonnet-4-6',
  'claude-opus-4-5',
  'claude-haiku-4-5',
  'claude-sonnet-4-5'
]

function findBinary(): string {
  // Claude Code installs to ~/.local/bin/claude by default on Windows/macOS/Linux
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const candidates: string[] = []
  if (home) {
    candidates.push(join(home, '.local', 'bin', 'claude'))
    candidates.push(join(home, '.local', 'bin', 'claude.exe'))
  }
  if (platform() === 'win32' && process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, 'npm', 'claude.cmd'))
  }
  for (const c of candidates) if (existsSync(c)) return c
  return 'claude'
}

interface CliEvent {
  type: string
  subtype?: string
  message?: {
    content?: Array<{ type: string; text?: string }>
    /** Some Claude CLI versions embed token counts inside message.usage on
     *  the assistant event. */
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  is_error?: boolean
  error?: string
  result?: string
  /** Token usage on the final `result` event (Claude Code stream-json shape).
   *  Field names track the Anthropic API: input_tokens, output_tokens,
   *  cache_read_input_tokens. */
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

export function createClaudeCliProvider(opts: ClaudeCliOptions = {}): ChatProvider {
  const binary = opts.binary ?? findBinary()
  const cwd = opts.cwd ?? process.cwd()

  return {
    id: 'claude-cli',
    name: 'Claude Code',
    models: CLAUDE_CLI_MODELS,

    async *send(messages: ChatMessage[], _tools: ToolDefinition[], _results?: ToolResult[]): AsyncIterable<ChatEvent> {
      let payload: string
      try {
        payload = await buildCliPrompt({
          providerId: 'claude-cli',
          projectPath: cwd ?? null,
          messages
        })
      } catch (err) {
        yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
        return
      }

      const args = ['--print', '--output-format', 'stream-json', '--verbose']
      if (opts.model && opts.model !== 'auto') {
        args.push('--model', opts.model)
      }
      const child = spawn(binary, args, {
        cwd,
        shell: binary.endsWith('.cmd') || binary.endsWith('.ps1'),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })

      try {
        child.stdin.write(payload)
        child.stdin.end()
      } catch (err) {
        yield { type: 'error', message: `Claude CLI stdin error: ${err instanceof Error ? err.message : String(err)}` }
        treeKill(child)
        return
      }

      let abortListener: (() => void) | null = null
      if (opts.signal) {
        abortListener = () => { treeKill(child) }
        opts.signal.addEventListener('abort', abortListener, { once: true })
      }

      let stdoutBuffer = ''
      let stderrBuffer = ''
      const queue: ChatEvent[] = []
      let done = false
      let resolve: (() => void) | null = null
      const wake = () => { if (resolve) { const r = resolve; resolve = null; r() } }
      const lastText: Record<string, string> = {}  // delta deduplication per message id

      function processLine(line: string) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) return
        let ev: CliEvent
        try { ev = JSON.parse(trimmed) } catch { return }

        if (ev.type === 'assistant' && ev.message?.content) {
          for (const block of ev.message.content) {
            if (block.type === 'text' && block.text) {
              const id = ev.message ? JSON.stringify(ev.message).slice(0, 32) : 'x'
              const prev = lastText[id] ?? ''
              // The CLI sends accumulated text per partial event — emit only the new tail
              if (block.text.startsWith(prev)) {
                const delta = block.text.slice(prev.length)
                if (delta) queue.push({ type: 'text', text: delta })
                lastText[id] = block.text
              } else {
                queue.push({ type: 'text', text: block.text })
                lastText[id] = block.text
              }
              wake()
            }
          }
        } else if (ev.type === 'assistant' && ev.message?.usage) {
          // Token usage may arrive piggybacked on the assistant event in some
          // CLI versions. Emit a usage event so the chat UI / journal can
          // surface token counts the same way they do for API providers.
          const u = ev.message.usage
          if ((u.input_tokens ?? 0) > 0 || (u.output_tokens ?? 0) > 0) {
            queue.push({
              type: 'usage',
              usage: {
                inputTokens: u.input_tokens,
                outputTokens: u.output_tokens,
                cachedInputTokens: u.cache_read_input_tokens,
                model: opts.model ?? 'claude-cli'
              }
            })
            wake()
          }
        } else if (ev.type === 'result') {
          // Final result event also carries usage — capture it before done so
          // the journal gets a token count even if no assistant.usage fired.
          if (ev.usage && ((ev.usage.input_tokens ?? 0) > 0 || (ev.usage.output_tokens ?? 0) > 0)) {
            queue.push({
              type: 'usage',
              usage: {
                inputTokens: ev.usage.input_tokens,
                outputTokens: ev.usage.output_tokens,
                cachedInputTokens: ev.usage.cache_read_input_tokens,
                model: opts.model ?? 'claude-cli'
              }
            })
          }
          if (ev.is_error) {
            queue.push({ type: 'error', message: ev.error ?? ev.result ?? 'Claude CLI завершился с ошибкой' })
          } else {
            queue.push({ type: 'done' })
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
        queue.push({ type: 'error', message: `Запуск Claude CLI не удался: ${err.message}` })
        done = true; wake()
      })
      child.on('close', (code) => {
        if (stdoutBuffer.length > 0) processLine(stdoutBuffer)
        if (code !== 0 && !queue.some(e => e.type === 'done')) {
          queue.push({ type: 'error', message: `Claude CLI exit ${code}. ${stderrBuffer.slice(0, 400)}` })
        }
        done = true; wake()
      })

      try {
        while (!done || queue.length > 0) {
          if (queue.length === 0) {
            await new Promise<void>(r => { resolve = r })
            continue
          }
          const ev = queue.shift()!
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
