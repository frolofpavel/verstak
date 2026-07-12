// Codex OAuth refresh — чистые функции построения запроса и слияния ответа.
// Без сети и fs: сетевой вызов и запись auth.json делает вызывающий слой.
// GROUND TRUTH: официальный Codex 0.144.1 обновляет токен POST'ом JSON на
// auth.openai.com/oauth/token с client_id/grant_type/refresh_token и БЕЗ scope.

// Единый источник типов — auth.ts (не дублируем, иначе дрейф).
import type { CodexTokens, CodexAuthFile } from './auth'

/** Эндпоинт обновления токена OpenAI (тот же, что у официального Codex CLI). */
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
/** Публичный client_id приложения Codex — не секрет, зашит в официальный CLI. */
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

export interface RefreshRequest {
  url: string
  body: {
    client_id: string
    grant_type: 'refresh_token'
    refresh_token: string
  }
}

/**
 * Собрать тело refresh-запроса. Content-Type — application/json (Codex 0.144.1
 * шлёт JSON, не form-urlencoded). Поле scope сознательно отсутствует.
 */
export function buildRefreshRequest(refreshToken: string): RefreshRequest {
  return {
    url: OAUTH_TOKEN_URL,
    body: {
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    }
  }
}

/** Декодировать payload JWT (средний сегмент) без проверки подписи. */
function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
  if (!token || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
    const json = Buffer.from(b64 + pad, 'base64').toString('utf8')
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Достать chatgpt_account_id из access/id-токена, если он там есть.
 * Codex кладёт его в claim `https://api.openai.com/auth`. Нет — вернуть undefined,
 * тогда вызывающий сохранит старый account_id.
 */
export function accountIdFromToken(token: string | undefined): string | undefined {
  const payload = decodeJwtPayload(token)
  if (!payload) return undefined
  const auth = payload['https://api.openai.com/auth']
  if (auth && typeof auth === 'object') {
    const id = (auth as Record<string, unknown>)['chatgpt_account_id']
    if (typeof id === 'string' && id) return id
  }
  // fallback: некоторые токены несут id на верхнем уровне
  const top = payload['chatgpt_account_id'] ?? payload['account_id']
  if (typeof top === 'string' && top) return top
  return undefined
}

/**
 * Слить ответ refresh'а в новый CodexAuthFile.
 *  - меняются ТОЛЬКО реально пришедшие token-поля (id/access/refresh);
 *  - refresh_token не пришёл → сохраняем старый; пришёл → берём новый;
 *  - account_id: берём из новых токенов, иначе сохраняем старый;
 *  - last_refresh = nowIso;
 *  - все незнакомые верхнеуровневые поля oldAuth (auth_mode/OPENAI_API_KEY/
 *    agent_identity/personal_access_token/bedrock_api_key/…) сохраняются.
 * Возвращает НОВЫЙ объект, oldAuth не мутируется.
 */
export function applyRefreshResponse(
  oldAuth: CodexAuthFile,
  resp: { id_token?: string; access_token?: string; refresh_token?: string },
  nowIso: string
): CodexAuthFile {
  const oldTokens: CodexTokens = oldAuth.tokens ?? { id_token: '', access_token: '', refresh_token: '' }

  const id_token = resp.id_token ?? oldTokens.id_token
  const access_token = resp.access_token ?? oldTokens.access_token
  const refresh_token = resp.refresh_token ?? oldTokens.refresh_token

  // account_id из новых токенов, иначе — старый (новый access/id мог его не нести)
  const account_id =
    accountIdFromToken(resp.access_token) ??
    accountIdFromToken(resp.id_token) ??
    oldTokens.account_id

  const tokens: CodexTokens = {
    ...oldTokens,
    id_token,
    access_token,
    refresh_token
  }
  if (account_id !== undefined) tokens.account_id = account_id

  return {
    ...oldAuth, // сохранить все незнакомые верхнеуровневые поля
    tokens,
    last_refresh: nowIso
  }
}
