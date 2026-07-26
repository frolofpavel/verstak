import { describe, expect, it } from 'vitest'
import { DEFAULT_GROK_CLI_MODEL, GROK_CLI_MODELS } from '../../electron/ai/grok-cli'

describe('model registry', () => {

  it('uses live Grok Build CLI model ids, not the legacy grok-build alias', () => {
    expect(DEFAULT_GROK_CLI_MODEL).toBe('grok-4.5')
    expect(GROK_CLI_MODELS).toEqual(['grok-4.5'])
    expect(GROK_CLI_MODELS).not.toContain('grok-build')
  })

})
