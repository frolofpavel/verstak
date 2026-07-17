import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatEvent } from '../../electron/ai/types'

// Мок SDK `openai`: перехватываем аргументы chat.completions.create, чтобы
// проверить, КАК ушёл user-content (строкой-текстом или массивом с image_url).
// Дефект 3: buildUserContent безусловно слал image_url всем OpenAI-совместимым —
// провайдер без vision (zai-coding) отвечал 400 и прогон умирал, теряя текст.
let lastCreateArgs: { messages?: Array<{ role: string; content: unknown }> } | null = null
vi.mock('openai', () => ({
  default: class {
    chat = {
      completions: {
        create: vi.fn(async (args: unknown) => {
          lastCreateArgs = args as typeof lastCreateArgs
          return (async function* () {
            yield { choices: [{ delta: { content: 'ок' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }
          })()
        }),
      },
    }
    constructor(_opts: unknown) { void _opts }
  },
}))

const { createOpenAiCompatProvider } = await import('../../electron/ai/openai-compat')

const IMG = { name: 'shot.png', mimeType: 'image/png', data: 'AAAA', size: 3 }

async function run(supportsImages: boolean | undefined): Promise<ChatEvent[]> {
  const provider = createOpenAiCompatProvider({
    id: 'zai-coding', name: 'Z.ai', models: ['glm-5.2'], defaultModel: 'glm-5.2', apiKey: 'k',
    supportsImages,
  })
  const out: ChatEvent[] = []
  for await (const ev of provider.send(
    [{ role: 'user', content: 'что здесь', attachments: [IMG] }],
    [],
  )) {
    out.push(ev)
    if (ev.type === 'done' || ev.type === 'error') break
  }
  return out
}

beforeEach(() => { lastCreateArgs = null })

describe('openai-compat — per-provider vision (дефект 3)', () => {
  it('провайдер БЕЗ vision: картинка отброшена, текст доходит строкой, info, без error', async () => {
    const events = await run(false)
    // Текст пользователя ушёл как обычная строка, а НЕ массив с image_url.
    const userMsg = lastCreateArgs?.messages?.find(m => m.role === 'user')
    expect(userMsg).toBeDefined()
    expect(typeof userMsg?.content).toBe('string')
    expect(userMsg?.content).toBe('что здесь')
    // Пользователь уведомлён об отброшенном вложении (неблокирующий info-тост).
    const infos = events.filter(e => e.type === 'info').map(e => (e as { text: string }).text)
    expect(infos.some(t => /изображени|картинк|vision|не приним/i.test(t))).toBe(true)
    // Прогон не упал.
    expect(events.some(e => e.type === 'error')).toBe(false)
  })

  it('провайдер С vision (default): картинка уходит как image_url (поведение не меняется)', async () => {
    const events = await run(true)
    const userMsg = lastCreateArgs?.messages?.find(m => m.role === 'user')
    expect(Array.isArray(userMsg?.content)).toBe(true)
    const parts = userMsg?.content as Array<{ type: string; image_url?: { url: string } }>
    expect(parts.some(p => p.type === 'image_url')).toBe(true)
    expect(events.some(e => e.type === 'error')).toBe(false)
    // Без vision-сброса info про картинку НЕ шлём.
    const infos = events.filter(e => e.type === 'info').map(e => (e as { text: string }).text)
    expect(infos.some(t => /изображени|картинк/i.test(t))).toBe(false)
  })
})
