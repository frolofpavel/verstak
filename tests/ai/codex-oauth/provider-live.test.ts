import { describe, it, expect } from 'vitest'
import { createCodexOAuthProvider } from '../../../electron/ai/codex-oauth/provider'
import type { ChatEvent, ChatMessage, ToolDefinition } from '../../../electron/ai/types'

// Live end-to-end на РЕАЛЬНОМ codex-аккаунте. Гейт: RUN_CODEX_IT=1 (иначе skip).
// Формат подтверждён смоуком; здесь валидируем ПОЛНЫЙ провайдер (creds→POST→SSE→ChatEvent).
const RUN = process.env.RUN_CODEX_IT === '1'
const MODEL = process.env.CODEX_IT_MODEL || 'gpt-5.6-sol'

async function collect(gen: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

describe.skipIf(!RUN)('codex-oauth provider — LIVE', () => {
  it('текстовый ответ: text + usage + done', async () => {
    const p = createCodexOAuthProvider({ model: MODEL, appVersion: '2.0.0' })
    const msgs: ChatMessage[] = [{ role: 'user', content: 'Reply with exactly: OK' }]
    const events = await collect(p.send(msgs, [], undefined))
    const text = events.filter(e => e.type === 'text').map(e => (e as { text: string }).text).join('')
    expect(text.toUpperCase()).toContain('OK')
    expect(events.some(e => e.type === 'usage')).toBe(true)
    expect(events.some(e => e.type === 'done')).toBe(true)
    expect(events.some(e => e.type === 'error')).toBe(false)
  }, 60000)

  it('function calling: модель зовёт объявленный tool', async () => {
    const p = createCodexOAuthProvider({ model: MODEL, appVersion: '2.0.0' })
    const tools: ToolDefinition[] = [{
      name: 'get_weather',
      description: 'Получить погоду в городе',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
    }]
    const msgs: ChatMessage[] = [{ role: 'user', content: 'Какая погода в Москве? Обязательно вызови get_weather.' }]
    const events = await collect(p.send(msgs, tools, undefined))
    const toolCalls = events.filter(e => e.type === 'tool-call')
    expect(toolCalls.length).toBeGreaterThan(0)
    const call = (toolCalls[0] as { call: { name: string; args: Record<string, unknown> } }).call
    expect(call.name).toBe('get_weather')
    expect(typeof call.args).toBe('object')  // arguments распарсились из JSON-строки
  }, 60000)
})
