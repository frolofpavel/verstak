import { describe, it, expect } from 'vitest'
import {
  decodeJwtPayload,
  extractAccountId,
  tokenExpiresAtMs,
  shouldRefreshToken,
  type CodexTokens,
  type CodexAuthFile
} from '../../electron/ai/codex-oauth/auth'

// JWT собираем руками: base64url(JSON) для header и payload, подпись — заглушка.
const AUTH_CLAIM = 'https://api.openai.com/auth'

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')
}
function jwt(payload: unknown, header: unknown = { alg: 'RS256', typ: 'JWT' }): string {
  return `${b64url(header)}.${b64url(payload)}.sig`
}
function authFile(tokens: Partial<CodexTokens>): CodexAuthFile {
  return { tokens: { id_token: '', access_token: '', refresh_token: '', ...tokens } }
}

describe('decodeJwtPayload', () => {
  it('разбирает payload валидного JWT', () => {
    const token = jwt({ sub: 'user-1', exp: 123 })
    expect(decodeJwtPayload(token)).toEqual({ sub: 'user-1', exp: 123 })
  })
  it('кидает, если частей не 3', () => {
    expect(() => decodeJwtPayload('a.b')).toThrow()
    expect(() => decodeJwtPayload('only-one-part')).toThrow()
  })
})

describe('extractAccountId', () => {
  it('прямое поле tokens.account_id имеет приоритет над JWT', () => {
    const idTok = jwt({ [AUTH_CLAIM]: { chatgpt_account_id: 'from-id' } })
    const auth = authFile({ account_id: 'direct-acc', id_token: idTok })
    expect(extractAccountId(auth)).toBe('direct-acc')
  })
  it('только id_token: берёт claim из id_token', () => {
    const idTok = jwt({ [AUTH_CLAIM]: { chatgpt_account_id: 'id-acc' } })
    const auth = authFile({ id_token: idTok })
    expect(extractAccountId(auth)).toBe('id-acc')
  })
  it('только access_token: id_token пустой → fallback на access_token', () => {
    const accTok = jwt({ [AUTH_CLAIM]: { chatgpt_account_id: 'acc-from-access' } })
    const auth = authFile({ access_token: accTok })
    expect(extractAccountId(auth)).toBe('acc-from-access')
  })
  it('битый id_token → не роняет, fallback на access_token', () => {
    const accTok = jwt({ [AUTH_CLAIM]: { chatgpt_account_id: 'acc-fallback' } })
    const auth = authFile({ id_token: 'not-a-jwt', access_token: accTok })
    expect(extractAccountId(auth)).toBe('acc-fallback')
  })
  it('нигде нет account_id → null (оба JWT битые)', () => {
    const auth = authFile({ id_token: 'garbage', access_token: 'also-garbage' })
    expect(extractAccountId(auth)).toBeNull()
  })
  it('валидные JWT без нужного claim → null', () => {
    const auth = authFile({ id_token: jwt({ sub: 'x' }), access_token: jwt({ sub: 'y' }) })
    expect(extractAccountId(auth)).toBeNull()
  })
})

describe('tokenExpiresAtMs', () => {
  it('exp (секунды) × 1000', () => {
    expect(tokenExpiresAtMs(jwt({ exp: 1_700_000_000 }))).toBe(1_700_000_000 * 1000)
  })
  it('нет exp → null', () => {
    expect(tokenExpiresAtMs(jwt({ sub: 'no-exp' }))).toBeNull()
  })
  it('битый JWT → null', () => {
    expect(tokenExpiresAtMs('broken')).toBeNull()
  })
})

describe('shouldRefreshToken', () => {
  const now = 1_000_000
  const boundaryExpSec = (now + 5 * 60_000) / 1000 // exp ровно на границе 5 минут

  it('на границе 5 минут → true (<=)', () => {
    expect(shouldRefreshToken(jwt({ exp: boundaryExpSec }), now)).toBe(true)
  })
  it('чуть дальше границы 5 минут → false', () => {
    const laterExpSec = (now + 5 * 60_000 + 1000) / 1000
    expect(shouldRefreshToken(jwt({ exp: laterExpSec }), now)).toBe(false)
  })
  it('нечитаемый exp (битый JWT) → true (fail-safe)', () => {
    expect(shouldRefreshToken('broken', now)).toBe(true)
  })
  it('exp отсутствует → true (fail-safe)', () => {
    expect(shouldRefreshToken(jwt({ sub: 'no-exp' }), now)).toBe(true)
  })
})
