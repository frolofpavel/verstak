import { describe, it, expect } from 'vitest'
import { secretProtectionLevel } from '../../electron/ai/cli-security-capabilities'
import { secretProtectionLevel as rendererLevel } from '../../src/lib/runtime-capability'

describe('cli-security-capabilities — честная матрица защиты секретов', () => {

  it('ни один CLI не заявлен full, пока не закрыт Bash-обход + живой smoke', () => {
    for (const id of ['claude-cli', 'codex-cli', 'grok-cli', 'gemini-cli']) {
      expect(secretProtectionLevel(id), id).not.toBe('full')
    }
  })

  // Уровень по каждому CLI — прямой пин на единый источник. Прежний анти-дрейф-тест
  // (renderer-копия == main-копия) снят: копий больше нет, обе стороны импортируют
  // secretProtectionLevel из shared/contracts/cli-capability.ts — расходиться нечему.
  it('уровень защиты секретов по каждому CLI', () => {
    expect(secretProtectionLevel('claude-cli')).toBe('partial') // путь-чтение закрыто, Bash-обход открыт
    expect(secretProtectionLevel('codex-cli')).toBe('none')     // sandbox только записи, чтение .env разрешено
    expect(secretProtectionLevel('grok-cli')).toBe('none')
    expect(secretProtectionLevel('gemini-cli')).toBe('none')
    expect(secretProtectionLevel('foo-cli')).toBe('none')       // неизвестный CLI — безопасный дефолт
  })

  // Обе стороны теперь тянут ОДНУ функцию — фиксируем это тождество (референсная
  // идентичность), чтобы будущий откат к отдельным копиям упал здесь.
  it('renderer и main экспортируют один и тот же secretProtectionLevel', () => {
    expect(rendererLevel).toBe(secretProtectionLevel)
  })
})
