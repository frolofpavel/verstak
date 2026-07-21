// Срез 2.1.3-B (R1): Subscription Doctor — безопасная диагностика подписочного аккаунта.
// ИНВАРИАНТЫ БЕЗОПАСНОСТИ (тестируются здесь же):
//  - тесты используют ТОЛЬКО temp-директории/fixtures — реальный ~/.codex и SafeStorage
//    не читаются никогда;
//  - в отчёт не попадают ни значения токенов, ни refresh, ни credRef, ни абсолютные пути;
//  - битый/пустой auth.json — это «нужен вход», а НЕ «готов» и НЕ падение диагностики;
//  - expiry читается из JWT exp access_token (как рантайм), а не из выдуманных полей.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runSubscriptionDoctor } from '../../electron/ai/subscription-doctor'
import type { SubscriptionAccount } from '../../electron/storage/subscription-accounts'

const NOW = 1_800_000_000_000

/** Безопасный фиктивный JWT: только exp-claim, никаких реальных токенов. */
function jwtWithExp(expMs: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString('base64url')
  return `hdr.${payload}.sig`
}
/** JWT без exp-claim (срок не читается). */
const JWT_NO_EXP = `hdr.${Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url')}.sig`

function acct(over: Partial<SubscriptionAccount> = {}): SubscriptionAccount {
  return {
    id: 7,
    providerId: 'claude-cli',
    label: 'Личный Max',
    credRef: 'subacct:secret-uuid-999',
    configDir: null,
    baseUrl: null,
    active: true,
    state: 'ready',
    coolingUntil: null,
    cooldownScope: null,
    cooldownReason: null,
    cooldownModel: null,
    createdAt: NOW - 1000,
    lastUsedAt: null,
    lastSuccessAt: null,
    ...over,
  }
}

describe('subscription-doctor — token-аккаунт (Claude)', () => {
  it('секрет на месте → overall ok, честная формулировка без live-probe', () => {
    const r = runSubscriptionDoctor(acct(), { hasCredential: () => true, now: NOW })
    expect(r.overall).toBe('ok')
    expect(r.state).toBe('ready')
    expect(r.checks.find(c => c.id === 'credential')?.status).toBe('ok')
    expect(r.nextStep).toBeNull()
    // R1: не утверждаем, что сеть/CLI/модель реально отвечают.
    expect(r.summary).toMatch(/локальная конфигурация выглядит готовой/i)
    expect(r.summary).toMatch(/реальный запрос не выполнялся/i)
    // Статические checks не маскируются под live-проверку.
    expect(r.checks.find(c => c.id === 'route')?.label).toMatch(/CLI/)
    expect(r.checks.find(c => c.id === 'route')?.label).toMatch(/не выполнялся|без запуска|конфигурация/i)
    expect(r.checks.find(c => c.id === 'models')?.label).toMatch(/справочно|без запроса/i)
  })

  it('секрета нет → overall fail + человеческий следующий шаг (не raw exception)', () => {
    const r = runSubscriptionDoctor(acct(), { hasCredential: () => false, now: NOW })
    expect(r.overall).toBe('fail')
    expect(r.state).toBe('login-required')
    expect(r.checks.find(c => c.id === 'credential')?.status).toBe('fail')
    expect(r.nextStep).toBeTruthy()
    expect(r.summary).not.toMatch(/Error|undefined|null/i)
  })

  // R1 БЛОКЕР 3: lastUsedAt — это ПОПЫТКА использования (пишется до результата), не success.
  it('last-use: null → «ещё не использовался»; задан → «попытка использования», не «успешный»', () => {
    const never = runSubscriptionDoctor(acct(), { hasCredential: () => true, now: NOW })
    expect(never.checks.map(c => c.id)).not.toContain('last-success')
    expect(never.checks.find(c => c.id === 'last-use')?.label).toMatch(/не использовался/i)
    const used = runSubscriptionDoctor(acct({ lastUsedAt: NOW - 60_000 }), { hasCredential: () => true, now: NOW })
    const label = used.checks.find(c => c.id === 'last-use')!.label
    expect(label).toMatch(/попытка/i)
    expect(label).not.toMatch(/успешн/i)
  })

  it('cooling с причиной и until → warn с человеческим текстом и временем', () => {
    const r = runSubscriptionDoctor(
      acct({ state: 'cooling', coolingUntil: NOW + 5 * 60 * 60_000, cooldownScope: 'account', cooldownReason: 'quota' }),
      { hasCredential: () => true, now: NOW },
    )
    expect(r.state).toBe('cooling')
    expect(r.overall).toBe('warn')
    const cd = r.checks.find(c => c.id === 'cooldown')!
    expect(cd.status).toBe('warn')
    expect(cd.label).toMatch(/квота/i)
    expect(r.nextStep).toMatch(/переключ|дожд/i)
  })
})

