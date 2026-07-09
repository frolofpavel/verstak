import { describe, it, expect } from 'vitest'
import { claudePermissionMode, claudeSecretDenySpecifiers, claudeGuardArgs } from '../../electron/ai/claude-cli'

describe('claudePermissionMode — режим Verstak → claude --permission-mode', () => {
  it('маппит все 5 режимов на документированные значения', () => {
    expect(claudePermissionMode('ask')).toBe('default')
    expect(claudePermissionMode('accept-edits')).toBe('acceptEdits')
    expect(claudePermissionMode('auto')).toBe('acceptEdits')
    expect(claudePermissionMode('plan')).toBe('plan')
    expect(claudePermissionMode('bypass')).toBe('bypassPermissions')
  })

  it('undefined → default (безопасный дефолт, без авто-правок)', () => {
    expect(claudePermissionMode(undefined)).toBe('default')
  })
})

describe('claudeSecretDenySpecifiers — guard секретов зеркалит isForbiddenPath', () => {
  const specs = claudeSecretDenySpecifiers()

  it('блокирует .env для Read/Edit/Write (эксфильтрация И запись)', () => {
    expect(specs).toContain('Read(**/.env)')
    expect(specs).toContain('Edit(**/.env)')
    expect(specs).toContain('Write(**/.env)')
    expect(specs).toContain('Read(**/.env.*)')
  })

  it('блокирует .ssh, ключи/сертификаты и creds*.json', () => {
    expect(specs).toContain('Read(.ssh/**)')
    expect(specs).toContain('Read(**/*.key)')
    expect(specs).toContain('Read(**/*.pem)')
    expect(specs).toContain('Read(**/creds*.json)')
    expect(specs).toContain('Read(**/credentials*.json)')
  })

  it('каждый секрет-глоб покрыт всеми тремя file-инструментами', () => {
    // Инвариант: для любого специфаера есть Read/Edit/Write вариант того же глоба.
    const globs = new Set(specs.map(s => s.replace(/^(Read|Edit|Write)\(/, '').replace(/\)$/, '')))
    for (const g of globs) {
      expect(specs, g).toContain(`Read(${g})`)
      expect(specs, g).toContain(`Edit(${g})`)
      expect(specs, g).toContain(`Write(${g})`)
    }
  })
})

describe('claudeGuardArgs — итоговые доп-флаги claude', () => {
  it('содержит --permission-mode <mode> и --disallowedTools с deny секретов', () => {
    const args = claudeGuardArgs('accept-edits')
    const pmIdx = args.indexOf('--permission-mode')
    expect(pmIdx).toBeGreaterThanOrEqual(0)
    expect(args[pmIdx + 1]).toBe('acceptEdits')
    const dtIdx = args.indexOf('--disallowedTools')
    expect(dtIdx).toBeGreaterThanOrEqual(0)
    // Security: даже в acceptEdits (агент может писать) .env под запретом.
    expect(args).toContain('Read(**/.env)')
    expect(args).toContain('Edit(**/.env)')
  })

  it('SECURITY: guard присутствует даже в bypass-режиме (best-effort defense-in-depth)', () => {
    const args = claudeGuardArgs('bypass')
    expect(args).toContain('--permission-mode')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
    // deny-специфаеры всё равно передаём (даже если bypass может их переопределить —
    // это осознанный выбor пользователя «без ограничений», но мы не убираем сеть).
    expect(args).toContain('Read(**/.env)')
  })

  it('--disallowedTools идёт последним блоком (промпт claude читает из stdin, не argv)', () => {
    const args = claudeGuardArgs('ask')
    const dtIdx = args.indexOf('--disallowedTools')
    // после --disallowedTools — только специфаеры, никаких других флагов.
    const tail = args.slice(dtIdx + 1)
    expect(tail.every(a => /^(Read|Edit|Write)\(.+\)$/.test(a))).toBe(true)
  })
})
