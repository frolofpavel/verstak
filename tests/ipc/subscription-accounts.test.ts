// Срез 2.0.8-B: безопасный DTO подписочного аккаунта. Acceptance карточки: сериализованный
// ответ subscription-accounts:list НЕ содержит ни токена, ни credRef, ни OAuth-path, ни
// configDir, ни baseUrl — ДАЖЕ при заполненной main-модели. Прежний toDto делал
// `{ credRef, ...rest }` → configDir/baseUrl молча утекали в renderer. Здесь — whitelist.
import { describe, it, expect } from 'vitest'
import {
  toSubscriptionAccountDTO,
  isChatSubscriptionBinding,
  type SubscriptionAccountSource,
} from '../../shared/contracts/subscription'

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
