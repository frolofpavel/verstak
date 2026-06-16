import { describe, expect, it } from 'vitest'
import { SUPPLEMENT_TAG, formatSupplementForAgent } from '../../src/lib/composer-streaming'

describe('composer-streaming', () => {
  it('formatSupplementForAgent wraps trimmed text with tag', () => {
    expect(formatSupplementForAgent('  уточни стиль  ')).toBe(
      `${SUPPLEMENT_TAG}\nуточни стиль`
    )
  })
})