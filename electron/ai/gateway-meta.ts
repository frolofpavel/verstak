/**
 * Verstak Gateway — разбор доп-метадаты ответа (cost/balance/cache) и человеко-
 * читаемые ошибки. Чистые функции, тестируются напрямую. Вызываются из
 * openai-compat провайдера: метадата — для любого ответа (хармлесс если поля нет),
 * маппинг ошибок — только для id 'verstak-gateway'.
 */

export interface VerstakMeta {
  cost_rub?: number
  balance_rub?: number
  cache_hit_ratio?: number
  mode?: string
  preset?: string
}

/** Компактная строка для UI: «Verstak · 0.84 ₽ · Баланс 923.10 ₽ · Кэш 42%». null если пусто. */
export function formatVerstakMeta(v: VerstakMeta | null | undefined): string | null {
  if (!v || typeof v !== 'object') return null
  const parts: string[] = []
  if (typeof v.cost_rub === 'number') parts.push(`${v.cost_rub.toFixed(2)} ₽`)
  if (typeof v.balance_rub === 'number') parts.push(`Баланс ${v.balance_rub.toFixed(2)} ₽`)
  if (typeof v.cache_hit_ratio === 'number' && v.cache_hit_ratio > 0) {
    parts.push(`Кэш ${Math.round(v.cache_hit_ratio * 100)}%`)
  }
  if (parts.length === 0) return null
  return `Verstak · ${parts.join(' · ')}`
}

/**
 * Человеко-читаемая ошибка Gateway по HTTP-статусу. null → используем обычное
 * сообщение (статус не «наш»). Применять только для провайдера verstak-gateway.
 */
export function mapGatewayError(status: number | undefined, code?: string | undefined): string | null {
  if (code === 'insufficient_balance') {
    return 'Недостаточно баланса Verstak Gateway. Пополните баланс: https://agi-iri.ru/gateway'
  }
  switch (status) {
    case 401:
    case 403:
      return 'Ключ Verstak Gateway неверный или отключён. Проверьте API-ключ в Настройках.'
    case 402:
      return 'Недостаточно баланса Verstak Gateway. Пополните баланс: https://agi-iri.ru/gateway'
    case 429:
      return 'Превышен лимит Verstak Gateway. Попробуйте позже или увеличьте лимит.'
    case 503:
      return 'Модель или провайдер временно недоступны. Gateway пробовал резервный маршрут, но запрос не выполнен.'
    default:
      return null
  }
}
