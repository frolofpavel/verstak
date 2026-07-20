// Срез 2.0.8-B: безопасный DTO подписочного аккаунта. Acceptance карточки: сериализованный
// ответ subscription-accounts:list НЕ содержит ни токена, ни credRef, ни OAuth-path, ни
// configDir, ни baseUrl — ДАЖЕ при заполненной main-модели. Прежний toDto делал
// `{ credRef, ...rest }` → configDir/baseUrl молча утекали в renderer. Здесь — whitelist.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  toSubscriptionAccountDTO,
  isChatSubscriptionBinding,
  type SubscriptionAccountSource,
} from '../../shared/contracts/subscription'

// Мок electron.ipcMain для регистрации IPC-хендлеров (идиома tests/ipc/proof.test.ts).
const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) } }
}))

const { openDb } = await import('../../electron/storage/db')
const { registerSubscriptionAccountsIpc } = await import('../../electron/ipc/subscription-accounts')

function invoke<T>(channel: string, ...args: unknown[]): T {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return fn({} as unknown, ...args) as T
}

const T0 = 1_000_000_000_000

// Main-модель с ЗАПОЛНЕННЫМИ секретными полями — сериализатор обязан их отбросить.
const FILLED: SubscriptionAccountSource = {
  id: 7,
  providerId: 'claude-cli',
  label: 'Max аккаунт',
  credRef: 'subacct:secret-uuid-1234',
  configDir: 'C:/Users/Pavel/.codex/acct-a',
  baseUrl: 'https://internal.example/api',
  active: true,
  state: 'ready',
  coolingUntil: null,
  cooldownScope: null,
  cooldownReason: null,
  cooldownModel: null,
  lastUsedAt: T0,
}

const FORBIDDEN = ['credRef', 'configDir', 'baseUrl', 'token', 'cred_ref', 'config_dir', 'base_url', 'oauthPath']

describe('toSubscriptionAccountDTO — acceptance: ноль запрещённых полей', () => {
  it('при заполненной main-модели DTO НЕ содержит секретных полей', () => {
    const dto = toSubscriptionAccountDTO(FILLED, { hasCredential: true, now: T0 })
    for (const f of FORBIDDEN) {
      expect(Object.prototype.hasOwnProperty.call(dto, f), `DTO утёк поле ${f}`).toBe(false)
    }
    // Глубокая проверка: сериализованный JSON не содержит ни значения секрета.
    const json = JSON.stringify(dto)
    expect(json).not.toContain('secret-uuid-1234')
    expect(json).not.toContain('.codex/acct-a')
    expect(json).not.toContain('internal.example')
  })

  it('DTO содержит РОВНО безопасный whitelist полей', () => {
    const dto = toSubscriptionAccountDTO(FILLED, { hasCredential: true, now: T0 })
    expect(Object.keys(dto).sort()).toEqual(
      ['active', 'authMode', 'hasCredential', 'id', 'label', 'lastUsedAt', 'providerId', 'state'].sort()
    )
  })

  it('authMode выводится из формы аккаунта, не из сырых полей', () => {
    expect(toSubscriptionAccountDTO({ ...FILLED, configDir: 'x', baseUrl: null }, { hasCredential: true, now: T0 }).authMode).toBe('config-dir')
    expect(toSubscriptionAccountDTO({ ...FILLED, providerId: 'openai-codex-oauth', configDir: null }, { hasCredential: true, now: T0 }).authMode).toBe('oauth-file')
    expect(toSubscriptionAccountDTO({ ...FILLED, providerId: 'claude-cli', configDir: null }, { hasCredential: true, now: T0 }).authMode).toBe('token')
  })

  it('hasCredential=false + непустой credRef → state login-required (без деталей секрета)', () => {
    const dto = toSubscriptionAccountDTO(FILLED, { hasCredential: false, now: T0 })
    expect(dto.state).toBe('login-required')
    expect(dto.hasCredential).toBe(false)
    expect(JSON.stringify(dto)).not.toContain('subacct')
  })

  it('cooling_until в будущем → state cooling + cooldown scope/reason/until', () => {
    const src: SubscriptionAccountSource = {
      ...FILLED, coolingUntil: T0 + 60_000, cooldownScope: 'model', cooldownReason: 'quota', cooldownModel: 'claude-sonnet-4-6',
    }
    const dto = toSubscriptionAccountDTO(src, { hasCredential: true, now: T0 })
    expect(dto.state).toBe('cooling')
    expect(dto.cooldown).toEqual({ scope: 'model', model: 'claude-sonnet-4-6', reason: 'quota', until: T0 + 60_000 })
  })

  it('истёкший cooling_until → НЕ cooling (ready), cooldown отсутствует', () => {
    const dto = toSubscriptionAccountDTO({ ...FILLED, coolingUntil: T0 - 1 }, { hasCredential: true, now: T0 })
    expect(dto.state).toBe('ready')
    expect(dto.cooldown).toBeUndefined()
  })

  it('невалидные cooldown scope/reason → безопасные дефолты (account/unknown), не краш', () => {
    const dto = toSubscriptionAccountDTO({ ...FILLED, coolingUntil: T0 + 1, cooldownScope: 'МУСОР', cooldownReason: 'xxx' }, { hasCredential: true, now: T0 })
    expect(dto.cooldown?.scope).toBe('account')
    expect(dto.cooldown?.reason).toBe('unknown')
  })

  // INFO-3 (ревью 2.0.8-B): invalid/login-required перебивают cooling по приоритету state.
  // Инвариант: cooldown присутствует в DTO ⟺ state==='cooling'. Раньше cooldown прикреплялся
  // по одному лишь cooling_until>now — рассинхрон со state.
  it('invalid + cooling_until>now → state invalid, cooldown НЕ прикреплён (инвариант)', () => {
    const dto = toSubscriptionAccountDTO({ ...FILLED, state: 'invalid', coolingUntil: T0 + 60_000, cooldownScope: 'account', cooldownReason: 'auth' }, { hasCredential: true, now: T0 })
    expect(dto.state).toBe('invalid')
    expect(dto.cooldown).toBeUndefined()
  })

  it('login-required (нет ключа) + cooling_until>now → state login-required, cooldown НЕ прикреплён', () => {
    const dto = toSubscriptionAccountDTO({ ...FILLED, coolingUntil: T0 + 60_000, cooldownScope: 'account', cooldownReason: 'quota' }, { hasCredential: false, now: T0 })
    expect(dto.state).toBe('login-required')
    expect(dto.cooldown).toBeUndefined()
  })
})

