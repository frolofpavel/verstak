import { spawn } from 'child_process'
import { platform } from 'os'
import { existsSync } from 'fs'
import { join } from 'path'
import type { ChatProvider, ChatMessage, ChatEvent, ToolDefinition, ToolResult } from './types'
import { buildCliPrompt } from './cli-prompt'
import { treeKill } from './child-kill'

interface CodexCliOptions {
  binary?: string
  cwd?: string
  signal?: AbortSignal
  model?: string
  projectSystemPrompt?: string | null
  /** Промпт активного скилла — наслаивается секцией <skill_layer> в buildCliPrompt. */
  skillPrompt?: string | null
  memories?: Array<{ type: string; content: string; tags: string[] }>
}

export const CODEX_CLI_MODELS = [
  'auto',
  'gpt-5-codex',
  'gpt-5',
  'gpt-5-mini',
  'o3',
  'o3-mini',
  'gpt-4o'
]

function findBinary(): string {
  if (platform() === 'win32' && process.env.APPDATA) {
    const candidates = [
      join(process.env.APPDATA, 'npm', 'codex.cmd'),
      join(process.env.APPDATA, 'npm', 'codex.ps1')
    ]
    for (const c of candidates) if (existsSync(c)) return c
  }
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (home) {
    const local = join(home, '.local', 'bin', 'codex')
    if (existsSync(local)) return local
  }
  return 'codex'
}

interface CliEvent {
  type: string
  item?: { type?: string; text?: string }
  error?: string
  /** Codex token counts. Field names track OpenAI completions API:
   *  prompt_tokens (input), completion_tokens (output), cache hits as
   *  prompt_tokens_details.cached_tokens. May arrive on turn.completed
   *  or on dedicated token_count events. */
  usage?: {
    input_tokens?: number
    output_tokens?: number
    prompt_tokens?: number
    completion_tokens?: number
    cached_input_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  token_usage?: {
    input_tokens?: number
    output_tokens?: number
    cached_input_tokens?: number
  }
}

export function createCodexCliProvider(opts: CodexCliOptions = {}): ChatProvider {
  const binary = opts.binary ?? findBinary()
  const cwd = opts.cwd ?? process.cwd()

  return {
    id: 'codex-cli',
    name: 'Codex',
    models: CODEX_CLI_MODELS,

    async *send(messages: ChatMessage[], _tools: ToolDefinition[], _results?: ToolResult[]): AsyncIterable<ChatEvent> {
      let payload: string
      try {
        payload = await buildCliPrompt({
          providerId: 'codex-cli',
          projectPath: cwd ?? null,
          messages,
          projectSystemPrompt: opts.projectSystemPrompt,
          skillPrompt: opts.skillPrompt,
          memories: opts.memories
        })
      } catch (err) {
        yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
        return
      }

      // --skip-git-repo-check: разрешает работу вне доверенной git-директории.
      // Без этого Codex CLI exit 1 с "Not inside a trusted directory".
      const args = ['exec', '--json', '--skip-git-repo-check']
      if (opts.model && opts.model !== 'auto') {
        args.push('-m', opts.model)
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
        yield { type: 'error', message: `Codex CLI stdin error: ${err instanceof Error ? err.message : String(err)}` }
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

      function processLine(line: string) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) return
        let ev: CliEvent
        try { ev = JSON.parse(trimmed) } catch { return }

        if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) {
          queue.push({ type: 'text', text: ev.item.text })
          wake()
        } else if (ev.type === 'turn.completed') {
          // turn.completed carries final token usage in some Codex versions.
          // Field names vary: `usage.{input,output,cached_input}_tokens` OR
          // `usage.{prompt,completion}_tokens` OR `token_usage.*`. Accept all.
          const u = ev.usage ?? ev.token_usage
          if (u) {
            const input = u.input_tokens ?? (u as { prompt_tokens?: number }).prompt_tokens
            const output = u.output_tokens ?? (u as { completion_tokens?: number }).completion_tokens
            const cached = u.cached_input_tokens ?? (u as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details?.cached_tokens
            if ((input ?? 0) > 0 || (output ?? 0) > 0) {
              queue.push({
                type: 'usage',
                usage: { inputTokens: input, outputTokens: output, cachedInputTokens: cached, model: opts.model ?? 'codex-cli' }
              })
            }
          }
          queue.push({ type: 'done' })
          wake()
        } else if (ev.type === 'error') {
          queue.push({ type: 'error', message: ev.error ?? 'Codex CLI вернул error' })
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
        queue.push({ type: 'error', message: `Запуск Codex CLI не удался: ${err.message}` })
        done = true; wake()
      })
      child.on('close', (code) => {
        if (stdoutBuffer.length > 0) processLine(stdoutBuffer)
        if (code !== 0 && !queue.some(e => e.type === 'done')) {
          queue.push({ type: 'error', message: `Codex CLI exit ${code}. ${stderrBuffer.slice(0, 400)}` })
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
