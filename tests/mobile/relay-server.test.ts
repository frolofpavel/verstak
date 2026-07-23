import { afterEach, describe, expect, it } from 'vitest'
import { createRelayServer } from '../../mobile/relay/server'

describe('mobile relay server', () => {
  const running: Array<ReturnType<typeof createRelayServer>> = []
  afterEach(async () => { await Promise.all(running.splice(0).map(server => server.close())) })

  it('flushes SSE headers before the first event', async () => {
    const relay = createRelayServer({ token: 'test', port: 0 })
    running.push(relay)
    await relay.listen()
    const address = relay.server.address()
    if (!address || typeof address === 'string') throw new Error('missing relay address')
    const response = await fetch(`http://127.0.0.1:${address.port}/events?accountId=a&deviceId=d&role=mobile`, {
      headers: { Authorization: 'Bearer test' },
      signal: AbortSignal.timeout(1_000),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    await response.body?.cancel()
  })
})
