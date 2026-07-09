import { describe, it, expect } from 'vitest'
import { runtimeCapability, CLI_WITH_TIMELINE } from '../../src/lib/runtime-capability'

describe('runtimeCapability — честный уровень контроля из provider+transport', () => {
  it('API-провайдер = полный контроль по всем осям', () => {
    const cap = runtimeCapability('claude', 'API')
    expect(cap.tier).toBe('full')
    expect(cap.toolVisibility).toBe(true)
    expect(cap.toolExecution).toBe(true)
    expect(cap.verify).toBe(true)
    expect(cap.undo).toBe(true)
    expect(cap.crashResume).toBe(true)
  })

  it('claude-cli / codex-cli = наблюдаемый: таймлайн виден (проекция срезов 1-2), но управление вне Verstak', () => {
    for (const id of ['claude-cli', 'codex-cli']) {
      const cap = runtimeCapability(id, 'CLI')
      expect(cap.tier, id).toBe('observed')
      // Главное отличие от прочих CLI — таймлайн теперь виден.
      expect(cap.toolVisibility, id).toBe(true)
      // Но исполнение/проверка/откат/резюме идут ВНУТРИ бинаря — не под Verstak.
      expect(cap.toolExecution, id).toBe(false)
      expect(cap.verify, id).toBe(false)
      expect(cap.undo, id).toBe(false)
      expect(cap.crashResume, id).toBe(false)
    }
  })

  it('прочие CLI (grok-cli / gemini-cli) = урезанный: даже таймлайн не виден', () => {
    for (const id of ['grok-cli', 'gemini-cli']) {
      const cap = runtimeCapability(id, 'CLI')
      expect(cap.tier, id).toBe('limited')
      expect(cap.toolVisibility, id).toBe(false)
      expect(cap.toolExecution, id).toBe(false)
    }
  })

  it('CLI_WITH_TIMELINE = ровно те провайдеры, где проекция реально реализована и проверена', () => {
    // Инвариант честности: набор не должен молча разрастаться под непроверенные CLI.
    expect([...CLI_WITH_TIMELINE].sort()).toEqual(['claude-cli', 'codex-cli'])
  })

  it('неизвестный CLI-провайдер трактуется как урезанный (безопасный дефолт, не наблюдаемый)', () => {
    const cap = runtimeCapability('something-cli', 'CLI')
    expect(cap.tier).toBe('limited')
    expect(cap.toolVisibility).toBe(false)
  })
})
