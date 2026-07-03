import { describe, it, expect } from 'vitest'
import { resolveToolMode, isCoaxableProvider, JSON_TOOL_INSTRUCTION } from '../../electron/ai/tool-mode'

describe('resolveToolMode', () => {
  it('reasoning-модели без function calling → json', () => {
    expect(resolveToolMode('deepseek', 'deepseek-reasoner')).toBe('json')
    expect(resolveToolMode('openrouter', 'deepseek/deepseek-r1')).toBe('json')
    expect(resolveToolMode('deepseek', 'DEEPSEEK-R1-0528')).toBe('json')
  })

  it('локальный Ollama → json (native tool_calls часто не реализованы)', () => {
    expect(resolveToolMode('ollama', 'llama3.3')).toBe('json')
  })

  it('обычные chat/coder модели → native (поведение не меняется)', () => {
    expect(resolveToolMode('deepseek', 'deepseek-v4-flash')).toBe('native')
    expect(resolveToolMode('deepseek', 'deepseek-chat')).toBe('native')
    expect(resolveToolMode('qwen', 'qwen3-coder-plus')).toBe('native')
    expect(resolveToolMode('moonshot', 'kimi-k2.7-code')).toBe('native')
    expect(resolveToolMode('claude', 'claude-sonnet-4-6')).toBe('native')
    expect(resolveToolMode(undefined, undefined)).toBe('native')
  })

  it('не путает r1 внутри других имён (mistral-large ≠ r1)', () => {
    expect(resolveToolMode('mistral', 'mistral-large-latest')).toBe('native')
    expect(resolveToolMode('qwen', 'qwen3-max')).toBe('native')
  })
})

describe('isCoaxableProvider', () => {
  it('китайские/дешёвые OpenAI-compat — coaxable (нужен corrective nudge)', () => {
    expect(isCoaxableProvider('deepseek')).toBe(true)
    expect(isCoaxableProvider('qwen')).toBe(true)
    expect(isCoaxableProvider('moonshot')).toBe(true)
    expect(isCoaxableProvider('ollama')).toBe(true)
    expect(isCoaxableProvider('custom-openai')).toBe(true)
  })

  it('frontier/RU — не coaxable (надёжны, nudge дал бы ложные срабатывания)', () => {
    expect(isCoaxableProvider('claude')).toBe(false)
    expect(isCoaxableProvider('openai')).toBe(false)
    expect(isCoaxableProvider('gemini-api')).toBe(false)
    expect(isCoaxableProvider('yandex-gpt')).toBe(false)
    expect(isCoaxableProvider('gigachat')).toBe(false)
    expect(isCoaxableProvider(undefined)).toBe(false)
  })
})

describe('JSON_TOOL_INSTRUCTION', () => {
  it('содержит формат, который распознаёт parseTextToolCalls', () => {
    expect(JSON_TOOL_INSTRUCTION).toContain('<tool_call>')
    expect(JSON_TOOL_INSTRUCTION).toContain('"arguments"')
  })
})
