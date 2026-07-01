import { describe, it, expect } from 'vitest'
import { composeSystemPrompt, CACHE_BREAKPOINT, stripCacheBreakpoint, systemForProvider } from '../../electron/ai/compose-prompt'

const PACK = '<context_pack generated="auto">git status: clean · recent: a.ts</context_pack>'
const SKILL = 'Ты — ревьюер UI.'

describe('prompt-caching — разделение stable/volatile', () => {
  it('стабильное (system+user+skill) ИДЁТ ДО маркера, изменчивый pack — ПОСЛЕ', () => {
    const { system } = composeSystemPrompt({ path: 'CLAUDE.md', content: 'правило' }, PACK, SKILL)
    const bp = system.indexOf(CACHE_BREAKPOINT)
    expect(bp).toBeGreaterThan(0)
    const stable = system.slice(0, bp)
    const volatile = system.slice(bp + CACHE_BREAKPOINT.length)
    // стабильная часть: протокол + user + skill (не меняются между ходами)
    expect(stable).toContain('verstak_system_layer')
    expect(stable).toContain('правило')
    expect(stable).toContain(SKILL)
    // проверяем по УНИКАЛЬНОМУ контенту pack'а (слово 'context_pack' встречается в
    // тексте immutable system-layer, который его документирует — по нему нельзя)
    expect(stable).not.toContain('git status: clean')
    // изменчивая часть: только context-pack
    expect(volatile).toContain('git status: clean')
    expect(volatile).not.toContain(SKILL)
  })

  it('без context-pack → нет маркера (весь system стабилен, кэшируется целиком)', () => {
    const { system } = composeSystemPrompt({ path: null, content: '' }, '', SKILL)
    expect(system).not.toContain(CACHE_BREAKPOINT)
    expect(system).toContain(SKILL)
  })

  it('stripCacheBreakpoint убирает маркер', () => {
    const { system } = composeSystemPrompt({ path: 'CLAUDE.md', content: 'x' }, PACK, SKILL)
    const stripped = stripCacheBreakpoint(system)
    expect(stripped).not.toContain(CACHE_BREAKPOINT)
    // порядок сохранён: стабильное всё ещё до реального pack-тега
    expect(stripped.indexOf('<skill_layer>')).toBeLessThan(stripped.indexOf('<context_pack generated='))
  })

  it('systemForProvider: claude сохраняет маркер, прочие снимают', () => {
    const { system } = composeSystemPrompt({ path: 'CLAUDE.md', content: 'x' }, PACK, SKILL)
    expect(systemForProvider(system, 'claude')).toContain(CACHE_BREAKPOINT)
    expect(systemForProvider(system, 'openai')).not.toContain(CACHE_BREAKPOINT)
    expect(systemForProvider(system, 'deepseek')).not.toContain(CACHE_BREAKPOINT)
    expect(systemForProvider(system, 'gemini-api')).not.toContain(CACHE_BREAKPOINT)
  })

  it('содержимое эквивалентно старому (без потери секций) — только реордер + маркер', () => {
    const { system } = composeSystemPrompt({ path: 'CLAUDE.md', content: 'правило' }, PACK, SKILL)
    const flat = stripCacheBreakpoint(system)
    // все слои на месте
    expect(flat).toContain('verstak_system_layer')
    expect(flat).toContain('правило')
    expect(flat).toContain(SKILL)
    expect(flat).toContain('context_pack')
    expect(flat).toContain('preflight_hint')
  })
})
