import { describe, it, expect } from 'vitest'
import { retriableErrorEvent } from '../../electron/ai/runner-util'

// selectAllowedToolDefs покрыт tests/ai/tools-allow.test.ts.
describe('retriableErrorEvent — извлечено из ai.ts при распиле (1.9.8 #1, срез 3)', () => {
  it('error-событие → Error с message', () => {
    const e = retriableErrorEvent({ type: 'error', message: 'boom' })
    expect(e).toBeInstanceOf(Error)
    expect(e!.message).toBe('boom')
  })
  it('не-error / без message → null / пустой message', () => {
    expect(retriableErrorEvent({ type: 'text' })).toBeNull()
    expect(retriableErrorEvent({ type: 'done' })).toBeNull()
    expect(retriableErrorEvent({ type: 'error' })!.message).toBe('')
  })
})
