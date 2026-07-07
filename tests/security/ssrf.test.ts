import { describe, expect, it } from 'vitest'
import { assertUrlAllowed, fetchUrl } from '../../electron/ai/web-fetch'
import { redactUrlSecrets } from '../../electron/ai/secret-scanner'

const okLookup = async () => [{ address: '93.184.216.34', family: 4 }]

describe('SEC-SSRF web access regression pack', () => {
  it('SEC-SSRF-01 blocks literal private and loopback web hosts', () => {
    for (const url of [
      'http://127.0.0.1/admin',
      'http://10.0.0.5/private',
      'http://192.168.1.10/router',
      'http://[::1]/loopback',
      'http://localhost/status'
    ]) {
      expect(() => assertUrlAllowed(url)).toThrow()
    }
  })

  it('SEC-SSRF-02 blocks public-to-private redirect hops', async () => {
    let calls = 0
    const fakeFetch = async () => {
      calls += 1
      return new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/admin' }
      })
    }

    await expect(fetchUrl('https://public.example/start', {
      fetchImpl: fakeFetch as typeof fetch,
      lookupImpl: okLookup
    })).rejects.toThrow()
    expect(calls).toBe(1)
  })

  it('SEC-SSRF-03 blocks cloud metadata endpoints', () => {
    expect(() => assertUrlAllowed('http://169.254.169.254/latest/meta-data')).toThrow()
    expect(() => assertUrlAllowed('http://[::ffff:169.254.169.254]/latest/meta-data')).toThrow()
  })

  it('SEC-SSRF-04 redacts URL query and fragment secrets before log use', () => {
    const redacted = redactUrlSecrets(
      'https://example.com/callback?token=super-secret-token&api_key=abc123&q=public#access_token=frag-secret&state=ok'
    )

    expect(redacted).not.toContain('super-secret-token')
    expect(redacted).not.toContain('abc123')
    expect(redacted).not.toContain('frag-secret')
    expect(redacted).toContain('q=public')
    expect(redacted).toContain('state=ok')
  })
})
