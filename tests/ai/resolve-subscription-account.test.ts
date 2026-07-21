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

  it('auto: активный cooling и других нет → allBlocked (EF: pre-flight стоп вместо лишнего сетевого фейла)', () => {
    const a = addTokenAccount('Активный Остывший')
    secrets['subacct:test'] = 'sk-live'
    markAccountCooling(db, a.id, NOW + 60_000)
    const r = resolve()('claude-cli', 42)
    expect(r).toMatchObject({ allBlocked: true, reason: 'cooling', resetAt: NOW + 60_000, count: 1 })
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

// ─────────────────────────────────────────────────────────────────────────────
// Срез 2.1.3-EF: Auto pre-flight. Активный cooling/login-required пропускается ДО
// сетевого запроса — прогон сразу идёт через следующий готовый аккаунт того же
// провайдера. Раньше активный уходил в сеть, падал на лимите и только потом
// ротировался (лишний гарантированно неудачный запрос). Все недоступны → allBlocked
// (честный стоп в ai:send), а не молчаливая попытка.
// ─────────────────────────────────────────────────────────────────────────────
describe('createResolveSubscriptionAccount — Auto pre-flight (EF)', () => {
  let dir: string
  let db: Db
  let secrets: Record<string, string | null>

  const resolve = () => createResolveSubscriptionAccount(db, {
    getSecret: (k: string) => secrets[k] ?? null,
    getSubscriptionBinding: () => null,
    now: () => NOW,
  })

  function addToken(label: string, credRef: string) {
    return createSubscriptionAccount(db, { providerId: 'claude-cli', label, credRef })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-resolve-auto-'))
    db = openDb(join(dir, 'test.db'))
    secrets = {}
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  it('активный готов → success БЕЗ skipped (прежний быстрый путь)', () => {
    const a = addToken('Готовый', 'subacct:a')
    secrets['subacct:a'] = 'sk-a'
    const r = resolve()('claude-cli', 42)
    expect(r).toMatchObject({ accountId: a.id, pinned: false })
    expect(r && 'skipped' in r ? r.skipped : undefined).toBeUndefined()
  })

  it('активный cooling (срок известен) + B готов → сразу B, skipped называет A и срок', () => {
    const a = addToken('Остывший A', 'subacct:a')
    const b = addToken('Готовый B', 'subacct:b')
    secrets['subacct:a'] = 'sk-a'
    secrets['subacct:b'] = 'sk-b'
    markAccountCooling(db, a.id, NOW + 2 * 3600_000, { scope: 'account', reason: 'quota' })
    const r = resolve()('claude-cli', 42)
    expect(r).toMatchObject({
      accountId: b.id, secret: 'sk-b',
      skipped: { fromLabel: 'Остывший A', reason: 'cooling', resetAt: NOW + 2 * 3600_000 },
    })
    // Выбор запоминается: следующие прогоны сразу стартуют на B (B стал активным).
    const r2 = resolve()('claude-cli', 42)
    expect(r2).toMatchObject({ accountId: b.id })
    expect(r2 && 'skipped' in r2 ? r2.skipped : undefined).toBeUndefined()
  })

  it('активный cooling БЕЗ срока (until=null) → тоже пропускается (не считается готовым)', () => {
    const a = addToken('Остывший без срока', 'subacct:a')
    const b = addToken('Готовый B', 'subacct:b')
    secrets['subacct:a'] = 'sk-a'
    secrets['subacct:b'] = 'sk-b'
    markAccountCooling(db, a.id, null, { scope: 'account', reason: 'quota' })
    const r = resolve()('claude-cli', 42)
    expect(r).toMatchObject({ accountId: b.id, skipped: { fromLabel: 'Остывший без срока', reason: 'cooling', resetAt: null } })
  })

  it('остывание активного ИСТЕКЛО (until <= now) → используется сам, skipped нет (auto-heal)', () => {
    const a = addToken('Отдохнувший', 'subacct:a')
    secrets['subacct:a'] = 'sk-a'
    markAccountCooling(db, a.id, NOW - 1000, { scope: 'account', reason: 'quota' })
    const r = resolve()('claude-cli', 42)
    expect(r).toMatchObject({ accountId: a.id })
    expect(r && 'skipped' in r ? r.skipped : undefined).toBeUndefined()
  })

  it('активный login-required (секрета нет) + B готов → сразу B, skipped login-required', () => {
    const a = addToken('Без входа A', 'subacct:a')
    const b = addToken('Готовый B', 'subacct:b')
    secrets['subacct:b'] = 'sk-b' // у A секрета нет
    const r = resolve()('claude-cli', 42)
    expect(r).toMatchObject({ accountId: b.id, skipped: { fromLabel: 'Без входа A', reason: 'login-required', resetAt: null } })
  })

  it('cooling-аккаунт с until=null НЕ выбирается как «готовый» кандидат', () => {
    const a = addToken('Остывший A', 'subacct:a')
    const b = addToken('Тоже остывший B', 'subacct:b')
    secrets['subacct:a'] = 'sk-a'
    secrets['subacct:b'] = 'sk-b'
    markAccountCooling(db, a.id, NOW + 60_000, { scope: 'account', reason: 'quota' })
    markAccountCooling(db, b.id, null, { scope: 'account', reason: 'quota' }) // без срока — НЕ готов
    const r = resolve()('claude-cli', 42)
    expect(r).toMatchObject({ allBlocked: true, reason: 'cooling', resetAt: NOW + 60_000 })
  })

  it('все остывают → allBlocked cooling с БЛИЖАЙШИМ известным resetAt', () => {
    const a = addToken('A', 'subacct:a')
    const b = addToken('B', 'subacct:b')
    secrets['subacct:a'] = 'sk-a'
    secrets['subacct:b'] = 'sk-b'
    markAccountCooling(db, a.id, NOW + 3 * 3600_000, { scope: 'account', reason: 'quota' })
    markAccountCooling(db, b.id, NOW + 3600_000, { scope: 'account', reason: 'rate-limit' })
    const r = resolve()('claude-cli', 42)
    expect(r).toMatchObject({ allBlocked: true, reason: 'cooling', resetAt: NOW + 3600_000, count: 2 })
  })

  it('все остывают без сроков → allBlocked, resetAt null (не выдумываем время)', () => {
    const a = addToken('A', 'subacct:a')
    secrets['subacct:a'] = 'sk-a'
    markAccountCooling(db, a.id, null, { scope: 'account', reason: 'unknown' })
    const r = resolve()('claude-cli', 42)
    expect(r).toMatchObject({ allBlocked: true, reason: 'cooling', resetAt: null })
  })

  it('все требуют входа → allBlocked login-required', () => {
    addToken('A', 'subacct:a')
    addToken('B', 'subacct:b') // секретов нет
    const r = resolve()('claude-cli', 42)
    expect(r).toMatchObject({ allBlocked: true, reason: 'login-required' })
  })

  it('смесь cooling+login-required: готовых нет → allBlocked cooling (есть надежда на сброс)', () => {
    const a = addToken('Остывший', 'subacct:a')
    addToken('Без входа', 'subacct:b')
    secrets['subacct:a'] = 'sk-a'
    markAccountCooling(db, a.id, NOW + 60_000, { scope: 'account', reason: 'quota' })
    const r = resolve()('claude-cli', 42)
    expect(r).toMatchObject({ allBlocked: true, reason: 'cooling', resetAt: NOW + 60_000 })
  })

  it('SECURITY SHAPE: skipped/allBlocked не несут ни secret, ни configDir, ни credRef', () => {
    const a = addToken('Остывший', 'subacct:a')
    addToken('Готовый B', 'subacct:b')
    secrets['subacct:a'] = 'sk-a'
    secrets['subacct:b'] = 'sk-b'
    markAccountCooling(db, a.id, NOW + 60_000, { scope: 'account', reason: 'quota' })
    const r = resolve()('claude-cli', 42)
    const skippedJson = JSON.stringify(r && 'skipped' in r ? r.skipped : null)
    expect(skippedJson).not.toContain('sk-')
    expect(skippedJson).not.toContain('subacct:')
    expect(skippedJson).not.toContain('configDir')
    expect(skippedJson).not.toContain('accountId')
  })
})


// EF-R1 Б1: canonical Codex family — openai-codex-oauth обязан видеть пул codex-cli
// во ВСЕХ ветках (auto/pin/explicit), а не только в one-shot. Раньше auto/pin шли по
// raw providerId → пул был невидим, blocked/allBlocked схлопывались в null, pin тихо
// становился auto, а запрос уходил на default ~/.codex.
describe('createResolveSubscriptionAccount — canonical Codex family (EF-R1 Б1)', () => {
  let dir: string
  let db: Db
  let secrets: Record<string, string | null>
  let binding: { mode: 'auto' | 'pinned'; accountId: number | null } | null

  const resolve = () => createResolveSubscriptionAccount(db, {
    getSecret: (k: string) => secrets[k] ?? null,
    getSubscriptionBinding: () => binding,
    now: () => NOW,
  })

  function addCodex(label: string, withValidJwt = true) {
    const configDir = join(dir, `cfg-${label}`)
    mkdirSync(configDir, { recursive: true })
    const acct = createSubscriptionAccount(db, { providerId: 'codex-cli', label, credRef: '', configDir })
    if (withValidJwt) {
      writeFileSync(join(configDir, 'auth.json'), JSON.stringify({ tokens: { access_token: jwtWithExp(NOW + 3600_000) } }))
    }
    return acct
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-resolve-codex-'))
    db = openDb(join(dir, 'test.db'))
    secrets = {}
    binding = null
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  it('auto через openai-codex-oauth: активный cooling → сразу готовый B из пула codex-cli (configDir B)', () => {
    const a = addCodex('Codex A')
    const b = addCodex('Codex B')
    markAccountCooling(db, a.id, NOW + 3600_000, { scope: 'account', reason: 'quota' })
    const r = resolve()('openai-codex-oauth', 42)
    expect(r).toMatchObject({
      accountId: b.id, configDir: b.configDir, pinned: false,
      skipped: { fromLabel: 'Codex A', reason: 'cooling', resetAt: NOW + 3600_000 },
    })
  })

  it('auto через openai-codex-oauth: все cooling → allBlocked, НЕ null (никакого default ~/.codex)', () => {
    const a = addCodex('Codex A')
    markAccountCooling(db, a.id, NOW + 3600_000, { scope: 'account', reason: 'quota' })
    const r = resolve()('openai-codex-oauth', 42)
    expect(r).toMatchObject({ allBlocked: true, reason: 'cooling', resetAt: NOW + 3600_000, count: 1 })
  })

  it('auto через openai-codex-oauth: активный без входа (битый auth) → login-required, НЕ null', () => {
    addCodex('Codex A', false) // auth.json нет → credential отсутствует
    const r = resolve()('openai-codex-oauth', 42)
    expect(r).toMatchObject({ allBlocked: true, reason: 'login-required' })
  })

  it('pinned codex-аккаунт + openai-codex-oauth → остаётся PINNED (не тихий auto)', () => {
    const a = addCodex('Codex A') // active
    const b = addCodex('Codex B')
    void a
    binding = { mode: 'pinned', accountId: b.id }
    const r = resolve()('openai-codex-oauth', 42)
    expect(r).toMatchObject({ accountId: b.id, configDir: b.configDir, pinned: true, label: 'Codex B' })
  })

  it('pinned codex-аккаунт cooling + openai-codex-oauth → blocked (не схлопнут в null/auto)', () => {
    const a = addCodex('Codex A')
    binding = { mode: 'pinned', accountId: a.id }
    markAccountCooling(db, a.id, NOW + 60_000, { scope: 'account', reason: 'quota' })
    const r = resolve()('openai-codex-oauth', 42)
    expect(r).toMatchObject({ blocked: true, reason: 'cooling', resetAt: NOW + 60_000, label: 'Codex A' })
  })

  it('one-shot codex-аккаунт + openai-codex-oauth → exact account (канон сверки)', () => {
    const a = addCodex('Codex A')
    const b = addCodex('Codex B')
    void a
    const r = resolve()('openai-codex-oauth', 42, { accountId: b.id })
    expect(r).toMatchObject({ accountId: b.id, configDir: b.configDir, pinned: true })
  })

  it('пул пуст для oauth → null (legacy default-путь допустим ТОЛЬКО без парка аккаунтов)', () => {
    expect(resolve()('openai-codex-oauth', 42)).toBeNull()
  })
})
