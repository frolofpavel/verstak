import { describe, expect, it, vi } from 'vitest'
import { countOutgoingTokens, registerAiCountTokensIpc } from '../../electron/ipc/ai-count-tokens'

function deps(providerId: 'gemini-api' | 'claude-cli' = 'gemini-api') {
  return {
    getProviderId: () => providerId,
    getProviderModel: () => 'gemini-3-flash',
    getSecret: () => (providerId === 'gemini-api' ? 'configured' : null),
    recentWrites: vi.fn(() => []),
    searchMemories: vi.fn(() => []),
  }
}

describe('countOutgoingTokens', () => {
  it('регистрирует прежний публичный IPC-канал', () => {
    const ipc = { handle: vi.fn() }

    registerAiCountTokensIpc(ipc, deps())

    expect(ipc.handle).toHaveBeenCalledOnce()
    expect(ipc.handle.mock.calls[0][0]).toBe('ai:count-tokens')
  })

  it('для CLI возвращает локальную оценку без внешнего counter', async () => {
    const counter = vi.fn()

    const result = await countOutgoingTokens(deps('claude-cli'), '12345678', null, [], counter)

    expect(result).toEqual({ tokens: 2, exact: false, providerId: 'claude-cli' })
    expect(counter).not.toHaveBeenCalled()
  })

  it('для Gemini считает полный system + history + draft', async () => {
    const counter = vi.fn(async ({ contents }) => {
      const serialized = JSON.stringify(contents)
      expect(serialized).toContain('старый вопрос')
      expect(serialized).toContain('старый ответ')
      expect(serialized).toContain('новый вопрос')
      return 321
    })

    const result = await countOutgoingTokens(
      deps(),
      'новый вопрос',
      null,
      [
        { role: 'user', content: 'старый вопрос' },
        { role: 'assistant', content: 'старый ответ' },
      ],
      counter,
    )

    expect(result).toEqual({ tokens: 321, exact: true, providerId: 'gemini-api' })
  })

  it('при сбое внешнего countTokens деградирует в rough estimate', async () => {
    const result = await countOutgoingTokens(deps(), '12345678', null, [], async () => {
      throw new Error('offline')
    })

    expect(result).toEqual({ tokens: 2, exact: false, providerId: 'gemini-api' })
  })
})
