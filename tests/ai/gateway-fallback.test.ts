import { describe, it, expect, beforeEach, vi } from 'vitest'

// Мокаем OpenAI SDK: фиксируем baseURL каждого построенного клиента и
// подменяем chat.completions.create, чтобы проверить авто-фолбэк релея.
const { constructed, getCreateImpl, setCreateImpl } = vi.hoisted(() => {
  const constructed: (string | undefined)[] = []
  let impl: (baseURL: string | undefined, params: unknown, opts: unknown) => unknown =
    () => { throw new Error('createImpl не задан') }
  return {
    constructed,
    getCreateImpl: () => impl,
    setCreateImpl: (f: typeof impl) => { impl = f },
  }
})

vi.mock('openai', () => {
  class MockOpenAI {
    baseURL?: string
    chat: { completions: { create: (params: unknown, opts: unknown) => unknown } }
    constructor(o: { apiKey: string; baseURL?: string }) {
      this.baseURL = o.baseURL
      constructed.push(o.baseURL)
      this.chat = { completions: { create: (params: unknown, opts: unknown) => getCreateImpl()(this.baseURL, params, opts) } }
    }
  }
  return { default: MockOpenAI }
})

// Импорт ПОСЛЕ vi.mock (hoisted) — провайдер подхватит мок.
import { createExtraProvider } from '../../electron/ai/extra-providers'

async function* okStream(text: string) {
  yield { choices: [{ delta: { content: text } }] }
}

const RELAY = 'https://api-ru.agi-iri.ru/v1'
const DIRECT = 'https://api.agi-iri.ru/v1'

describe('Verstak Gateway: авто-фолбэк релея + override baseUrl', () => {
  beforeEach(() => { constructed.length = 0 })

  it('строит ДВА клиента: основной (релей) + запасной (прямой Амстердам)', () => {
    setCreateImpl(() => okStream('x'))
    createExtraProvider('verstak-gateway', { apiKey: 'vsk_live_x' })
    expect(constructed).toEqual([RELAY, DIRECT])
  })

  it('сетевой сбой релея (нет HTTP-статуса) → фолбэк на прямой + info-плашка + ответ доходит', async () => {
    setCreateImpl((baseURL) => {
      if (baseURL?.includes('api-ru')) throw {} // нет .status = сбой соединения
      return okStream('привет')
    })
    const provider = createExtraProvider('verstak-gateway', { apiKey: 'vsk_live_x' })
    const events: { type: string; text?: string }[] = []
    for await (const e of provider.send([{ role: 'user', content: 'hi' }] as never, [])) events.push(e as never)
    expect(events.some(e => e.type === 'info' && /Релей/.test(e.text ?? ''))).toBe(true)
    expect(events.some(e => e.type === 'text' && e.text === 'привет')).toBe(true)
  })

  it('HTTP-ошибка апстрима (429) → НЕ фолбэк, человеко-читаемая ошибка', async () => {
    let relayCalls = 0
    setCreateImpl((baseURL) => {
      if (baseURL?.includes('api-ru')) { relayCalls++; throw { status: 429 } }
      throw new Error('фолбэк не должен вызываться при HTTP-ошибке')
    })
    const provider = createExtraProvider('verstak-gateway', { apiKey: 'vsk_live_x' })
    const events: { type: string; message?: string }[] = []
    for await (const e of provider.send([{ role: 'user', content: 'hi' }] as never, [])) events.push(e as never)
    expect(relayCalls).toBe(1)
    expect(events.some(e => e.type === 'error')).toBe(true)
  })

  it('отмена юзером (signal aborted) при сбое → НЕ фолбэк', async () => {
    setCreateImpl((baseURL) => {
      if (baseURL?.includes('api-ru')) throw {}
      throw new Error('фолбэк не должен вызываться при отмене')
    })
    const provider = createExtraProvider('verstak-gateway', { apiKey: 'vsk_live_x' })
    const ctrl = new AbortController()
    ctrl.abort()
    const events: { type: string }[] = []
    for await (const e of provider.send([{ role: 'user', content: 'hi' }] as never, [], undefined, ctrl.signal)) events.push(e as never)
    expect(events.some(e => e.type === 'error')).toBe(true)
  })

  it('override через customBaseUrl → основной = заданный, фолбэк остаётся прямой', () => {
    setCreateImpl(() => okStream('ok'))
    createExtraProvider('verstak-gateway', { apiKey: 'vsk_live_x', customBaseUrl: 'https://my-relay.example/v1' })
    expect(constructed).toEqual(['https://my-relay.example/v1', DIRECT])
  })
})
