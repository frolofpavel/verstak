import { describe, it, expect } from 'vitest'
import { cliSecurityCapability, secretProtectionLevel } from '../../electron/ai/cli-security-capabilities'
import { SECRET_PROTECTION_UI, secretProtectionLevel as rendererLevel } from '../../src/lib/runtime-capability'

describe('cli-security-capabilities — честная матрица защиты секретов', () => {
  it('claude-cli = partial: путь-чтение закрыто, но Bash-обход открыт и не подтверждён живьём', () => {
    const c = cliSecurityCapability('claude-cli')!
    expect(c.pathDenyRead).toBe(true)
    expect(c.bashSecretReadDeny).toBe(false)   // cat .env обходит
    expect(c.confirmedByLiveSmoke).toBe(false) // до задачи #6
    expect(secretProtectionLevel('claude-cli')).toBe('partial')
  })

  it('codex-cli = none для секретов: sandbox управляет только записью, чтение .env разрешено', () => {
    const c = cliSecurityCapability('codex-cli')!
    expect(c.pathDenyRead).toBe(false)
    expect(c.pathDenyWrite).toBe(true) // write-sandbox есть, но это НЕ защита чтения секрета
    expect(secretProtectionLevel('codex-cli')).toBe('none')
  })

  it('grok-cli / gemini-cli = none: никаких deny-флагов', () => {
    for (const id of ['grok-cli', 'gemini-cli']) {
      expect(cliSecurityCapability(id)!.pathDenyRead, id).toBe(false)
      expect(secretProtectionLevel(id), id).toBe('none')
    }
  })

  it('неизвестный провайдер → none (безопасный дефолт)', () => {
    expect(cliSecurityCapability('foo-cli')).toBeNull()
    expect(secretProtectionLevel('foo-cli')).toBe('none')
  })

  it('ни один CLI не заявлен full, пока не закрыт Bash-обход + живой smoke', () => {
    for (const id of ['claude-cli', 'codex-cli', 'grok-cli', 'gemini-cli']) {
      expect(secretProtectionLevel(id), id).not.toBe('full')
    }
  })

  it('renderer-зеркало SECRET_PROTECTION_UI покрывает все 3 уровня одинаковыми ключами', () => {
    // Инвариант синхронности main↔renderer: уровни совпадают по именам.
    expect(Object.keys(SECRET_PROTECTION_UI).sort()).toEqual(['full', 'none', 'partial'])
  })

  it('АНТИ-ДРЕЙФ: renderer-уровень совпадает с main для каждого CLI', () => {
    for (const id of ['claude-cli', 'codex-cli', 'grok-cli', 'gemini-cli', 'foo-cli']) {
      expect(rendererLevel(id), id).toBe(secretProtectionLevel(id))
    }
  })
})
