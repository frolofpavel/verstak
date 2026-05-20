import { describe, it, expect } from 'vitest'
import { createHttpConnector } from '../../electron/connectors/http'

function ctx(secrets: Record<string, string>) {
  return {
    getSecret: (k: string) => secrets[k] ?? null,
    signal: new AbortController().signal
  }
}

describe('HTTP connector', () => {
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
