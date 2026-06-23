import type { ProviderId } from './registry'

// Приоритет провайдеров для автоматического fallback.
// CLI-провайдеры намеренно не включены — они требуют установленных бинарников
// и не имеют quota-ограничений как API.
const FALLBACK_CHAINS: Partial<Record<ProviderId, ProviderId[]>> = {
  'gemini-api': ['claude', 'openai', 'grok'],
  'claude':     ['gemini-api', 'openai', 'grok'],
  'grok':       ['gemini-api', 'claude', 'openai'],
  'openai':     ['claude', 'gemini-api', 'grok'],
  'deepseek':   ['gemini-api', 'claude', 'openai'],
  'moonshot':   ['deepseek', 'gemini-api', 'claude'],
  'qwen':       ['deepseek', 'gemini-api', 'claude'],
  'mistral':    ['gemini-api', 'claude', 'openai'],
  'groq':       ['gemini-api', 'claude', 'openai'],
}

// Ошибки при которых стоит пробовать другого провайдера.
const FALLBACK_PATTERNS = [
  'rate_limit', 'rate limit', 'too many requests',
  '429', '500', '502', '503',
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED',
  'overloaded', 'capacity', 'service unavailable',
  'temporarily unavailable',
]

/** Решает, стоит ли переключаться на другого провайдера при этой ошибке. */
export function shouldFallback(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (FALLBACK_PATTERNS.some(p => msg.includes(p.toLowerCase()))) return true
  // Сетевые ошибки несут код в .code (ECONNRESET/ETIMEDOUT/ECONNREFUSED), а
  // обёрнутая/кастомная ошибка может НЕ содержать текст-паттерн в message — тогда
  // фолбэк ошибочно не срабатывал. Зеркалит isRetriableError (with-retry). (F1, ревью 23.06)
  const code = (error && typeof error === 'object') ? (error as { code?: unknown }).code : null
  if (typeof code === 'string') {
    const c = code.toLowerCase()
    return FALLBACK_PATTERNS.some(p => c.includes(p.toLowerCase()))
  }
  return false
}

/**
 * Возвращает следующего кандидата для fallback.
 * @param current  — текущий провайдер, который упал
 * @param tried    — уже попробованные (включая current)
 * @param configured — провайдеры с настроенными API-ключами
 */
export function getNextFallback(
  current: ProviderId,
  tried: Set<ProviderId>,
  configured: Set<ProviderId>
): ProviderId | null {
  const chain = FALLBACK_CHAINS[current] ?? []
  for (const candidate of chain) {
    if (!tried.has(candidate) && configured.has(candidate)) {
      return candidate
    }
  }
  return null
}
