import { describe, it, expect } from 'vitest'
import {
  formatMessageClock,
  formatChatDateDivider,
  isSameLocalDay,
} from '../../src/lib/chat-timestamps'

describe('chat-timestamps', () => {
  it('formatMessageClock', () => {
    const ts = new Date(2026, 5, 15, 9, 5, 7).getTime()
    expect(formatMessageClock(ts)).toBe('09:05:07')
  })

  it('isSameLocalDay', () => {
    const a = new Date(2026, 5, 15, 10, 0, 0).getTime()
    const b = new Date(2026, 5, 15, 23, 0, 0).getTime()
    const c = new Date(2026, 5, 16, 1, 0, 0).getTime()
    expect(isSameLocalDay(a, b)).toBe(true)
    expect(isSameLocalDay(a, c)).toBe(false)
  })

  it('formatChatDateDivider uses month name', () => {
    const ts = new Date(2026, 2, 15, 12, 0, 0).getTime()
    expect(formatChatDateDivider(ts)).toMatch(/15/)
    expect(formatChatDateDivider(ts)).toMatch(/март/i)
  })
})