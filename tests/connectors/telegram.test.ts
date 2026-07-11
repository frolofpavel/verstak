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

  // 2.0.0 security (аудит M5): пустой whitelist раньше был fail-OPEN (слал в любой
  // chat_id). Теперь fail-CLOSED — блок, если только это не настроенный notify-чат.
  it('пустой whitelist + нет notify → блок (fail-closed), НЕ уходит в fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const conn = createTelegramConnector()
    const res = await conn.query(
      { op: 'send_message', chat_id: '999', text: 'hi' },
      withToken()
    ) as { error?: string }
    expect(res.error).toBe('whitelist-unset')
    expect(fetchMock).not.toHaveBeenCalled()  // заблокировано ДО сети
  })

  it('пустой whitelist, но chat_id == telegram_notify_chat_id → пропускает (свой чат)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      text: async () => '{"ok":true,"result":{}}',
      json: async () => ({ ok: true, result: {} })
    })))
    const conn = createTelegramConnector()
    const ctx = { getSecret: (k: string) => (k === 'telegram_bot_token' ? '123:abc' : k === 'telegram_notify_chat_id' ? '555' : null), signal: new AbortController().signal }
    const res = await conn.query({ op: 'send_message', chat_id: '555', text: 'hi' }, ctx) as { error?: string }
    expect(res.error).toBeFalsy()  // notify-чат разрешён без whitelist
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