describe('isChatSubscriptionBinding — runtime validator IPC-входа', () => {
  it('валидный binding проходит', () => {
    expect(isChatSubscriptionBinding({ chatId: 1, providerId: 'claude-cli', mode: 'pinned', accountId: 7 })).toBe(true)
    expect(isChatSubscriptionBinding({ chatId: 1, providerId: 'claude-cli', mode: 'auto', accountId: null })).toBe(true)
  })

  it('мусор/неизвестный provider/битый mode → false (не доверяем renderer-входу)', () => {
    expect(isChatSubscriptionBinding(null)).toBe(false)
    expect(isChatSubscriptionBinding({ chatId: 1, providerId: 'НЕТ', mode: 'pinned', accountId: 1 })).toBe(false)
    expect(isChatSubscriptionBinding({ chatId: 1, providerId: 'claude-cli', mode: 'wrong', accountId: 1 })).toBe(false)
    expect(isChatSubscriptionBinding({ chatId: 'x', providerId: 'claude-cli', mode: 'auto', accountId: null })).toBe(false)
  })
})

// ─── Срез 2.1.3-B: doctor IPC + честный hasCredential для config-dir аккаунтов ───
// Реальная in-memory БД + мок electron.ipcMain (идиома proof.test.ts). auth.json —
// только в temp-директориях; реальный ~/.codex тесты не читают никогда.
describe('subscription-accounts IPC (2.1.3-B: doctor + честное состояние)', () => {
  let dir: string
  let db: ReturnType<typeof openDb>

  beforeEach(() => {
    handlers.clear()
    dir = mkdtempSync(join(tmpdir(), 'gg-subacct-ipc-'))
    db = openDb(join(dir, 'test.db'))
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  const secrets = new Map<string, string>()
  const settingsMock = {
    getSecret: (k: string) => secrets.get(k) ?? null,
    setSecret: (k: string, v: string) => { secrets.set(k, v) },
  }
  const register = () => registerSubscriptionAccountsIpc(db, settingsMock as never, join(dir, 'cli-accounts'))

  it('doctor: аккаунта нет → ok:false, не падение', async () => {
    register()
    const res = await invoke<Promise<{ ok: boolean; error?: string }>>('subscription-accounts:doctor', 4242)
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it('doctor: token-аккаунт с секретом → ok-отчёт без секрета в JSON', async () => {
    register()
    secrets.set('subacct:test-1', 'LIVE_TOKEN_SECRET_777')
    db.prepare(
      "INSERT INTO subscription_accounts (provider_id, label, cred_ref, active, state, created_at) VALUES ('claude-cli', 'Max', 'subacct:test-1', 1, 'ready', 1)"
    ).run()
    const id = (db.prepare('SELECT id FROM subscription_accounts').get() as { id: number }).id
    const res = await invoke<Promise<{ ok: boolean; report?: { accountId: number; overall: string } }>>('subscription-accounts:doctor', id)
    expect(res.ok).toBe(true)
    expect(res.report!.accountId).toBe(id)
    expect(res.report!.overall).toBe('ok')
    expect(JSON.stringify(res.report)).not.toContain('LIVE_TOKEN_SECRET_777')
  })

  it('doctor: config-dir аккаунт с валидным JWT auth.json → ready; без auth.json → нужен вход', async () => {
    register()
    const cfgDir = join(dir, 'cli-accounts', 'codex-x')
    mkdirSync(cfgDir, { recursive: true })
    db.prepare(
      "INSERT INTO subscription_accounts (provider_id, label, cred_ref, config_dir, active, state, created_at) VALUES ('codex-cli', 'Work', '', ?, 1, 'ready', 1)"
    ).run(cfgDir)
    const id = (db.prepare('SELECT id FROM subscription_accounts').get() as { id: number }).id

    const noAuth = await invoke<Promise<{ ok: boolean; report?: { overall: string; state: string } }>>('subscription-accounts:doctor', id)
    expect(noAuth.report!.state).toBe('login-required')

    // R1: expiry из JWT exp (как рантайм), а не из выдуманных полей.
    const jwt = `hdr.${Buffer.from(JSON.stringify({ exp: Math.floor((Date.now() + 3_600_000) / 1000) })).toString('base64url')}.sig`
    writeFileSync(join(cfgDir, 'auth.json'), JSON.stringify({ tokens: { access_token: jwt, refresh_token: 'R' } }))
    const withAuth = await invoke<Promise<{ ok: boolean; report?: { overall: string; state: string } }>>('subscription-accounts:doctor', id)
    expect(withAuth.report!.state).toBe('ready')
    expect(withAuth.report!.overall).toBe('ok')
  })

  // R1 БЛОКЕР 1: list использует тот же probe, что Doctor — пустой/битый auth.json ≠ вход.
  it('list DTO: `{}` и битый auth.json → hasCredential=false (login-required); валидный JWT → ready', async () => {
    register()
    const cfgDir = join(dir, 'cli-accounts', 'codex-y')
    mkdirSync(cfgDir, { recursive: true })
    db.prepare(
      "INSERT INTO subscription_accounts (provider_id, label, cred_ref, config_dir, active, state, created_at) VALUES ('codex-cli', 'Work', '', ?, 1, 'ready', 1)"
    ).run(cfgDir)

    const noFile = await invoke<Promise<Array<{ state: string; hasCredential: boolean }>>>('subscription-accounts:list')
    expect(noFile[0].hasCredential).toBe(false)
    expect(noFile[0].state).toBe('login-required')

    // Пустой объект — НЕ авторизация (раньше показывал «готов»).
    writeFileSync(join(cfgDir, 'auth.json'), '{}')
    const emptyObj = await invoke<Promise<Array<{ state: string; hasCredential: boolean }>>>('subscription-accounts:list')
    expect(emptyObj[0].hasCredential).toBe(false)
    expect(emptyObj[0].state).toBe('login-required')

    // Битый JSON — тоже «нужен вход».
    writeFileSync(join(cfgDir, 'auth.json'), '{это не json')
    const broken = await invoke<Promise<Array<{ state: string; hasCredential: boolean }>>>('subscription-accounts:list')
    expect(broken[0].hasCredential).toBe(false)
    expect(broken[0].state).toBe('login-required')

    // Непустой tokens.access_token — вход есть (значение токена из main не выходит).
    const jwt = `hdr.${Buffer.from(JSON.stringify({ exp: Math.floor((Date.now() + 3_600_000) / 1000) })).toString('base64url')}.sig`
    writeFileSync(join(cfgDir, 'auth.json'), JSON.stringify({ tokens: { access_token: jwt, refresh_token: 'R' } }))
    const valid = await invoke<Promise<Array<{ state: string; hasCredential: boolean }>>>('subscription-accounts:list')
    expect(valid[0].hasCredential).toBe(true)
    expect(valid[0].state).toBe('ready')
  })
})
