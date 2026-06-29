import { describe, it, expect } from 'vitest'
import { buildOracleDelegateArgs } from '../../electron/ipc/tool-handlers/delegation'

// oracle (ось 3, кластер B) — reasoning-советник: обёртка над delegate_task role=critic.
describe('buildOracleDelegateArgs', () => {
  it('нет question → null (хендлер вернёт ошибку, не делегирует)', () => {
    expect(buildOracleDelegateArgs({})).toBeNull()
    expect(buildOracleDelegateArgs({ question: '   ' })).toBeNull()
  })

  it('question → role=critic (read-only) + advisory-фрейминг + question в промпте', () => {
    const d = buildOracleDelegateArgs({ question: 'оцени план рефакторинга стора' })!
    expect(d.role).toBe('critic') // critic → read-only набор по role-tools
    expect(d.group).toBe('oracle')
    expect(String(d.prompt)).toContain('оцени план рефакторинга стора')
    expect(String(d.prompt)).toMatch(/советник|критич/i)
    expect(String(d.prompt)).toMatch(/не правь|только анализ/i) // read-only установка
  })

  it('context + files вплетаются в промпт; provider/model пробрасываются для эскалации', () => {
    const d = buildOracleDelegateArgs({
      question: 'разбери ошибку', context: 'падает на старте', files: ['a.ts', 'b.ts'],
      provider_id: 'claude', model: 'claude-opus-4-8',
    })!
    expect(String(d.prompt)).toContain('падает на старте')
    expect(String(d.prompt)).toContain('a.ts, b.ts')
    expect(d.provider_id).toBe('claude')
    expect(d.model).toBe('claude-opus-4-8')
  })
})
