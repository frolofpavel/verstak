import { describe, it, expect } from 'vitest'
import { secretProtectionLevel } from '../../electron/ai/cli-security-capabilities'
import { secretProtectionLevel as rendererLevel } from '../../src/lib/runtime-capability'

describe('cli-security-capabilities — честная матрица защиты секретов', () => {




  it('ни один CLI не заявлен full, пока не закрыт Bash-обход + живой smoke', () => {
    for (const id of ['claude-cli', 'codex-cli', 'grok-cli', 'gemini-cli']) {
      expect(secretProtectionLevel(id), id).not.toBe('full')
    }
  })


  it('АНТИ-ДРЕЙФ: renderer-уровень совпадает с main для каждого CLI', () => {
    for (const id of ['claude-cli', 'codex-cli', 'grok-cli', 'gemini-cli', 'foo-cli']) {
      expect(rendererLevel(id), id).toBe(secretProtectionLevel(id))
    }
  })
})
