import { describe, it, expect, vi } from 'vitest'
import {
  registerConversationSupplements, unregisterConversationSupplements,
  pushConversationSupplement, formatConversationSupplement,
} from '../../electron/ai/runner-supplements'

describe('runner-supplements — извлечено из ai.ts при распиле (1.9.8 #1, срез 2)', () => {
  it('push доставляется зарегистрированному слушателю', () => {
    const push = vi.fn()
    registerConversationSupplements(101, push)
    expect(pushConversationSupplement(101, 'добавка')).toBe('deferred')
    expect(push).toHaveBeenCalledWith('добавка')
    unregisterConversationSupplements(101)
  })
  it('нет слушателя (или снят) → false', () => {
    expect(pushConversationSupplement(999, 'x')).toBe(false)
    registerConversationSupplements(102, vi.fn())
    unregisterConversationSupplements(102)
    expect(pushConversationSupplement(102, 'x')).toBe(false)
  })
  it('formatConversationSupplement помечает как дополнение, а не новую задачу', () => {
    const out = formatConversationSupplement('  сделай ещё X  ')
    expect(out).toContain('[Дополнение к текущей задаче]')
    expect(out).toContain('не новая задача')
    expect(out).toContain('сделай ещё X')
  })
})
