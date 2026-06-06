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
  /** Project-specific prompt (Project Settings → «Системный промпт проекта»).
   *  Пробрасывается в buildCliPrompt, дописывается к user_layer. */
  projectSystemPrompt?: string | null
  /** Промпт активного скилла — наслаивается секцией <skill_layer> в buildCliPrompt. */
  skillPrompt?: string | null
  /** Long-lived OAuth token из `claude setup-token`. Передаётся как env var
   *  CLAUDE_CODE_OAUTH_TOKEN дочернему процессу. Это решает headless+Max
   *  ограничение Claude Code v2.1+. */
  oauthToken?: string | null
  memories?: Array<{ type: string; content: string; tags: string[] }>
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
  error_status?: number
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
  /** Init event содержит apiKeySource: 'none' если headless mode не нашёл
   *  ни ANTHROPIC_API_KEY env, ни subscription token. Это известная штука:
   *  Claude Code в --print режиме НЕ использует Max OAuth, требует API key. */
  apiKeySource?: 'none' | 'env' | 'config' | string
}

/** Понятное сообщение про headless+Max ограничение. Известная штука Anthropic:
 *  CLI Pro/Max OAuth работает только в interactive TTY. Для --print нужен
 *  API key через ANTHROPIC_API_KEY env или через провайдера Claude (API) в GG. */
const HEADLESS_NO_AUTH_HINT =
  'Claude Code не нашёл credentials для headless (--print) режима. ' +
  'ИСПРАВИТЬ: открой PowerShell и выполни `claude setup-token` — откроется браузер, ' +
  'подтверди подписку, и Claude Code получит long-lived token для headless. После ' +
  'этого здесь сразу заработает (пересборки Verstak не нужно). ' +
  'Альтернативы: переключись на провайдера «Claude (API)» с key из console.anthropic.com, ' +
  'или используй Gemini Ultra / Grok Build / Codex (CLI) — у них headless с подпиской работает из коробки.'

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
          messages,
          projectSystemPrompt: opts.projectSystemPrompt,
          skillPrompt: opts.skillPrompt,
          memories: opts.memories
        })
      } catch (err) {
        yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
        return
      }

      const args = ['--print', '--output-format', 'stream-json', '--verbose']
      if (opts.model && opts.model !== 'auto') {
        args.push('--model', opts.model)
      }
      // OAuth token из Settings → env var дочернему процессу. Это решает
      // headless+Max ограничение Claude Code (см. fix(claude-cli): нашёл
      // решение headless+Max в DEVLOG). Сначала env из текущего процесса,
      // потом — наш токен поверх, чтобы он перекрывал даже если в системе
      // стоит другой.
      const env: Record<string, string> = { ...(process.env as Record<string, string>) }
      if (opts.oauthToken) {
        env.CLAUDE_CODE_OAUTH_TOKEN = opts.oauthToken
      }
      const child = spawn(binary, args, {
        cwd,
        shell: binary.endsWith('.cmd') || binary.endsWith('.ps1'),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env
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

      // Флаг: Claude Code пожаловался что нет credentials в headless режиме.
      // Выставляется на init event с apiKeySource='none' и используется при
      // финальной ошибке чтобы выдать понятный HEADLESS_NO_AUTH_HINT.
      let suspectHeadlessAuth = false

      function processLine(line: string) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) return
        let ev: CliEvent
        try { ev = JSON.parse(trimmed) } catch { return }

        // Известная авто-диагностика: init event сразу говорит откуда взялись
        // (или НЕ взялись) credentials. Если apiKeySource='none' — мы знаем
        // что 401 впереди, и можем выдать понятное сообщение.
        if (ev.type === 'system' && ev.subtype === 'init' && ev.apiKeySource === 'none') {
          suspectHeadlessAuth = true
        }
        // api_retry с 401 — финальная подтверждение что headless auth не сработал
        if (ev.type === 'system' && ev.subtype === 'api_retry' && ev.error_status === 401) {
          if (suspectHeadlessAuth) {
            queue.push({ type: 'error', message: HEADLESS_NO_AUTH_HINT })
            done = true
            wake()
            return
          }
        }

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
        if (code !== 0 && !queue.some(e => e.type === 'done' || e.type === 'error')) {
          // Если перехватили "apiKeySource: none" по дороге — это headless+auth
          // ограничение, выдаём понятное сообщение вместо raw exit code.
          if (suspectHeadlessAuth) {
            queue.push({ type: 'error', message: HEADLESS_NO_AUTH_HINT })
          } else {
            queue.push({ type: 'error', message: `Claude CLI exit ${code}. ${stderrBuffer.slice(0, 400)}` })
          }
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
