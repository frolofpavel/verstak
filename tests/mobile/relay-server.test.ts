import { afterEach, describe, expect, it } from 'vitest'
import { createRelayServer } from '../../mobile/relay/server'

// Флейк-лечение того же класса, что 2fe6c2c (verstak-cli) и 136eba9: у теста стоял
// бюджет 1_000 мс на локальный fetch — не утверждение о продукте, а ambient-лимит
// «на глаз». В одиночку тест укладывается в ~70 мс, но под полным параллельным
// прогоном 28.07 fetch не успел за секунду, и гейт получил TimeoutError на месте
// зелёного теста. Логика теста не тронута: проверяются те же статус и content-type,
// отсечка нужна лишь чтобы непрофлашенные заголовки не вешали прогон навсегда.
// Лимит явный и с запасом (~200× над фактическим), но заведомо меньше
// testTimeout=20_000 — регрессия «заголовки не флашатся» по-прежнему падает
// осмысленной ошибкой ЭТОГО теста, а не общим таймаутом vitest.
const SSE_HEADERS_TIMEOUT_MS = 15_000

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
      signal: AbortSignal.timeout(SSE_HEADERS_TIMEOUT_MS),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    await response.body?.cancel()
  })
})
