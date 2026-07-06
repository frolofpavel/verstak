import { describe, expect, it } from 'vitest'
import { parseAllowedWriteRoots } from '../../electron/ai/allowed-write-roots'

describe('allowed write roots settings', () => {
  it('parses newline-separated roots', () => {
    expect(parseAllowedWriteRoots('C:\\Temp\\a\n\n# note\nC:\\Temp\\b')).toEqual([
      'C:\\Temp\\a',
      'C:\\Temp\\b'
    ])
  })

  it('parses legacy json arrays', () => {
    expect(parseAllowedWriteRoots('["/tmp/a","/tmp/a","/tmp/b"]')).toEqual(['/tmp/a', '/tmp/b'])
  })

  it('falls back to lines when json is malformed', () => {
    expect(parseAllowedWriteRoots('[not-json]\n/tmp/ok')).toEqual(['[not-json]', '/tmp/ok'])
  })
})
