import { describe, it, expect, vi } from 'vitest'
import { LspClient, LspError, type LspTransport } from '../../electron/ai/lsp/client'
import { LspDecoder } from '../../electron/ai/lsp/framing'

/**
 * Generic JSON-RPC клиент LSP: корреляция запрос↔ответ по id, ошибки сервера →
 * LspError, уведомления, таймаут, dispose. Транспорт мокается — тестируем логику
 * без живого процесса языкового сервера.
 */
function harness(timeoutMs?: number) {
  let onMsg: (m: unknown) => void = () => {}
  const sent: unknown[] = []
  const dec = new LspDecoder()
  const transport: LspTransport = {
    send: (data) => { for (const m of dec.push(data)) sent.push(m) },
    onMessage: (cb) => { onMsg = cb },
    close: () => {}
  }
  const client = new LspClient(transport, timeoutMs)
  return { client, sent, feed: (m: unknown) => onMsg(m) }
}

describe('LspClient', () => {
  it('request шлёт корректный JSON-RPC 2.0 (jsonrpc/id/method/params)', () => {
    const h = harness()
    h.client.request('textDocument/definition', { uri: 'file:///a.ts' })
    expect(h.sent).toEqual([{ jsonrpc: '2.0', id: 1, method: 'textDocument/definition', params: { uri: 'file:///a.ts' } }])
  })

  it('ответ с нашим id → резолвит result', async () => {
    const h = harness()
    const p = h.client.request('m')
    h.feed({ jsonrpc: '2.0', id: 1, result: { line: 42 } })
    await expect(p).resolves.toEqual({ line: 42 })
  })

  it('ответ с error → реджектит LspError (code+message)', async () => {
    const h = harness()
    const p = h.client.request('m')
    h.feed({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } })
    await expect(p).rejects.toBeInstanceOf(LspError)
    await expect(p).rejects.toMatchObject({ code: -32601, message: 'Method not found' })
  })

  it('конкурентные запросы коррелируются по id независимо', async () => {
    const h = harness()
    const p1 = h.client.request('a')
    const p2 = h.client.request('b')
    h.feed({ id: 2, result: 'B' })          // отвечаем на второй первым
    h.feed({ id: 1, result: 'A' })
    await expect(p1).resolves.toBe('A')
    await expect(p2).resolves.toBe('B')
  })

  it('notify шлёт без id (без ответа)', () => {
    const h = harness()
    h.client.notify('textDocument/didOpen', { uri: 'file:///a.ts' })
    expect(h.sent).toEqual([{ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { uri: 'file:///a.ts' } }])
  })

  it('ответ с неизвестным id игнорируется (без падения)', () => {
    const h = harness()
    expect(() => h.feed({ id: 999, result: 'нет такого' })).not.toThrow()
  })

  it('серверное уведомление → вызывает onNotification', () => {
    const h = harness()
    const got: Array<[string, unknown]> = []
    h.client.onNotification((method, params) => got.push([method, params]))
    h.feed({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///a.ts', diagnostics: [] } })
    expect(got).toEqual([['textDocument/publishDiagnostics', { uri: 'file:///a.ts', diagnostics: [] }]])
  })

  it('dispose реджектит незавершённые запросы', async () => {
    const h = harness()
    const p = h.client.request('m')
    h.client.dispose()
    await expect(p).rejects.toThrow(/закрыт/)
  })

  it('request после dispose → сразу реджект', async () => {
    const h = harness()
    h.client.dispose()
    await expect(h.client.request('m')).rejects.toThrow(/закрыт/)
  })

  it('таймаут реджектит запрос без ответа', async () => {
    vi.useFakeTimers()
    try {
      const h = harness(1000)
      const p = h.client.request('slow')
      const assertion = expect(p).rejects.toThrow(/таймаут/)
      await vi.advanceTimersByTimeAsync(1001)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
