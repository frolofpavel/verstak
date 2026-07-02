import { describe, it, expect, afterEach, vi } from 'vitest'
import { createHttpConnector } from '../../electron/connectors/http'

function ctx(secrets: Record<string, string>) {
  return {
    getSecret: (k: string) => secrets[k] ?? null,
    signal: new AbortController().signal
  }
}

describe('HTTP connector', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('needs-config when no endpoints are set', async () => {
    const c = createHttpConnector()
    const r = await c.query({ endpoint: 'x' }, ctx({})) as { error?: string }
    expect(r.error).toBe('needs-config')
  })

  it('rejects unknown endpoint', async () => {
    const c = createHttpConnector()
    const r = await c.query({ endpoint: 'nope' }, ctx({
      http_endpoint_1_name: 'github',
      http_endpoint_1_base: 'https://api.github.com'
    })) as { error?: string }
    expect(r.error).toBe('unknown-endpoint')
  })

  it('blocks methods outside the allow-list', async () => {
    const c = createHttpConnector()
    const r = await c.query({ endpoint: 'gh', method: 'TRACE', path: '/' }, ctx({
      http_endpoint_1_name: 'gh',
      http_endpoint_1_base: 'https://api.github.com'
    })) as { error?: string }
    expect(r.error).toBe('bad-args')
  })

  it('blocks paths outside the allow-list', async () => {
    const c = createHttpConnector()
    const r = await c.query({ endpoint: 'gh', path: '/admin' }, ctx({
      http_endpoint_1_name: 'gh',
      http_endpoint_1_base: 'https://api.github.com',
      http_endpoint_1_paths: '/repos,/user'
    })) as { error?: string }
    expect(r.error).toBe('path-blocked')
  })

  it('blocks `..` traversal that escapes the allow-list after URL normalization', async () => {
    // Сырой путь startsWith '/v1/public/', но new URL схлопывает .. → /admin/keys.
    const c = createHttpConnector()
    const r = await c.query({ endpoint: 'api', path: '/v1/public/../../admin/keys' }, ctx({
      http_endpoint_1_name: 'api',
      http_endpoint_1_base: 'https://api.example.com',
      http_endpoint_1_paths: '/v1/public'
    })) as { error?: string }
    expect(r.error).toBe('path-blocked')
  })

  // Ре-ревью HIGH: cross-origin редирект НЕ должен уносить Authorization на чужой хост.
  // IP-литералы в base/redirect минуют DNS-резолв (assertHostAllowed) — тест без сети.
  it('срезает Authorization при редиректе на другой origin', async () => {
    const calls: Array<{ url: string; auth: unknown }> = []
    const mock = vi.fn(async (url: string | URL, opts: { headers?: Record<string, string> }) => {
      const h = opts.headers ?? {}
      calls.push({ url: String(url), auth: h['Authorization'] })
      if (String(url).includes('93.184.216.34')) {
        return new Response(null, { status: 302, headers: { location: 'https://8.8.8.8/collect' } })
      }
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', mock)
    const c = createHttpConnector()
    await c.query({ endpoint: 'api', path: '/data' }, ctx({
      http_endpoint_1_name: 'api',
      http_endpoint_1_base: 'https://93.184.216.34',
      http_endpoint_1_auth: 'Bearer SUPER_SECRET_TOKEN'
    }))
    expect(calls.length).toBe(2)
    expect(calls[0].auth).toBe('Bearer SUPER_SECRET_TOKEN') // исходный хост — токен есть
    expect(calls[1].auth).toBeUndefined()                   // чужой origin — токен срезан
  })

  it('reports bad-args when endpoint is missing', async () => {
    const c = createHttpConnector()
    const r = await c.query({}, ctx({
      http_endpoint_1_name: 'gh',
      http_endpoint_1_base: 'https://api.github.com'
    })) as { error?: string; configured?: string[] }
    expect(r.error).toBe('bad-args')
    expect(r.configured).toContain('gh')
  })
})
