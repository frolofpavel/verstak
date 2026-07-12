import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createYandexWordstatConnector,
  wordstatApiPost,
  WORDSTAT_API_HOST,
} from '../../electron/connectors/yandex-wordstat'
import https from 'node:https'
import { EventEmitter } from 'node:events'

const ctx = {
  getSecret: (k: string) => {
    if (k === 'yandex_wordstat_token') return 'tok-wordstat'
    if (k === 'yandex_wordstat_folder_id') return 'folder-1'
    if (k === 'yandex_wordstat_auth_type') return 'api-key'
    return null
  },
  signal: new AbortController().signal
}
const noCred = { getSecret: (_: string) => null, signal: new AbortController().signal }

type MockResponse = { statusCode: number; body: string }

function mockWordstatHttps(handler: (path: string, payload: string) => MockResponse) {
  vi.spyOn(https, 'request').mockImplementation((_opts, cb) => {
    const req = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>
      end: ReturnType<typeof vi.fn>
      destroy: ReturnType<typeof vi.fn>
    }
    req.write = vi.fn()
    req.end = vi.fn(() => {
      const opts = _opts as { path?: string }
      const path = String(opts.path ?? '')
      let payload = ''
      if (req.write.mock.calls.length > 0) payload = String(req.write.mock.calls[0][0] ?? '')
      const mock = handler(path, payload)
      const res = new EventEmitter() as EventEmitter & { statusCode: number }
      res.statusCode = mock.statusCode
      queueMicrotask(() => {
        ;(cb as unknown as ((res: import('node:http').IncomingMessage) => void) | undefined)?.(res as unknown as import('node:http').IncomingMessage)
        res.emit('data', Buffer.from(mock.body, 'utf8'))
        res.emit('end')
      })
    })
    req.destroy = vi.fn((err?: Error) => {
      if (err) req.emit('error', err)
    })
    return req as unknown as ReturnType<typeof https.request>
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('Yandex.Wordstat connector via Search API', () => {
  it('info() корректен', () => {
    expect(createYandexWordstatConnector().info().id).toBe('yandex_wordstat')
  })

  it('без токена - no-token', async () => {
    const r = await createYandexWordstatConnector().query({ op: 'get_top_requests', phrase: 'x' }, noCred) as { error: string }
    expect(r.error).toBe('no-token')
  })

  it('без folderId - no-folder-id', async () => {
    const r = await createYandexWordstatConnector().query(
      { op: 'get_top_requests', phrase: 'x' },
      { getSecret: (k: string) => (k === 'yandex_wordstat_token' ? 'tok' : null), signal: new AbortController().signal }
    ) as { error: string }
    expect(r.error).toBe('no-folder-id')
  })

  it('unknown op', async () => {
    const r = await createYandexWordstatConnector().query({ op: 'legacy_direct' }, ctx) as { error: string }
    expect(r.error).toBe('unknown-op')
  })

  it('get_top_requests без phrase - bad-args', async () => {
    const r = await createYandexWordstatConnector().query({ op: 'get_top_requests' }, ctx) as { error: string }
    expect(r.error).toBe('bad-args')
  })

  it('get_wordstat без phrases - bad-args', async () => {
    const r = await createYandexWordstatConnector().query({ op: 'get_wordstat' }, ctx) as { error: string }
    expect(r.error).toBe('bad-args')
  })

  it('get_top_requests парсит results и associations', async () => {
    mockWordstatHttps((path, payload) => {
      expect(path).toBe('/v2/wordstat/topRequests')
      const body = JSON.parse(payload) as { folderId: string; devices: string[]; regions: string[] }
      expect(body.folderId).toBe('folder-1')
      expect(body.devices).toEqual(['DEVICE_ALL'])
      expect(body.regions).toEqual(['213'])
      return {
        statusCode: 200,
        body: JSON.stringify({
          totalCount: '5400',
          results: [
            { phrase: 'купить диван', count: '5400' },
            { phrase: 'купить диван москва', count: '800' }
          ],
          associations: [{ phrase: 'диван недорого', count: '1200' }]
        })
      }
    })
    const r = await createYandexWordstatConnector().query({
      op: 'get_top_requests',
      phrase: 'купить диван',
      regions: [213],
      num_phrases: 100
    }, ctx) as {
      phrase: string
      total_count: number
      top_requests: Array<{ phrase: string; count: number }>
      searched_also: Array<{ phrase: string; shows: number }>
    }
    expect(r.phrase).toBe('купить диван')
    expect(r.total_count).toBe(5400)
    expect(r.top_requests[1].count).toBe(800)
    expect(r.searched_also[0].shows).toBe(1200)
  })

  it('get_wordstat батчит несколько phrases', async () => {
    const seen: string[] = []
    mockWordstatHttps((_path, payload) => {
      const body = JSON.parse(payload) as { phrase: string }
      seen.push(body.phrase)
      return {
        statusCode: 200,
        body: JSON.stringify({
          totalCount: '10',
          results: [{ phrase: body.phrase, count: '10' }],
          associations: []
        })
      }
    })
    const r = await createYandexWordstatConnector().query({
      op: 'get_wordstat',
      phrases: ['диван', 'кресло']
    }, ctx) as { count: number; results: Array<{ phrase: string }> }
    expect(r.count).toBe(2)
    expect(r.results.map(x => x.phrase)).toEqual(['диван', 'кресло'])
    expect(seen).toEqual(['диван', 'кресло'])
  })

  it('get_regions_tree больше не поддерживается Search API', async () => {
    const r = await createYandexWordstatConnector().query({ op: 'get_regions_tree' }, ctx) as { error: string }
    expect(r.error).toBe('unsupported-op')
  })

  it('HTTP 401 даёт понятную ошибку', async () => {
    mockWordstatHttps(() => ({ statusCode: 401, body: '{"message":"unauthorized"}' }))
    const r = await createYandexWordstatConnector().query({ op: 'get_top_requests', phrase: 'x' }, ctx) as { error: string; message: string }
    expect(r.error).toBe('request-failed')
    expect(r.message).toContain('401')
    expect(r.message).toContain('Yandex Search API')
  })

  it('wordstatApiPost использует Yandex Search API', async () => {
    mockWordstatHttps(() => ({ statusCode: 200, body: '{"ok":true}' }))
    await wordstatApiPost('/topRequests', { token: 'tok', authType: 'api-key', folderId: 'folder-1' }, { folderId: 'folder-1' }, ctx)
    expect(https.request).toHaveBeenCalled()
    const opts = vi.mocked(https.request).mock.calls[0][0] as { hostname?: string; path?: string; headers?: Record<string, string> }
    expect(opts.hostname).toBe(WORDSTAT_API_HOST)
    expect(opts.path).toBe('/v2/wordstat/topRequests')
    expect(opts.headers?.Authorization).toBe('Api-key tok')
  })
})
