import { describe, it, expect } from 'vitest'
import { toResponseInput } from '../../../electron/ai/codex-oauth/provider'
import type { ChatMessage, ToolResult } from '../../../electron/ai/types'

describe('toResponseInput — маппинг истории Verstak в Responses input[]', () => {
  it('system → instructions (не в input); user → input_text', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'Ты помощник' },
      { role: 'user', content: 'привет' },
    ]
    const { input, instructions } = toResponseInput(msgs)
    expect(instructions).toBe('Ты помощник')
    expect(input).toHaveLength(1)
    expect(input[0]).toEqual({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'привет' }] })
  })

  it('assistant с toolCalls → message + function_call items (arguments = JSON-строка)', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: 'сейчас прочитаю', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.txt' } }] },
    ]
    const { input } = toResponseInput(msgs)
    expect(input[0]).toMatchObject({ type: 'message', role: 'assistant' })
    expect(input[1]).toEqual({ type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' })
  })

  it('toolResults (в user-сообщении и отдельным параметром) → function_call_output', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: '', toolResults: [{ id: 'c1', name: 'read_file', result: 'содержимое' }] },
    ]
    const extra: ToolResult[] = [{ id: 'c2', name: 'run', result: { ok: true } }]
    const { input } = toResponseInput(msgs, extra)
    expect(input[0]).toEqual({ type: 'function_call_output', call_id: 'c1', output: 'содержимое' })
    expect(input[1]).toEqual({ type: 'function_call_output', call_id: 'c2', output: '{"ok":true}' })
  })

  it('toolResult с error → Error: prefix', () => {
    const { input } = toResponseInput([{ role: 'user', content: '', toolResults: [{ id: 'c1', name: 'x', result: null, error: 'boom' }] }])
    expect(input[0]).toEqual({ type: 'function_call_output', call_id: 'c1', output: 'Error: boom' })
  })

  it('пустой system → дефолтные instructions', () => {
    const { instructions } = toResponseInput([{ role: 'user', content: 'hi' }])
    expect(instructions).toBe('You are a coding assistant.')
  })
})
