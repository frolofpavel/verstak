import { describe, it, expect } from 'vitest'
import { EXTRA_PROVIDERS } from '../../electron/ai/extra-providers'
import { GATEWAY_PRESET_LABELS, shortModel } from '../../src/lib/gateway-preset-labels'

// Пропажа renderer-метки у gateway-пресета — не косметика, а поломка: пикер
// показывает сырой id (`verstak/free`) вместо человеческого текста. Пин ловит
// СЛЕДУЮЩУЮ пропажу тоже, поэтому проверяет КАЖДЫЙ пресет, а не только verstak/free.
describe('gateway-preset-labels — renderer-метка у каждого пресета', () => {
  const gw = EXTRA_PROVIDERS.find(p => p.id === 'verstak-gateway')!

  it('у КАЖДОГО gateway-пресета есть renderer-метка (иначе в пикере сырой id)', () => {
    const missing = gw.models.filter(m => !GATEWAY_PRESET_LABELS[m])
    expect(missing, `нет renderer-метки для пресетов: ${missing.join(', ')}`).toEqual([])
  })

  it('shortModel отдаёт метку, а не сырой id, для триал-пресета verstak/free', () => {
    expect(shortModel('verstak/free')).not.toBe('verstak/free')
    expect(shortModel('verstak/free')).toBe('🎁 Бесплатно — проба')
  })
})
