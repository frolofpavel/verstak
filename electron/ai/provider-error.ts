/**
 * Классификатор ошибок провайдеров → категория + человеко-понятное RU-сообщение.
 *
 * Источник: конкурентный разбор (OpenCode `provider/error.ts`). Раньше юзер видел
 * сырое `err.message` («429», «AuthenticationError: ...») и не понимал что делать.
 * Теперь ошибка классифицируется и сопровождается понятным сообщением + советом.
 *
 * `retriable` берём из isRetriableError (with-retry) — единый источник истины,
 * чтобы классификатор и backoff/fallback не разъезжались.
 */
import { isRetriableError } from './with-retry'

export type ProviderErrorCategory =
  | 'rate_limit'
  | 'overloaded'
  | 'auth'
  | 'context_length'
  | 'content_filter'
  | 'bad_request'
  | 'timeout'
  | 'network'
  | 'unknown'

export interface ClassifiedError {
  category: ProviderErrorCategory
  /** Готовое сообщение пользователю (русский, с советом что делать). */
  userMessage: string
  /** Имеет ли смысл повтор/фолбэк — консистентно с isRetriableError. */
  retriable: boolean
}

interface ErrLike {
  status?: number
  statusCode?: number
  code?: string
  message?: string
  cause?: unknown
}

function statusOf(e: ErrLike): number | undefined {
  return typeof e.status === 'number' ? e.status
    : typeof e.statusCode === 'number' ? e.statusCode : undefined
}

function rawMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && typeof (err as ErrLike).message === 'string') {
    return (err as ErrLike).message as string
  }
  return String(err)
}

/** Классифицирует ошибку провайдера в категорию + RU-сообщение для пользователя. */
export function classifyProviderError(err: unknown): ClassifiedError {
  const retriable = isRetriableError(err)
  const e: ErrLike = (err && typeof err === 'object') ? (err as ErrLike) : {}
  const status = statusOf(e)
  const m = rawMessage(err).toLowerCase()

  const cat = (category: ProviderErrorCategory, userMessage: string): ClassifiedError =>
    ({ category, userMessage, retriable })

  // Порядок важен: специфичные паттерны раньше общих.
  if (/context.?length|maximum context|context_length_exceeded|too many tokens|reduce the length|prompt is too long/.test(m)) {
    return { category: 'context_length', retriable: false,
      userMessage: 'Слишком длинный контекст для этой модели. Сократите историю чата или выберите модель с большим контекстным окном.' }
  }
  if (/content.?filter|content_policy|safety|flagged|responsible ai|content management policy/.test(m)) {
    return { category: 'content_filter', retriable: false,
      userMessage: 'Запрос отклонён фильтром безопасности провайдера. Переформулируйте запрос.' }
  }
  if (status === 429 || /\b429\b|rate.?limit|too.?many.?requests|quota/.test(m)) {
    return cat('rate_limit', 'Превышен лимит запросов к провайдеру. Подождите немного или переключите провайдера/ключ.')
  }
  if (status === 401 || status === 403 || /\b40[13]\b|unauthorized|authentication|invalid.*api.?key|permission denied|api key/.test(m)) {
    return { category: 'auth', retriable: false,
      userMessage: 'Провайдер отклонил ключ (авторизация). Проверьте API-ключ провайдера в настройках.' }
  }
  if (status === 503 || status === 529 || /\b50[39]\b|overloaded|service.?unavailable|temporarily unavailable|server is busy/.test(m)) {
    return cat('overloaded', 'Провайдер перегружен или временно недоступен. Пробую повтор; можно переключить провайдера.')
  }
  if (/timeout|timed.?out/.test(m)) {
    return cat('timeout', 'Превышено время ожидания ответа провайдера. Пробую повтор.')
  }
  if (e.code && /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_SOCKET/.test(e.code) || /econnreset|socket hang up|network|fetch failed/.test(m)) {
    return cat('network', 'Сетевой сбой при обращении к провайдеру. Пробую повтор.')
  }
  if (status === 400 || status === 422 || /\b4(00|22)\b|invalid.?request|bad request/.test(m)) {
    return { category: 'bad_request', retriable: false,
      userMessage: 'Провайдер отклонил запрос (некорректные параметры).' }
  }
  const snippet = rawMessage(err).slice(0, 160)
  return { category: 'unknown', retriable,
    userMessage: `Ошибка провайдера: ${snippet}` }
}
