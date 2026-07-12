import { describe, it, expect, vi } from 'vitest'
import { createBitrix24Connector } from '../../electron/connectors/bitrix24'

const ctx = {
  getSecret: (k: string) => k === 'bitrix24_webhook_url' ? 'https://test.bitrix24.ru/rest/1/abc/' : null,
  signal: new AbortController().signal
}

describe('Bitrix24 Settings health check', () => {
  it('allows profile method used by connector test', async () => {
    const calls: string[] = []
    const originalFetch = global.fetch
    global.fetch = vi.fn(async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ result: { ID: 1 } }), { status: 200 })
    }) as typeof fetch

    try {
      const conn = createBitrix24Connector()
      const res = await conn.query({ op: 'call', method: 'profile' }, ctx) as { result?: { ID: number } }
      expect(res.result?.ID).toBe(1)
      expect(calls[0]).toBe('https://test.bitrix24.ru/rest/1/abc/profile.json')
    } finally {
      global.fetch = originalFetch
    }
  })

  it('rejects Yandex token saved into Bitrix webhook field', async () => {
    const originalFetch = global.fetch
    global.fetch = vi.fn() as typeof fetch

    try {
      const conn = createBitrix24Connector()
      const res = await conn.query(
        { op: 'call', method: 'profile' },
        {
          getSecret: (k: string) => k === 'bitrix24_webhook_url' ? 'y0__wgBEOXrt8QBGJf6RCCmqrGbGDDTtID5CBXVjdyW0OFCGs8UWpNM-mHb0QSB' : null,
          signal: new AbortController().signal
        }
      ) as { error?: string; message?: string }

      expect(res.error).toBe('invalid-webhook-url')
      expect(res.message).toContain('токен Яндекса')
      expect(global.fetch).not.toHaveBeenCalled()
    } finally {
      global.fetch = originalFetch
    }
  })
})
