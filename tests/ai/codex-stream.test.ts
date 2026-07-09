import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { platform } from 'os'
import { createCodexCliProvider } from '../../electron/ai/codex-cli'
import type { ChatEvent } from '../../electron/ai/types'

// Fake codex binary: a node script that ignores stdin and prints a fixed
// JSONL stream to stdout, exit 0. Drives the REAL provider parser.
function makeFakeCodex(dir: string, lines: string[]): string {
  const isWin = platform() === 'win32'
  const scriptJs = join(dir, 'fake-codex.js')
  // Read all of stdin then emit the canned stream.
  const body = `
let buf = ''
process.stdin.on('data', d => { buf += d })
process.stdin.on('end', () => {
  const out = ${JSON.stringify(lines)}
  for (const l of out) process.stdout.write(l + '\\n')
  process.exit(0)
})
`
  writeFileSync(scriptJs, body, 'utf8')
  if (isWin) {
    const cmd = join(dir, 'fake-codex.cmd')
    writeFileSync(cmd, `@echo off\r\nnode "${scriptJs}" %*\r\n`, 'utf8')
    return cmd
  }
  const sh = join(dir, 'fake-codex')
  writeFileSync(sh, `#!/bin/sh\nexec node "${scriptJs}" "$@"\n`, 'utf8')
  chmodSync(sh, 0o755)
  return sh
}

async function drain(provider: ReturnType<typeof createCodexCliProvider>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = []
  for await (const ev of provider.send([{ role: 'user', content: 'третий вопрос' }], [])) {
    events.push(ev)
  }
  return events
}

describe('codex-cli stream parsing — chat-response regression', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-probe-'))
    writeFileSync(join(dir, 'package.json'), '{}')
  })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* win file lock */ } })

  it('standard stream: thread.started → item.completed(agent_message) → turn.completed', async () => {
    const bin = makeFakeCodex(dir, [
      JSON.stringify({ type: 'thread.started', thread_id: 'thr_1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Ответ Codex на третье сообщение' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20, cached_input_tokens: 0 } })
    ])
    const provider = createCodexCliProvider({ binary: bin, cwd: dir })
    const events = await drain(provider)
    const text = events.filter(e => e.type === 'text').map(e => (e as { text: string }).text).join('')
    expect(text).toBe('Ответ Codex на третье сообщение')
    expect(events.some(e => e.type === 'done')).toBe(true)
  })

  it('reasoning item before agent_message does not swallow the answer', async () => {
    const bin = makeFakeCodex(dir, [
      JSON.stringify({ type: 'thread.started', thread_id: 'thr_1' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'думаю...' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'финальный ответ' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 7 } })
    ])
    const provider = createCodexCliProvider({ binary: bin, cwd: dir })
    const events = await drain(provider)
    const text = events.filter(e => e.type === 'text').map(e => (e as { text: string }).text).join('')
    expect(text).toBe('финальный ответ')
    expect(events.some(e => e.type === 'done')).toBe(true)
  })

  it('stream ends WITHOUT turn.completed still emits done (some codex versions)', async () => {
    // Some codex builds close the process after the agent_message item with no
    // explicit turn.completed. The provider must still terminate the stream
    // with a done event so the runner/renderer stop streaming.
    const bin = makeFakeCodex(dir, [
      JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'ответ без turn.completed' } })
    ])
    const provider = createCodexCliProvider({ binary: bin, cwd: dir })
    const events = await drain(provider)
    const text = events.filter(e => e.type === 'text').map(e => (e as { text: string }).text).join('')
    expect(text).toBe('ответ без turn.completed')
    expect(events.some(e => e.type === 'done')).toBe(true)
  })

  it('REGRESSION: reasoning-only turn (no agent_message) — must NOT report empty success', async () => {
    // Reproduces the owner's symptom: codex emits its reasoning summary and a
    // turn.completed, but the final answer never arrives as an agent_message
    // item (happens on follow-up turns / reasoning models). Previously the
    // provider emitted done with ZERO text → notification fired, chat empty.
    const bin = makeFakeCodex(dir, [
      JSON.stringify({ type: 'thread.started', thread_id: 'thr_3' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'Пользователь спросил X. Отвечаю...' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 0 } })
    ])
    const provider = createCodexCliProvider({ binary: bin, cwd: dir })
    const events = await drain(provider)
    const text = events.filter(e => e.type === 'text').map(e => (e as { text: string }).text).join('')
    // The answer must surface to the user one way or another (reasoning text
    // as a fallback) rather than an empty bubble + a "done" notification.
    expect(text.length).toBeGreaterThan(0)
    // Ровно один done — turn.completed и close не должны дублировать терминал.
    expect(events.filter(e => e.type === 'done')).toHaveLength(1)
  })

  it('проецирует родные tool-item Codex (command_execution/file_change) как tool-call', async () => {
    const bin = makeFakeCodex(dir, [
      JSON.stringify({ type: 'thread.started', thread_id: 'thr_t' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'npm test' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'p1', type: 'file_change', path: 'src/a.ts' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'Готово.' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 50, output_tokens: 10 } })
    ])
    const provider = createCodexCliProvider({ binary: bin, cwd: dir })
    const events = await drain(provider)
    const tools = events.filter(e => e.type === 'tool-call') as Array<Extract<ChatEvent, { type: 'tool-call' }>>
    expect(tools.map(t => t.call.name)).toEqual(['run_command', 'apply_patch'])
    expect(tools[0].call.args).toEqual({ command: 'npm test' })
    expect(tools[1].call.args).toEqual({ path: 'src/a.ts' })
    expect(events.filter(e => e.type === 'text').map(e => (e as { text: string }).text).join('')).toContain('Готово')
  })
})
