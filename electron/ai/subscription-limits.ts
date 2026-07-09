/**
 * Детектор исчерпания подписки / лимита (1.9.4). Ловит в тексте ошибки/вывода CLI
 * признаки, что активный аккаунт временно не может обслуживать: usage-лимит (Claude
 * 5-часовой), rate-limit/429, quota. При наличии — извлекает ETA сброса (relative).
 * Чистая логика, без сети. Потребитель: agent loop → переключение аккаунта пула.
 */

export type SubscriptionLimitKind = 'usage' | 'rate' | 'quota' | null

export interface SubscriptionLimitHit {
  limited: boolean
  kind: SubscriptionLimitKind
  /** Epoch ms, когда лимит сбросится (если удалось распарсить relative-форму), иначе null. */
  resetEta: number | null
  raw?: string
}

function parseResetEta(lower: string, now: number): number | null {
  // «try again in 2 hours» / «resets in 45 minutes» / «reset at 3 hours»
  const m = lower.match(/(?:try again|reset[s]?)\s*(?:at|in)?\s*(\d+)\s*(hour|hr|minute|min)/)
    ?? lower.match(/\bin\s+(\d+)\s*(hour|hr|minute|min)/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  if (!Number.isFinite(n)) return null
  const isHours = /hour|hr/.test(m[2])
  return now + n * (isHours ? 60 * 60_000 : 60_000)
}

export function detectSubscriptionLimit(input: unknown, now = Date.now()): SubscriptionLimitHit {
  const msg = input instanceof Error ? input.message : String(input ?? '')
  const status = (input && typeof input === 'object')
    ? (input as { status?: unknown }).status
    : null
  const lower = msg.toLowerCase()
  if (!lower.trim() && status !== 429) return { limited: false, kind: null, resetEta: null }

  let kind: SubscriptionLimitKind = null
  if (/usage limit|5.?hour limit|hour limit reached|limit reached for your plan|plan limit/.test(lower)) kind = 'usage'
  else if (/quota/.test(lower)) kind = 'quota'
  else if (status === 429 || /rate.?limit|too.?many.?requests|\b429\b/.test(lower)) kind = 'rate'
  else if (/\blimit reached\b/.test(lower)) kind = 'usage' // общий «limit reached» без квалификатора

  if (!kind) return { limited: false, kind: null, resetEta: null }
  return { limited: true, kind, resetEta: parseResetEta(lower, now), raw: msg }
}
