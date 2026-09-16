import { describe, it, expect, vi } from 'vitest'
import { createGeminiProvider } from '../../electron/ai/gemini'

describe('GeminiProvider', () => {
  it('exposes id and models', () => {
    const provider = createGeminiProvider({ apiKey: 'test', model: 'gemini-2.5-pro' })
    expect(provider.id).toBe('gemini')
    expect(provider.models).toContain('gemini-2.5-pro')
  })

  it('streams text from mocked SDK', async () => {
    const fakeStream = (async function*() {
      yield { text: 'Hello ' }
      yield { text: 'world' }
    })()
    const sdk = {
      models: {
        generateContentStream: vi.fn().mockResolvedValue(fakeStream)
      }
    }
    const provider = createGeminiProvider({ apiKey: 'k', model: 'gemini-2.5-pro', sdk: sdk as never })
    const events: string[] = []
    for await (const ev of provider.send([{ role: 'user', content: 'hi' }], [])) {
      if (ev.type === 'text') events.push(ev.text)
      if (ev.type === 'done') break
    }
    expect(events.join('')).toBe('Hello world')
  })

  it('does not log raw retry errors that may echo a private Computer Use envelope', async () => {
    const privateMarker = 'PRIVATE_COMPUTER_COMMAND_ECHO'
    const malformed = (async function*() {
      yield { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] }
    })()
    const sdk = {
      models: {
        generateContentStream: vi.fn()
          .mockResolvedValueOnce(malformed)
          .mockRejectedValueOnce(new Error(`upstream echoed ${privateMarker}`)),
      },
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const provider = createGeminiProvider({ apiKey: 'k', sdk: sdk as never })
      const tools = [{ name: 'computer_wait_for', description: 'wait', parameters: { type: 'object' } }]
      for await (const _event of provider.send([{ role: 'user', content: privateMarker }], tools)) {
        // Drain the provider through its malformed-function retry branch.
      }
      const logged = JSON.stringify(errorSpy.mock.calls)
      expect(logged).toContain('retry failed')
      expect(logged).not.toContain(privateMarker)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
