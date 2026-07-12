/**
 * Разбор auth.json Codex CLI и JWT-токенов ChatGPT-логина.
 *
 * Codex CLI (OpenAI) после OAuth-логина кладёт `~/.codex/auth.json` с парой
 * id_token / access_token (JWT) + refresh_token. account_id (ChatGPT-аккаунт)
 * лежит либо прямым полем, либо внутри claim'а `https://api.openai.com/auth`
 * одного из JWT. Здесь — чистые (без сети/fs) хелперы чтения этих данных:
 * извлечение account_id, срока жизни access_token и решение «пора рефрешить».
 *
 * Никакой криптопроверки подписи — нам нужен только payload (claims),
 * подпись валидирует сервер OpenAI при использовании токена.
 */

export interface CodexTokens {
  id_token: string
  access_token: string
  refresh_token: string
  account_id?: string
}

export interface CodexAuthFile {
  auth_mode?: string
  OPENAI_API_KEY?: string | null
  tokens: CodexTokens
  last_refresh?: string
  [k: string]: unknown
}

/** Claim внутри JWT, где OpenAI кладёт данные ChatGPT-аккаунта. */
const AUTH_CLAIM = 'https://api.openai.com/auth'

/** Порог до истечения, за который начинаем рефрешить заранее — 5 минут. */
const REFRESH_SKEW_MS = 5 * 60_000

/**
 * Декодирует payload (middle-часть) JWT. Подпись НЕ проверяется.
 * Кидает, если это не 3-частный `header.payload.signature` или payload
 * не парсится как JSON.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT: expected 3 dot-separated parts')
  const json = Buffer.from(parts[1], 'base64url').toString('utf8')
  return JSON.parse(json) as Record<string, unknown>
}

/** Достаёт chatgpt_account_id из claim'а JWT. Возвращает null, если claim'а нет
 *  (но НЕ глотает ошибку декода — её ловит вызывающий, чтобы уйти в fallback). */
function accountIdFromJwtClaim(jwt: string): string | null {
  const payload = decodeJwtPayload(jwt)
  const claim = payload[AUTH_CLAIM]
  if (claim && typeof claim === 'object') {
    const id = (claim as Record<string, unknown>).chatgpt_account_id
    if (typeof id === 'string' && id) return id
  }
  return null
}

/**
 * Извлекает ChatGPT account_id из auth.json по приоритету:
 *   1) прямое поле auth.tokens.account_id;
 *   2) claim из id_token;
 *   3) claim из access_token.
 * Битый JWT в шагах 2-3 не роняет функцию — try/catch пропускает к следующему
 * источнику. Возвращает null, если account_id нигде не нашёлся.
 */
export function extractAccountId(auth: CodexAuthFile): string | null {
  const direct = auth.tokens?.account_id
  if (typeof direct === 'string' && direct) return direct

  for (const jwt of [auth.tokens?.id_token, auth.tokens?.access_token]) {
    if (!jwt) continue
    try {
      const id = accountIdFromJwtClaim(jwt)
      if (id) return id
    } catch {
      // битый JWT — пробуем следующий источник
    }
  }
  return null
}

/**
 * Момент истечения access_token в мс epoch: `exp` (в секундах) × 1000.
 * Возвращает null, если exp отсутствует, нечисловой или JWT не декодируется.
 */
export function tokenExpiresAtMs(accessToken: string): number | null {
  try {
    const exp = decodeJwtPayload(accessToken).exp
    if (exp === undefined || exp === null) return null
    const ms = Number(exp) * 1000
    return Number.isFinite(ms) ? ms : null
  } catch {
    return null
  }
}

/**
 * Нужно ли рефрешить access_token сейчас (nowMs — текущее время в мс epoch).
 * true, если до истечения осталось <= 5 минут, ИЛИ если exp нечитаем
 * (fail-safe: не смогли понять срок — лучше обновить, чем словить 401).
 */
export function shouldRefreshToken(accessToken: string, nowMs: number): boolean {
  const expiresAt = tokenExpiresAtMs(accessToken)
  if (expiresAt === null) return true
  return expiresAt <= nowMs + REFRESH_SKEW_MS
}
