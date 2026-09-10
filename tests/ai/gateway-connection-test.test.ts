import { describe, expect, it, vi } from 'vitest'
import { testGatewayConnection } from '../../electron/ai/gateway-connection-test'

describe('проверка IRI Gateway при первом запуске', () => {
  it('пустой ключ не уходит в сеть', async () => {
    const fetchImpl = vi.fn()
    expect(await testGatewayConnection('   ', fetchImpl)).toEqual({
      ok: false,
      message: 'Вставьте API-ключ IRI Gateway.',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('живой ключ подтверждается через бесплатный usage endpoint', async () => {
    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) => ({ ok: true, status: 200 }))
    const result = await testGatewayConnection('test-key', fetchImpl)

    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api-ru.agi-iri.ru/v1/usage')
    expect(fetchImpl.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer test-key' })
  })

  it('401 объясняет, что ключ надо скопировать заново', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 }))
    const result = await testGatewayConnection('test-key', fetchImpl)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/ключ не принят/i)
  })

  it('403 ведёт к подтверждению email, а не называет ключ неверным', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 }))
    const result = await testGatewayConnection('test-key', fetchImpl)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/подтвердите email/i)
  })

  it('сетевой отказ РФ-релея проверяет прямой запасной endpoint', async () => {
    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit): Promise<{ ok: boolean; status: number }> => ({ ok: false, status: 500 }))
      .mockRejectedValueOnce(new Error('relay unavailable'))
      .mockResolvedValueOnce({ ok: true, status: 200 })

    expect((await testGatewayConnection('test-key', fetchImpl)).ok).toBe(true)
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([
      'https://api-ru.agi-iri.ru/v1/usage',
      'https://api.agi-iri.ru/v1/usage',
    ])
  })

  it('контроль: успешный ответ действительно меняет вердикт', async () => {
    const failed = await testGatewayConnection('test-key', vi.fn(async () => ({ ok: false, status: 401 })))
    const passed = await testGatewayConnection('test-key', vi.fn(async () => ({ ok: true, status: 200 })))
    expect(failed.ok).toBe(false)
    expect(passed.ok).toBe(true)
  })
})
