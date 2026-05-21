import { spawn } from 'child_process'
import { platform } from 'os'
import { existsSync } from 'fs'
import { join } from 'path'
import type { ChatProvider, ChatMessage, ChatEvent, ToolDefinition, ToolResult } from './types'
import { buildCliPrompt } from './cli-prompt'
import { treeKill } from './child-kill'

interface GrokCliOptions {
  binary?: string
  cwd?: string
  signal?: AbortSignal
  model?: string
}

export const GROK_CLI_MODELS = [
  'auto',
  'grok-4',
  'grok-4-fast',
  'grok-code-fast-1',
  'grok-3'
]

function findBinary(): string {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  if (home) {
    const candidates = [
      join(home, '.grok', 'bin', 'grok'),
      join(home, '.grok', 'bin', 'grok.exe'),
      join(home, '.local', 'bin', 'grok')
    ]
    for (const c of candidates) if (existsSync(c)) return c
  }
  if (platform() === 'win32' && process.env.APPDATA) {
    const cand = join(process.env.APPDATA, 'npm', 'grok.cmd')
    if (existsSync(cand)) return cand
  }
  return 'grok'
}

interface CliEvent {
  type: string
  data?: string
  text?: string
  content?: string
  message?: { content?: string }
  /** For tool_call events */
  name?: string
  args?: Record<string, unknown>
  arguments?: Record<string, unknown>
  /** Error payload */
  error?: string
}

export function createGrokCliProvider(opts: GrokCliOptions = {}): ChatProvider {
  const binary = opts.binary ?? findBinary()
  const cwd = opts.cwd ?? process.cwd()

  return {
    id: 'grok-cli',
    name: 'Grok Build',
    models: GROK_CLI_MODELS,

    async *send(messages: ChatMessage[], _tools: ToolDefinition[], _results?: ToolResult[]): AsyncIterable<ChatEvent> {
      // GROK CLI is unstable with large prompts AND with stdin through .cmd
      // shell wrappers — exit 0xC0000005 ACCESS_VIOLATION reported on both.
      // For grok specifically we fall back to MINIMAL payload (just the user
      // message, no system layer, no context pack) and use stdin without
      // shell when binary is a direct .exe / unix executable.
      const lastUser = messages.filter(m => m.role === 'user').at(-1)
      if (!lastUser?.content) {
        yield { type: 'error', message: 'Нет user-сообщения для отправки' }
        return
      }
      const minimalMode = true  // toggle if grok stabilizes for larger payloads
      let payload: string
      if (minimalMode) {
        payload = lastUser.content
        if (lastUser.attachments?.length) {
          payload += '\n\n' + lastUser.attachments.map(a => `[файл: ${a.name}]`).join('\n')
        }
      } else {
        try {
          payload = await buildCliPrompt({
            providerId: 'grok-cli',
            projectPath: cwd ?? null,
            messages
          })
        } catch (err) {
          yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
          return
        }
      }

      const args = ['--output-format', 'streaming-json', '--no-alt-screen']
      if (opts.model && opts.model !== 'auto') args.push('-m', opts.model)
      // Back to -p argv (this is what worked before parity changes). stdin
      // through cmd.exe wrapper on Windows turned out to be even more unstable.
      // Soft cap to 8KB so we never trip CreateProcess limits or grok's own
      // internal buffers.
      const ARGV_CAP = 8000
      if (payload.length > ARGV_CAP) {
        payload = payload.slice(0, ARGV_CAP) + '\n[truncated]'
      }
      args.push('-p', payload)

      const child = spawn(binary, args, {
        cwd,
        shell: binary.endsWith('.cmd') || binary.endsWith('.ps1'),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })

      try { child.stdin.end() } catch { /* noop */ }

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

        // Text-emitting events. Grok labels its streaming output as "thought"
        // (since it thinks out loud). Also handle generic text variants.
        if (ev.type === 'thought' || ev.type === 'text' || ev.type === 'assistant_message_delta' || ev.type === 'message_delta') {
          const text = ev.data ?? ev.text ?? ev.content ?? ev.message?.content
          if (text) { queue.push({ type: 'text', text }); wake() }
        }
        // Completion event
        else if (ev.type === 'turn_complete' || ev.type === 'done' || ev.type === 'message_complete' || ev.type === 'final') {
          queue.push({ type: 'done' }); wake()
        }
        // Error event
        else if (ev.type === 'error' || ev.type === 'fatal') {
          queue.push({ type: 'error', message: ev.error ?? ev.data ?? 'Grok CLI error' })
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
        queue.push({ type: 'error', message: `Запуск Grok CLI не удался: ${err.message}` })
        done = true; wake()
      })
      child.on('close', (code) => {
        if (stdoutBuffer.length > 0) processLine(stdoutBuffer)
        if (code !== 0 && !queue.some(e => e.type === 'done')) {
          // 0xC0000005 (3221225477) = Windows STATUS_ACCESS_VIOLATION.
          // Grok CLI sometimes crashes on large prompts or odd Unicode.
          // Give the user a hint instead of just the raw exit code.
          let hint = ''
          if (code === 3221225477 || code === -1073741819) {
            hint = ' Похоже, grok CLI сам упал (Windows ACCESS_VIOLATION). Попробуй обновить CLI (см. x.ai) или переключись на Grok (API) в Settings.'
          }
          queue.push({ type: 'error', message: `Grok CLI exit ${code}.${hint}${stderrBuffer ? ' ' + stderrBuffer.slice(0, 400) : ''}` })
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
