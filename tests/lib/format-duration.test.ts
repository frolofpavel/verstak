import { describe, it, expect } from 'vitest'
import { formatDuration } from '../../src/lib/format-duration'

describe('formatDuration', () => {
  it('миллисекунды', () => {
    expect(formatDuration(450)).toBe('450 мс')
  })

  it('секунды', () => {
    expect(formatDuration(12_000)).toBe('12 с')
  })

  it('минуты и секунды', () => {
    expect(formatDuration(125_000)).toBe('2 м 5 с')
  })

  it('ровно минуты', () => {
    expect(formatDuration(120_000)).toBe('2 м')
  })
})