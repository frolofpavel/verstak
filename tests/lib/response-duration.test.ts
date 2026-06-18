import { describe, it, expect, vi, afterEach } from 'vitest'
import { stampDurationOnStreamEnd } from '../../src/lib/response-duration'

describe('stampDurationOnStreamEnd', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('ставит responseDurationMs и сбрасывает стрим', () => {
    vi.spyOn(Date, 'now').mockReturnValue(15_000)
    const result = stampDurationOnStreamEnd({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'answer' },
      ],
      isStreaming: true,
      streamStartedAt: 10_000,
    })
    expect(result.isStreaming).toBe(false)
    expect(result.streamStartedAt).toBeNull()
    expect(result.messages[1].responseDurationMs).toBe(5000)
  })

  it('без streamStartedAt только сбрасывает флаг', () => {
    const result = stampDurationOnStreamEnd({
      messages: [{ role: 'assistant', content: '' }],
      isStreaming: true,
      streamStartedAt: null,
    })
    expect(result.isStreaming).toBe(false)
    expect(result.messages[0].responseDurationMs).toBeUndefined()
  })
})