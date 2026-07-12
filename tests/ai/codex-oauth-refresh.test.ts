import { describe, it, expect } from 'vitest'
import { buildRefreshRequest, applyRefreshResponse, accountIdFromToken } from '../../electron/ai/codex-oauth/refresh'
import { type CodexAuthFile } from '../../electron/ai/codex-oauth/auth'

// Собрать валидный JWT с нужным payload (подпись не проверяется — берём 'sig').
function jwt(payload: Record<string, unknown>): string {
  const b64url = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`
}

describe('buildRefreshRequest', () => {
  it('целится в auth.openai.com/oauth/token с правильным client_id и grant_type', () => {
    const req = buildRefreshRequest('rt_123')
    expect(req.url).toBe('https://auth.openai.com/oauth/token')
    expect(req.body.client_id).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
    expect(req.body.grant_type).toBe('refresh_token')
    expect(req.body.refresh_token).toBe('rt_123')
  })

  it('scope ОТСУТСТВУЕТ (JSON-путь Codex 0.144.1)', () => {
    const req = buildRefreshRequest('rt_123')
    expect('scope' in req.body).toBe(false)
    expect(Object.keys(req.body).sort()).toEqual(['client_id', 'grant_type', 'refresh_token'])
  })
})

describe('applyRefreshResponse', () => {
  const base: CodexAuthFile = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: 'old_id',
      access_token: 'old_access',
      refresh_token: 'old_refresh',
      account_id: 'acc_old'
    },
    last_refresh: '2026-01-01T00:00:00Z'
  }

  it('меняет только реально пришедшие token-поля', () => {
    const out = applyRefreshResponse(base, { access_token: 'new_access' }, '2026-07-12T10:00:00Z')
    expect(out.tokens.access_token).toBe('new_access')
    // не пришли — сохранены старыми
    expect(out.tokens.id_token).toBe('old_id')
    expect(out.tokens.refresh_token).toBe('old_refresh')
  })

  it('отсутствующий refresh_token → старый сохранён; новый → заменяется', () => {
    const kept = applyRefreshResponse(base, { access_token: 'a' }, 'now')
    expect(kept.tokens.refresh_token).toBe('old_refresh')

    const rotated = applyRefreshResponse(base, { refresh_token: 'new_refresh' }, 'now')
    expect(rotated.tokens.refresh_token).toBe('new_refresh')
  })

  it('last_refresh обновлён переданным nowIso', () => {
    const out = applyRefreshResponse(base, { id_token: 'x' }, '2026-07-12T10:00:00Z')
    expect(out.last_refresh).toBe('2026-07-12T10:00:00Z')
  })

  it('незнакомые верхнеуровневые ключи (agent_identity и др.) сохранены', () => {
    const rich: CodexAuthFile = {
      ...base,
      agent_identity: { name: 'codex' },
      personal_access_token: 'pat_1',
      bedrock_api_key: 'bk_1',
      OPENAI_API_KEY: 'sk-keepme'
    }
    const out = applyRefreshResponse(rich, { access_token: 'a2' }, 'now')
    expect(out.agent_identity).toEqual({ name: 'codex' })
    expect(out.personal_access_token).toBe('pat_1')
    expect(out.bedrock_api_key).toBe('bk_1')
    expect(out.OPENAI_API_KEY).toBe('sk-keepme')
    expect(out.auth_mode).toBe('chatgpt')
  })

  it('account_id: сохраняется старый, если новые токены его не несут', () => {
    const out = applyRefreshResponse(base, { access_token: 'plain_no_jwt' }, 'now')
    expect(out.tokens.account_id).toBe('acc_old')
  })

  it('account_id: берётся из нового токена, если он его содержит', () => {
    const token = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_new' } })
    const out = applyRefreshResponse(base, { access_token: token }, 'now')
    expect(out.tokens.account_id).toBe('acc_new')
  })

  it('не мутирует исходный oldAuth', () => {
    const snapshot = JSON.parse(JSON.stringify(base))
    applyRefreshResponse(base, { access_token: 'z', refresh_token: 'z2' }, 'now')
    expect(base).toEqual(snapshot)
  })
})

describe('accountIdFromToken', () => {
  it('достаёт chatgpt_account_id из claim https://api.openai.com/auth', () => {
    const token = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_1' } })
    expect(accountIdFromToken(token)).toBe('acc_1')
  })

  it('undefined на не-JWT/пустом входе', () => {
    expect(accountIdFromToken(undefined)).toBeUndefined()
    expect(accountIdFromToken('not-a-jwt')).toBeUndefined()
  })
})
