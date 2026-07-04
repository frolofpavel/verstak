/**
 * Tier Router — pure-функция выбора ТИРА модели под задачу.
 *
 * Это «хребет» идеи «любая модель делает всё»: маршрутизатор смотрит на
 * сложность + признак приватности задачи и набор НАСТРОЕННЫХ провайдеров,
 * затем рекомендует тир и конкретного провайдера+модель внутри него.
 *
 * Три тира:
 *  - cheap    → дешёвые/локальные провайдеры (deepseek, ollama, groq,
 *               openrouter, mistral) для рутины;
 *  - frontier → топ-модели (claude / openai / gemini-api / grok) для сложного;
 *  - private  → российские провайдеры (yandex-gpt / gigachat) для задач,
 *               помеченных как приватные (152-ФЗ).
 *
 * ВАЖНО: это чистая функция БЕЗ side-effects. Она НЕ интегрирована в живой
 * send-flow — только рекомендация. Решение как и где её использовать —
 * за владельцем.
 */

import type { ChatMessage } from './types'
import { PROVIDERS, type ProviderId } from './registry'
import { estimateComplexity, recommendModel, type TaskComplexity } from './smart-router'

export type ModelTier = 'cheap' | 'frontier' | 'private'

export interface TierRecommendation {
  tier: ModelTier
  providerId: ProviderId
  model: string
  /** Человекочитаемое обоснование выбора (для info-события / логов). */
  reason: string
}

/**
 * Провайдеры по тирам, в порядке предпочтения. Первый настроенный из списка
 * выигрывает. Список — статика: новые провайдеры добавляются сюда вручную.
 */
const TIER_PROVIDERS: Record<ModelTier, ProviderId[]> = {
  cheap: ['verstak-gateway', 'deepseek', 'moonshot', 'qwen', 'ollama', 'groq', 'openrouter', 'mistral'],
  frontier: ['claude', 'openai', 'gemini-api', 'grok'],
  private: ['yandex-gpt', 'gigachat'],
}

/**
 * Порядок деградации при недоступности предпочтительного тира.
 * Для каждого тира — куда падать, если в нём нет настроенных провайдеров.
 * private падает на frontier (мощнее), cheap — на frontier, frontier — на cheap.
 * Приватность теряется при деградации private — это отражается в reason.
 */
const TIER_FALLBACK: Record<ModelTier, ModelTier[]> = {
  private: ['private', 'frontier', 'cheap'],
  frontier: ['frontier', 'cheap', 'private'],
  cheap: ['cheap', 'frontier', 'private'],
}

/** Признаки приватности в тексте задачи (152-ФЗ / персональные данные). */
const PRIVATE_HINTS = ['private', 'приват', 'персональн', '152', 'конфиденц', 'pii']

/** Детектит ли промпт сигнал «приватная задача» (RU/EN). */
export function detectPrivate(messages: ChatMessage[]): boolean {
  const lastUser = messages.filter(m => m.role === 'user').pop()
  if (!lastUser) return false
  const text = lastUser.content.toLowerCase()
  return PRIVATE_HINTS.some(h => text.includes(h))
}

/** Маппинг сложности на «естественный» тир (без учёта приватности). */
function complexityToTier(complexity: TaskComplexity): ModelTier {
  // simple/moderate → cheap (рутина дешевле), complex → frontier (нужна мощь).
  return complexity === 'complex' ? 'frontier' : 'cheap'
}

/**
 * Выбирает провайдера+модель внутри тира из набора настроенных.
 * Возвращает null если в тире нет ни одного настроенного провайдера
 * ЛИБО ни для одного не удалось подобрать валидную модель.
 */
function pickInTier(
  tier: ModelTier,
  complexity: TaskComplexity,
  configured: Set<string>
): { providerId: ProviderId; model: string } | null {
  for (const providerId of TIER_PROVIDERS[tier]) {
    if (!configured.has(providerId)) continue

    const descriptor = PROVIDERS[providerId]
    if (!descriptor) continue

    // recommendModel знает только про gemini/claude/openai/grok — для остальных
    // (extra/ru) вернёт null, тогда берём defaultModel провайдера.
    const recommended = recommendModel(providerId, complexity)
    const model = recommended ?? descriptor.defaultModel

    // Safety: модель обязана существовать в реестре провайдера (тот же
    // паттерн что в smart-router). Фантомную модель не возвращаем.
    if (!descriptor.models.includes(model)) {
      // Падаём на defaultModel; если и он не в списке — пропускаем провайдера.
      if (descriptor.models.includes(descriptor.defaultModel)) {
        return { providerId, model: descriptor.defaultModel }
      }
      continue
    }

    return { providerId, model }
  }
  return null
}

/**
 * Главная функция: рекомендует тир + провайдера + модель под задачу.
 *
 * @param messages    история чата (берётся последнее user-сообщение)
 * @param configuredProviderIds  ID настроенных провайдеров (есть ключ / доступны)
 * @param opts.toolHistory  история вызовов инструментов (для оценки сложности)
 * @param opts.forcePrivate явный флаг приватности (в дополнение к детекту по тексту)
 *
 * Гарантии:
 *  - НИКОГДА не возвращает провайдера вне configuredProviderIds;
 *  - НИКОГДА не возвращает модель, которой нет в PROVIDERS[id].models;
 *  - при пустом/неподходящем наборе провайдеров возвращает null.
 */
export function recommendTier(
  messages: ChatMessage[],
  configuredProviderIds: string[],
  opts: { toolHistory?: string[]; forcePrivate?: boolean } = {}
): TierRecommendation | null {
  const configured = new Set(configuredProviderIds)
  if (configured.size === 0) return null

  const complexity = estimateComplexity(messages, opts.toolHistory ?? [])
  const isPrivate = opts.forcePrivate === true || detectPrivate(messages)

  // Предпочтительный тир: приватность важнее сложности.
  const preferredTier: ModelTier = isPrivate ? 'private' : complexityToTier(complexity)

  // Проходим по цепочке деградации, берём первый тир с настроенным провайдером.
  for (const tier of TIER_FALLBACK[preferredTier]) {
    const pick = pickInTier(tier, complexity, configured)
    if (!pick) continue

    const degraded = tier !== preferredTier
    const reason = buildReason(preferredTier, tier, complexity, isPrivate, degraded, pick.providerId)
    return { tier, providerId: pick.providerId, model: pick.model, reason }
  }

  return null
}

/** Собирает человекочитаемое обоснование выбора. */
function buildReason(
  preferred: ModelTier,
  actual: ModelTier,
  complexity: TaskComplexity,
  isPrivate: boolean,
  degraded: boolean,
  providerId: ProviderId
): string {
  const base = isPrivate
    ? `Задача помечена приватной → тир «${preferred}»`
    : `Сложность «${complexity}» → тир «${preferred}»`

  if (!degraded) {
    return `${base}; выбран ${providerId}`
  }

  const lost = preferred === 'private' ? ' (приватность не гарантирована — нет RU-провайдера)' : ''
  return `${base}, но не настроен — деградация до «${actual}» (${providerId})${lost}`
}
