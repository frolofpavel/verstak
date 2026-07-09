import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir, platform } from 'os'
import { createClaudeCliProvider } from '../../electron/ai/claude-cli'
import type { ChatEvent } from '../../electron/ai/types'

// Фейковый claude-бинарь: node-скрипт, игнорит stdin и печатает канонный
// stream-json в stdout, exit 0. Драйвит РЕАЛЬНЫЙ парсер claude-cli.
function makeFakeClaude(dir: string, lines: string[]): string {
  const isWin = platform() === 'win32'
  const scriptJs = join(dir, 'fake-claude.js')
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
    const cmd = join(dir, 'fake-claude.cmd')
    writeFileSync(cmd, `@echo off\r\nnode "${scriptJs}" %*\r\n`, 'utf8')
    return cmd
  }
  const sh = join(dir, 'fake-claude')
  writeFileSync(sh, `#!/bin/sh\nexec node "${scriptJs}" "$@"\n`, 'utf8')
  chmodSync(sh, 0o755)
  return sh
}

async function drain(bin: string, cwd: string): Promise<ChatEvent[]> {
  const provider = createClaudeCliProvider({ binary: bin, cwd })
  const events: ChatEvent[] = []
  for await (const ev of provider.send([{ role: 'user', content: 'почини баг' }], [])) {
    events.push(ev)
  }
  return events
}

describe('claude-cli tool-use projection (1.9.x felt-win)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-proj-'))
    writeFileSync(join(dir, 'package.json'), '{}')
  })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* win file lock */ } })

  it('проецирует tool_use-блоки как tool-call события (раньше выбрасывались)', async () => {
    const bin = makeFakeClaude(dir, [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/a.ts' } },
      ] } }),
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'toolu_2', name: 'Edit', input: { file_path: 'src/a.ts', old: 'x', new: 'y' } },
      ] } }),
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'text', text: 'Готово, поправил.' },
      ] } }),
      JSON.stringify({ type: 'result', result: 'ok' }),
    ])
    const events = await drain(bin, dir)

    const toolCalls = events.filter(e => e.type === 'tool-call') as Array<Extract<ChatEvent, { type: 'tool-call' }>>
    expect(toolCalls.map(t => t.call.name)).toEqual(['Read', 'Edit'])
    expect(toolCalls[0].call.args).toEqual({ file_path: 'src/a.ts' })
    // текст по-прежнему приходит (проекция не ломает текстовый путь)
    const text = events.filter(e => e.type === 'text').map(e => (e as { text: string }).text).join('')
    expect(text).toContain('Готово')
  })

  it('без tool_use — только текст, ноль tool-call', async () => {
    const bin = makeFakeClaude(dir, [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Просто ответ.' }] } }),
      JSON.stringify({ type: 'result', result: 'ok' }),
    ])
    const events = await drain(bin, dir)
    expect(events.some(e => e.type === 'tool-call')).toBe(false)
    expect(events.some(e => e.type === 'text')).toBe(true)
  })
})
