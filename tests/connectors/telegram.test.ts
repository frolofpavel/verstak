import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
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

  // C1: delete_message и react раньше НЕ проверяли whitelist — деструктивная
  // мутация (удаление/реакция) проходила в неодобрённый чат.
  it('whitelist блокирует delete_message и react (без сетевого вызова)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const conn = createTelegramConnector()
    const del = await conn.query(
      { op: 'delete_message', chat_id: '999', message_id: 5 },
      withToken('["111"]')
    ) as { error: string }
    expect(del.error).toBe('not-whitelisted')
    const react = await conn.query(
      { op: 'react', chat_id: '999', message_id: 5, emoji: '👍' },
      withToken('["111"]')
    ) as { error: string }
    expect(react.error).toBe('not-whitelisted')
    expect(fetchSpy).not.toHaveBeenCalled() // гейт сработал ДО сети
    fetchSpy.mockRestore()
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

  it('send_document can upload a local document_path as multipart form data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gg-tg-doc-'))
    const file = join(dir, 'proof.pdf')
    writeFileSync(file, Buffer.from('%PDF-test'))
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ ok: true, result: { document: true } }),
      text: async () => '{"ok":true}'
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const conn = createTelegramConnector()
      const res = await conn.query(
        { op: 'send_document', chat_id: '111', document_path: file, caption: 'Proof Pack' },
        withToken('["111"]')
      )

      expect(res).toEqual({ document: true })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(String(url)).toContain('/sendDocument')
      expect(init.body).toBeInstanceOf(FormData)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('info() с корректными полями', () => {
    const conn = createTelegramConnector()
    const info = conn.info()
    expect(info.id).toBe('telegram')
    expect(info.kind).toBe('telegram')
  })
})
