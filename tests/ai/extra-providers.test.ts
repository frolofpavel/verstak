import { describe, it, expect } from 'vitest'
import { EXTRA_PROVIDERS } from '../../electron/ai/extra-providers'

// Воронка Verstak↔Gateway: пресеты, которые видит юзер, должны быть в синке с
// тем, что отдаёт шлюз. Проверка «у каждого пресета есть человекочитаемая метка»
// живёт там же, где сама метка — tests/lib/gateway-preset-labels.test.ts
// (main-копия таблицы удалена 15.08, §1.2 ревизии: её читали одни тесты).
describe('Verstak Gateway пресеты', () => {
  const gw = EXTRA_PROVIDERS.find(p => p.id === 'verstak-gateway')!

  it('провайдер verstak-gateway существует', () => {
    expect(gw).toBeDefined()
  })

  it('включает verstak/free как trial-пресет (рычаг воронки: проба за 0₽ → пополнение)', () => {
    expect(gw.models).toContain('verstak/free')
  })

  it('uses the Stage 12 recommended coding model as the Gateway default', () => {
    expect(gw.defaultModel).toBe('kimi-k2.7-code')
    expect(gw.models[0]).toBe('kimi-k2.7-code')
    expect(gw.models).toContain('deepseek-chat')
  })
})
