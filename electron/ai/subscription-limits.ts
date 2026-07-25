/**
 * Детектор исчерпания подписки / лимита (1.9.4). Ловит в тексте ошибки/вывода CLI
 * признаки, что активный аккаунт временно не может обслуживать: usage-лимит (Claude
 * 5-часовой), rate-limit/429, quota. При наличии — извлекает ETA сброса (relative).
 * Чистая логика, без сети. Потребитель: agent loop → переключение аккаунта пула.
 */

export type SubscriptionLimitKind = 'usage' | 'rate' | 'quota' | 'auth' | null

export interface SubscriptionLimitHit {
  limited: boolean
  kind: SubscriptionLimitKind
  /** Epoch ms, когда лимит сбросится (если удалось распарсить relative-форму), иначе null. */
  resetEta: number | null
  raw?: string
}

function parseResetEta(lower: string, now: number): number | null {
  // «try again in 2 hours» / «resets in 45 minutes» / «reset at 3 hours»
  const combined = lower.match(/reset[s]?\s+in\s+(\d+)\s*(?:hour|hr)s?\s+(\d+)\s*(?:minute|min)s?/)
  if (combined) return now + (parseInt(combined[1], 10) * 60 + parseInt(combined[2], 10)) * 60_000
  const m = lower.match(/(?:try again|reset[s]?)\s*(?:at|in)?\s*(\d+(?:\.\d+)?)\s*(hour|hr|minute|min|second|sec)/)
    ?? lower.match(/\bin\s+(\d+(?:\.\d+)?)\s*(hour|hr|minute|min|second|sec)/)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const isHours = /hour|hr/.test(m[2])
  const isSeconds = /second|sec/.test(m[2])
  return now + n * (isHours ? 60 * 60_000 : isSeconds ? 1_000 : 60_000)
}

const PERMANENT_AUTH_PATTERN =
  /token[_ -]?(?:invalidated|revoked)|invalid_grant|unauthorized_client|refresh_token_reused|authentication token has been invalidated|refresh token (?:is )?(?:invalid|revoked)/

function classifyLimit(lower: string, status: unknown): {
  kind: SubscriptionLimitKind
  permanentAuth: boolean
} {
  const permanentAuth = PERMANENT_AUTH_PATTERN.test(lower)
  if (permanentAuth) return { kind: 'auth', permanentAuth }
  if (status === 401 || /\b401\b.*(?:unauthori[sz]ed|invalid token)|authentication failed|login required/.test(lower)) {
    return { kind: 'auth', permanentAuth }
  }
  if (/usage limit|5.?hour limit|hour limit reached|limit reached for your plan|plan limit/.test(lower)) {
    return { kind: 'usage', permanentAuth }
  }
  if (/quota/.test(lower)) return { kind: 'quota', permanentAuth }
  if (status === 429 || /rate.?limit|too.?many.?requests|\b429\b/.test(lower)) {
    return { kind: 'rate', permanentAuth }
  }
  if (/\blimit reached\b/.test(lower)) return { kind: 'usage', permanentAuth }
  return { kind: null, permanentAuth }
}

export function detectSubscriptionLimit(input: unknown, now = Date.now()): SubscriptionLimitHit {
  const msg = input instanceof Error ? input.message : String(input ?? '')
  const status = (input && typeof input === 'object')
    ? (input as { status?: unknown }).status
    : null
  const lower = msg.toLowerCase()
  if (!lower.trim() && status !== 429) return { limited: false, kind: null, resetEta: null }

  const { kind, permanentAuth } = classifyLimit(lower, status)
  if (!kind) return { limited: false, kind: null, resetEta: null }
  const resetEta = kind === 'auth' && !permanentAuth
    ? now + 5 * 60_000
    : parseResetEta(lower, now)
  return { limited: true, kind, resetEta, raw: msg }
}
