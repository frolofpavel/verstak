// Срез 2.1.3-CD: явный выбор аккаунта (one-shot / pin) обязан останавливаться с
// понятной причиной, когда аккаунт не готов — cooling / требуется вход / удалён.
// Auto-режим поведение НЕ меняет (активный аккаунт берётся как раньше — ротацией
// в рантайме займётся существующий switch-on-limit).
//
// Резолвер — единая точка readiness (та же семантика, что Subscription Doctor):
// cooling: state='cooling' и (until null — срок неизвестен — или until > now);
// login-required: секрета нет (token) / непустого access_token нет (config-dir),
// либо access истёк и refresh отсутствует.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const { openDb } = await import('../../electron/storage/db')
const {
  createSubscriptionAccount,
  markAccountCooling,
  setActiveAccount,
} = await import('../../electron/storage/subscription-accounts')
const { createResolveSubscriptionAccount } = await import('../../electron/ai/resolve-subscription-account')

const NOW = 1_800_000_000_000

/** Безопасный фиктивный JWT: только exp-claim. */
function jwtWithExp(expMs: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString('base64url')
  return `hdr.${payload}.sig`
}

type Db = ReturnType<typeof openDb>

describe('createResolveSubscriptionAccount — readiness явного выбора (CD)', () => {
  let dir: string
  let db: Db
  let secrets: Record<string, string | null>
  let binding: { mode: 'auto' | 'pinned'; accountId: number | null } | null

  const resolve = () => createResolveSubscriptionAccount(db, {
    getSecret: (k: string) => secrets[k] ?? null,
    getSubscriptionBinding: () => binding,
    now: () => NOW,
  })

  function addTokenAccount(label: string, providerId = 'claude-cli', credRef = 'subacct:test') {
    return createSubscriptionAccount(db, { providerId, label, credRef })
  }
  function addConfigDirAccount(label: string, providerId = 'codex-cli') {
    const configDir = join(dir, `cfg-${label}`)
    mkdirSync(configDir, { recursive: true })
    return createSubscriptionAccount(db, { providerId, label, credRef: '', configDir })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-resolve-acct-'))
    db = openDb(join(dir, 'test.db'))
    secrets = {}
    binding = null
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  it('auto: активный аккаунт → success с label, pinned=false (поведение прежнее)', () => {
    const a = addTokenAccount('Рабочий')
    secrets['subacct:test'] = 'sk-live'
    const r = resolve()('claude-cli', 42)
    expect(r).toMatchObject({ accountId: a.id, secret: 'sk-live', pinned: false, label: 'Рабочий' })
  })

  it('explicit: готовый аккаунт → success, pinned=true, label безопасный', () => {
    const a = addTokenAccount('Личный Max')
    secrets['subacct:test'] = 'sk-live'
    const r = resolve()('claude-cli', 42, { accountId: a.id })
    expect(r).toMatchObject({ accountId: a.id, secret: 'sk-live', pinned: true, label: 'Личный Max' })
  })

  it('explicit: аккаунт удалён (id не существует) → unavailable', () => {
    expect(resolve()('claude-cli', 42, { accountId: 999 })).toEqual({ unavailable: true })
  })

  it('explicit: аккаунт ДРУГОГО провайдера → unavailable (не подменяем молча)', () => {
    const other = addTokenAccount('Чужой', 'grok-cli', 'subacct:grok')
    expect(resolve()('claude-cli', 42, { accountId: other.id })).toEqual({ unavailable: true })
  })

  it('explicit: openai-codex-oauth принимает аккаунт реестра codex-cli (общая auth)', () => {
    const a = addConfigDirAccount('Codex A')
    writeFileSync(join(a.configDir!, 'auth.json'), JSON.stringify({ tokens: { access_token: jwtWithExp(NOW + 60_000) } }))
    const r = resolve()('openai-codex-oauth', 42, { accountId: a.id })
    expect(r).toMatchObject({ accountId: a.id, pinned: true })
  })

  it('explicit: cooling с известным сроком → blocked cooling + resetAt', () => {
    const a = addTokenAccount('Остывший')
    secrets['subacct:test'] = 'sk-live'
    markAccountCooling(db, a.id, NOW + 3_600_000, { scope: 'account', reason: 'quota' })
    const r = resolve()('claude-cli', 42, { accountId: a.id })
    expect(r).toEqual({ blocked: true, reason: 'cooling', resetAt: NOW + 3_600_000, label: 'Остывший' })
  })

  it('explicit: cooling без срока (until=null) → blocked cooling + resetAt null (не выдумываем)', () => {
    const a = addTokenAccount('Остывший')
    secrets['subacct:test'] = 'sk-live'
    markAccountCooling(db, a.id, null)
    const r = resolve()('claude-cli', 42, { accountId: a.id })
    expect(r).toEqual({ blocked: true, reason: 'cooling', resetAt: null, label: 'Остывший' })
  })

  it('explicit: остывание истекло (until < now) → аккаунт снова годится', () => {
    const a = addTokenAccount('Отдохнувший')
    secrets['subacct:test'] = 'sk-live'
    markAccountCooling(db, a.id, NOW - 1000)
    const r = resolve()('claude-cli', 42, { accountId: a.id })
    expect(r).toMatchObject({ accountId: a.id, pinned: true })
  })

  it('explicit: token-аккаунт без секрета → blocked login-required', () => {
    const a = addTokenAccount('Пустой')
    secrets['subacct:test'] = null
    expect(resolve()('claude-cli', 42, { accountId: a.id }))
      .toEqual({ blocked: true, reason: 'login-required', resetAt: null, label: 'Пустой' })
  })

  it('explicit: config-dir без auth.json → blocked login-required', () => {
    const a = addConfigDirAccount('Codex Без Входа')
    expect(resolve()('codex-cli', 42, { accountId: a.id }))
      .toEqual({ blocked: true, reason: 'login-required', resetAt: null, label: 'Codex Без Входа' })
  })

  it('explicit: config-dir, access жив → success', () => {
    const a = addConfigDirAccount('Codex Живой')
    writeFileSync(join(a.configDir!, 'auth.json'), JSON.stringify({ tokens: { access_token: jwtWithExp(NOW + 60_000) } }))
    const r = resolve()('codex-cli', 42, { accountId: a.id })
    expect(r).toMatchObject({ accountId: a.id, pinned: true, label: 'Codex Живой' })
  })

  it('explicit: config-dir, access истёк и refresh нет → blocked login-required', () => {
    const a = addConfigDirAccount('Codex Просроченный')
    writeFileSync(join(a.configDir!, 'auth.json'), JSON.stringify({ tokens: { access_token: jwtWithExp(NOW - 60_000) } }))
    expect(resolve()('codex-cli', 42, { accountId: a.id }))
      .toEqual({ blocked: true, reason: 'login-required', resetAt: null, label: 'Codex Просроченный' })
  })

  it('explicit: access истёк, но refresh есть → success (обновится при запросе)', () => {
    const a = addConfigDirAccount('Codex Обновимый')
    writeFileSync(join(a.configDir!, 'auth.json'), JSON.stringify({
      tokens: { access_token: jwtWithExp(NOW - 60_000), refresh_token: 'refresh-stub' },
    }))
    const r = resolve()('codex-cli', 42, { accountId: a.id })
    expect(r).toMatchObject({ accountId: a.id, pinned: true })
  })

  it('pinned (binding): закреплённый cooling → blocked, НЕ success (ранний стоп вместо гарантированного фейла)', () => {
    const a = addTokenAccount('Pinned Остывший')
    secrets['subacct:test'] = 'sk-live'
    binding = { mode: 'pinned', accountId: a.id }
    markAccountCooling(db, a.id, NOW + 60_000, { scope: 'account', reason: 'rate-limit' })
    const r = resolve()('claude-cli', 42)
    expect(r).toEqual({ blocked: true, reason: 'cooling', resetAt: NOW + 60_000, label: 'Pinned Остывший' })
  })

  it('auto: активный cooling → success (поведение не изменено: ротация в рантайме)', () => {
    const a = addTokenAccount('Активный Остывший')
    secrets['subacct:test'] = 'sk-live'
    markAccountCooling(db, a.id, NOW + 60_000)
    const r = resolve()('claude-cli', 42)
    expect(r).toMatchObject({ accountId: a.id, pinned: false })
  })

  it('SECURITY SHAPE: blocked не несёт ни secret, ни configDir, ни baseUrl', () => {
    const a = addTokenAccount('Остывший')
    markAccountCooling(db, a.id, NOW + 60_000)
    const r = resolve()('claude-cli', 42, { accountId: a.id })
    expect(r && 'blocked' in r).toBe(true)
    const json = JSON.stringify(r)
    expect(json).not.toContain('secret')
    expect(json).not.toContain('configDir')
    expect(json).not.toContain('subacct:test')
  })

  it('pin на удалённый аккаунт → unavailable (поведение D2 сохранено)', () => {
    binding = { mode: 'pinned', accountId: 555 }
    expect(resolve()('claude-cli', 42)).toEqual({ unavailable: true })
  })

  it('auto: аккаунтов провайдера нет → null (legacy-секрет путь)', () => {
    addTokenAccount('Чужой', 'grok-cli', 'subacct:grok')
    expect(resolve()('claude-cli', 42)).toBeNull()
  })

  it('auto: берётся ГЛОБАЛЬНО активный аккаунт, а не первый попавшийся', () => {
    const a = addTokenAccount('Первый')
    const b = addTokenAccount('Второй', 'claude-cli', 'subacct:b')
    secrets['subacct:test'] = 'sk-a'
    secrets['subacct:b'] = 'sk-b'
    setActiveAccount(db, 'claude-cli', b.id)
    const r = resolve()('claude-cli', 42)
    expect(r).toMatchObject({ accountId: b.id, secret: 'sk-b' })
    expect(a.id).not.toBe(b.id)
  })
})
