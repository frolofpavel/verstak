import { spawn } from 'child_process'
import { platform } from 'os'
import { existsSync } from 'fs'
import { join } from 'path'
import type { ChatProvider, ChatMessage, ChatEvent, ToolDefinition, ToolResult } from './types'

interface GeminiCliOptions {
  binary?: string  // override path for testing
  cwd?: string
  model?: string
}

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
  type: 'init' | 'message' | 'result' | 'tool_call' | 'tool_result' | string
  role?: 'user' | 'assistant' | 'system'
  content?: string
  delta?: boolean
  status?: string
}

export function createGeminiCliProvider(opts: GeminiCliOptions = {}): ChatProvider {
  const binary = opts.binary ?? findBinary()
  const cwd = opts.cwd ?? process.cwd()

  return {
    id: 'gemini-cli',
    name: 'Gemini CLI (subscription)',
    models: ['auto'],

    async *send(messages: ChatMessage[], _tools: ToolDefinition[], _results?: ToolResult[]): AsyncIterable<ChatEvent> {
      const userMessage = messages.filter(m => m.role === 'user').at(-1)?.content
      if (!userMessage) {
        yield { type: 'error', message: 'Нет user-сообщения для отправки' }
        return
      }

      const args = ['--output-format', 'stream-json']
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
        try { child.kill() } catch { /* noop */ }
        return
      }

      let stdoutBuffer = ''
      let stderrBuffer = ''
      const events: ChatEvent[] = []
      let done = false
      let resolve: (() => void) | null = null

      const wake = () => { if (resolve) { const r = resolve; resolve = null; r() } }

      function processLine(line: string) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) return  // skip warnings, status lines
        let ev: CliEvent
        try { ev = JSON.parse(trimmed) } catch { return }

        if (ev.type === 'message' && ev.role === 'assistant' && ev.content) {
          events.push({ type: 'text', text: ev.content })
          wake()
        } else if (ev.type === 'result') {
          if (ev.status === 'success') {
            events.push({ type: 'done' })
          } else {
            events.push({ type: 'error', message: `CLI завершился со статусом: ${ev.status ?? 'unknown'}` })
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

      while (!done || events.length > 0) {
        if (events.length === 0) {
          await new Promise<void>(r => { resolve = r })
          continue
        }
        const ev = events.shift()!
        yield ev
        if (ev.type === 'done' || ev.type === 'error') {
          try { child.kill() } catch { /* already exited */ }
          return
        }
      }
    }
  }
}