describe('subscription-doctor — config-dir аккаунт (Codex, CODEX_HOME)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-doctor-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const codexAcct = (configDir: string | null) => acct({ providerId: 'codex-cli', credRef: '', configDir })
  const authJson = (obj: unknown) => JSON.stringify(obj)

  it('папка не существует → fail config-dir + понятный следующий шаг', () => {
    const r = runSubscriptionDoctor(codexAcct(join(dir, 'net-takoy-papki')), { hasCredential: () => false, now: NOW })
    expect(r.overall).toBe('fail')
    const check = r.checks.find(c => c.id === 'config-dir')!
    expect(check.status).toBe('fail')
    expect(r.nextStep).toBeTruthy()
  })

  it('папка есть, auth.json нет → нужен вход (НЕ crash, не «готов»)', () => {
    const r = runSubscriptionDoctor(codexAcct(dir), { hasCredential: () => false, now: NOW })
    expect(r.state).toBe('login-required')
    expect(r.overall).toBe('fail')
    expect(r.checks.find(c => c.id === 'credential')?.status).toBe('fail')
    expect(r.nextStep).toMatch(/вход|вой/i)
  })

  // R1 БЛОКЕР 1: пустой auth.json НЕ рабочая авторизация (раньше считался «готов»).
  it('auth.json = {} → credential fail + login-required (пустой файл ≠ вход)', () => {
    writeFileSync(join(dir, 'auth.json'), '{}')
    const r = runSubscriptionDoctor(codexAcct(dir), { hasCredential: () => false, now: NOW })
    expect(r.checks.find(c => c.id === 'credential')?.status).toBe('fail')
    expect(r.state).toBe('login-required')
    expect(r.overall).toBe('fail')
  })

  // R1 БЛОКЕР 1: битый JSON — тоже «нужен вход», а не «кред есть».
  it('битый auth.json → credential fail + login-required (диагностика НЕ падает)', () => {
    writeFileSync(join(dir, 'auth.json'), '{это не json')
    const r = runSubscriptionDoctor(codexAcct(dir), { hasCredential: () => false, now: NOW })
    expect(r.checks.find(c => c.id === 'credential')?.status).toBe('fail')
    expect(r.state).toBe('login-required')
    expect(r.overall).toBe('fail')
    expect(r.nextStep).toMatch(/вход|вой/i)
  })

  // R1 БЛОКЕР 2: expiry из JWT exp (как рантайм tokenExpiresAtMs), не из выдуманных полей.
  it('JWT с будущим exp + refresh → ready/ok, expiry ok', () => {
    writeFileSync(join(dir, 'auth.json'), authJson({ tokens: { access_token: jwtWithExp(NOW + 3_600_000), refresh_token: 'R' } }))
    const r = runSubscriptionDoctor(codexAcct(dir), { hasCredential: () => false, now: NOW })
    expect(r.state).toBe('ready')
    expect(r.overall).toBe('ok')
    expect(r.checks.find(c => c.id === 'oauth-expiry')?.status).toBe('ok')
    expect(r.checks.find(c => c.id === 'refresh')?.status).toBe('ok')
  })

  it('истёкший JWT + refresh → state ready, expiry warn (автообновление при следующем запросе)', () => {
    writeFileSync(join(dir, 'auth.json'), authJson({ tokens: { access_token: jwtWithExp(NOW - 1000), refresh_token: 'R' } }))
    const r = runSubscriptionDoctor(codexAcct(dir), { hasCredential: () => false, now: NOW })
    expect(r.state).toBe('ready') // НЕ ложный login-required: локально возможен refresh
    expect(r.checks.find(c => c.id === 'oauth-expiry')?.status).toBe('warn')
    expect(r.checks.find(c => c.id === 'refresh')?.status).toBe('ok')
    expect(r.overall).toBe('warn')
  })

  it('истёкший JWT БЕЗ refresh → login-required/fail + следующий шаг', () => {
    writeFileSync(join(dir, 'auth.json'), authJson({ tokens: { access_token: jwtWithExp(NOW - 1000) } }))
    const r = runSubscriptionDoctor(codexAcct(dir), { hasCredential: () => false, now: NOW })
    expect(r.state).toBe('login-required')
    expect(r.checks.find(c => c.id === 'oauth-expiry')?.status).toBe('fail')
    expect(r.overall).toBe('fail')
    expect(r.nextStep).toMatch(/вход|вой/i)
  })

  it('JWT скоро истекает (<10 мин) → expiry warn, НЕ ложный fail', () => {
    writeFileSync(join(dir, 'auth.json'), authJson({ tokens: { access_token: jwtWithExp(NOW + 5 * 60_000), refresh_token: 'R' } }))
    const r = runSubscriptionDoctor(codexAcct(dir), { hasCredential: () => false, now: NOW })
    expect(r.checks.find(c => c.id === 'oauth-expiry')?.status).toBe('warn')
    expect(r.overall).toBe('warn')
  })

  it('JWT без exp + refresh → expiry честный info (без утверждения о сроке)', () => {
    writeFileSync(join(dir, 'auth.json'), authJson({ tokens: { access_token: JWT_NO_EXP, refresh_token: 'R' } }))
    const r = runSubscriptionDoctor(codexAcct(dir), { hasCredential: () => false, now: NOW })
    const ex = r.checks.find(c => c.id === 'oauth-expiry')!
    expect(ex.status).toBe('info')
    expect(ex.label).toMatch(/неизвест|не читается|нет срока/i)
    expect(r.state).toBe('ready')
  })

  it('JWT без exp и без refresh → expiry warn (срок неизвестен, обновлять нечем)', () => {
    writeFileSync(join(dir, 'auth.json'), authJson({ tokens: { access_token: JWT_NO_EXP } }))
    const r = runSubscriptionDoctor(codexAcct(dir), { hasCredential: () => false, now: NOW })
    expect(r.checks.find(c => c.id === 'oauth-expiry')?.status).toBe('warn')
  })

  it('access_token пустой строкой → credential fail (как у рантайма: нет непустого access)', () => {
    writeFileSync(join(dir, 'auth.json'), authJson({ tokens: { access_token: '', refresh_token: 'R' } }))
    const r = runSubscriptionDoctor(codexAcct(dir), { hasCredential: () => false, now: NOW })
    expect(r.checks.find(c => c.id === 'credential')?.status).toBe('fail')
    expect(r.state).toBe('login-required')
  })

  it('SECURITY: в отчёте нет ни токена, ни refresh, ни credRef, ни абсолютных путей', () => {
    const access = jwtWithExp(NOW + 3_600_000)
    writeFileSync(join(dir, 'auth.json'), authJson({ tokens: { access_token: access, refresh_token: 'REFRESH_SECRET_456' } }))
    const r = runSubscriptionDoctor(codexAcct(dir), { hasCredential: () => false, now: NOW })
    const json = JSON.stringify(r)
    expect(json).not.toContain(access)
    expect(json).not.toContain('REFRESH_SECRET_456')
    expect(json).not.toContain('secret-uuid-999')
    expect(json).not.toContain(dir)
    expect(json).not.toContain('auth.json')
  })
})

describe('subscription-doctor — форма отчёта', () => {
  it('все 8 проверок присутствуют (last-use, не last-success), checkedAt = now', () => {
    const r = runSubscriptionDoctor(acct(), { hasCredential: () => true, now: NOW })
    expect(r.checks.map(c => c.id).sort()).toEqual(
      ['config-dir', 'cooldown', 'credential', 'last-use', 'models', 'oauth-expiry', 'refresh', 'route'].sort(),
    )
    expect(r.checkedAt).toBe(NOW)
    expect(r.accountId).toBe(7)
  })
})
