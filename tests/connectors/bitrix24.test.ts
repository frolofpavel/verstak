import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createBitrix24Connector } from '../../electron/connectors/bitrix24'

// Эти тесты НЕ дёргают реальный Битрикс. Они проверяют:
// 1. Корректную обработку missing webhook (понятная ошибка).
// 2. Whitelist методов (denied / wrong-prefix).
// 3. period парсер.

const ctx = {
  getSecret: (k: string) => k === 'bitrix24_webhook_url' ? 'https://test.bitrix24.ru/rest/1/abc/' : null,
  signal: new AbortController().signal
}
const noCredCtx = {
  getSecret: (_: string) => null,
  signal: new AbortController().signal
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('Bitrix24 connector', () => {
  it('возвращает no-webhook если URL не настроен', async () => {
    const conn = createBitrix24Connector()
    const res = await conn.query({ op: 'list_deals' }, noCredCtx) as { error: string }
    expect(res.error).toBe('no-webhook')
  })

  it('unknown op возвращает понятную ошибку со списком доступных', async () => {
    const conn = createBitrix24Connector()
    const res = await conn.query({ op: 'list_dogs' }, ctx) as { error: string; message: string }
    // unknown-op случится только если webhook есть, поэтому используем ctx с webhook
    expect(res.error).toBe('unknown-op')
    expect(res.message).toContain('list_deals')
  })

  it('raw call блокирует методы из denylist', async () => {
    const conn = createBitrix24Connector()
    const res = await conn.query({ op: 'call', method: 'crm.deal.delete', params: { id: 1 } }, ctx) as { error: string }
    expect(res.error).toBe('blocked')
  })

  it('raw call блокирует методы не из allowed prefixes', async () => {
    const conn = createBitrix24Connector()
    const res = await conn.query({ op: 'call', method: 'sonet.something' }, ctx) as { error: string }
    expect(res.error).toBe('blocked')
  })

  it('write-операции read-only: add_deal/update_deal/add_activity заблокированы (B5)', async () => {
    const conn = createBitrix24Connector()
    for (const op of ['add_deal', 'update_deal', 'add_activity']) {
      const res = await conn.query({ op, deal_id: 1, description: 'x' }, ctx) as { error: string }
      expect(res.error).toBe('read-only')
    }
  })

  it('generic call с write-глаголом блокируется (crm.deal.add → read-only) (B5)', async () => {
    const conn = createBitrix24Connector()
    const add = await conn.query({ op: 'call', method: 'crm.deal.add', params: {} }, ctx) as { error: string }
    expect(add.error).toBe('read-only')
    const upd = await conn.query({ op: 'call', method: 'crm.lead.update', params: {} }, ctx) as { error: string }
    expect(upd.error).toBe('read-only')
  })

  it('info() возвращает корректный label', () => {
    const conn = createBitrix24Connector()
    const info = conn.info()
    expect(info.id).toBe('bitrix24')
    expect(info.label).toContain('Битрикс')
  })
})
