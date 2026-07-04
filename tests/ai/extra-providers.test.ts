import { describe, it, expect } from 'vitest'
import { EXTRA_PROVIDERS, GATEWAY_PRESET_LABELS } from '../../electron/ai/extra-providers'

// Воронка Verstak↔Gateway: пресеты, которые видит юзер, должны быть в синке с
// тем, что отдаёт шлюз, и каждый — с человеко-читаемым русским label.
describe('Verstak Gateway пресеты', () => {
  const gw = EXTRA_PROVIDERS.find(p => p.id === 'verstak-gateway')!

  it('провайдер verstak-gateway существует', () => {
    expect(gw).toBeDefined()
  })

  it('включает verstak/free как trial-пресет (рычаг воронки: проба за 0₽ → пополнение)', () => {
    expect(gw.models).toContain('verstak/free')
  })

  it('каждый пресет gateway имеет русский label — иначе в UI показывается сырой id', () => {
    for (const m of gw.models) {
      expect(GATEWAY_PRESET_LABELS[m], `нет label для пресета ${m}`).toBeTruthy()
    }
  })

  it('uses the Stage 12 recommended coding model as the Gateway default', () => {
    expect(gw.defaultModel).toBe('kimi-k2.7-code')
    expect(gw.models[0]).toBe('kimi-k2.7-code')
    expect(gw.models).toContain('deepseek-chat')
  })
})
