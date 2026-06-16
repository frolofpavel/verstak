import { describe, it, expect, vi } from 'vitest'
import { createTelegramConnector } from '../../electron/connectors/telegram'

const noToken = {
  getSecret: (_: string) => null,
  signal: new AbortController().signal
}

const withToken = (whitelist?: string) => ({
  getSecret: (k: string) => {
    if (k === 'telegram_bot_token') return '123:abc'
    if (k === 'telegram_chat_whitelist' && whitelist) return whitelist
    return null
  },
  signal: new AbortController().signal
})

describe('Telegram connector', () => {
  it('возвращает no-token если bot_token не настроен', async () => {
    const conn = createTelegramConnector()
    const res = await conn.query({ op: 'send_message', chat_id: '123', text: 'hi' }, noToken) as { error: string }
    expect(res.error).toBe('no-token')
  })

  it('send_message без chat_id/text — bad-args', async () => {
    const conn = createTelegramConnector()
    const res = await conn.query({ op: 'send_message' }, withToken()) as { error: string }
    expect(res.error).toBe('bad-args')
  })

  it('whitelist блокирует отправку в незнакомый чат', async () => {
    const conn = createTelegramConnector()
    const res = await conn.query(
      { op: 'send_message', chat_id: '999', text: 'hi' },
      withToken('["111", "222"]')
    ) as { error: string }
    expect(res.error).toBe('not-whitelisted')
  })

  it('пустой whitelist (null) — пропускает (dev mode)', async () => {
    // С пустым whitelist - НЕ должно вернуть not-whitelisted (попытается
    // отправить и упадёт уже на fetch). Здесь мы тестируем именно whitelist
    // логику, а не успешность отправки. fetch замокан, чтобы тест был
    // детерминированным и быстрым (без реального сетевого вызова к Telegram —
    // он давал flaky timeout 5s). Глобальный afterEach (tests/setup.ts) снимет стаб.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 401,
      text: async () => '{"ok":false,"error_code":401}',
      json: async () => ({ ok: false, error_code: 401 })
    })))
    const conn = createTelegramConnector()
    const res = await conn.query(
      { op: 'send_message', chat_id: '999', text: 'hi' },
      withToken()
    ) as { error?: string }
    // Должна быть какая-то ошибка, но НЕ not-whitelisted (потому что списка нет)
    expect(res.error).not.toBe('not-whitelisted')
  })

  it('info() с корректными полями', () => {
    const conn = createTelegramConnector()
    const info = conn.info()
    expect(info.id).toBe('telegram')
    expect(info.kind).toBe('telegram')
  })
})
