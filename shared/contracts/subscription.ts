// ЕДИНЫЙ КОНТРАКТ ПОДПИСОЧНЫХ АККАУНТОВ — срез 2.0.8-B.
//
// Без рантайм-зависимостей (импортируют main и renderer). Главная задача — renderer-safe
// DTO: main-модель хранит credRef / configDir / baseUrl, но в renderer НЕ уходит ни токен,
// ни credRef, ни OAuth-path, ни configDir, ни внутренний baseUrl. Прежний toDto делал
// `{ credRef, ...rest }` и молча пропускал configDir/baseUrl — здесь строгий WHITELIST.

import { isKnownProviderId, type ProviderId } from './provider'

export type SubscriptionAuthMode = 'token' | 'config-dir' | 'oauth-file'
export type SubscriptionState = 'ready' | 'cooling' | 'login-required' | 'invalid'

export type CooldownScope = 'account' | 'model' | 'provider'
export type CooldownReason = 'quota' | 'rate-limit' | 'auth' | 'provider-unavailable' | 'unknown'

export interface SubscriptionCooldownDTO {
  scope: CooldownScope
  model?: string
  reason: CooldownReason
  /** epoch ms, до которого действует остывание; null — бессрочно/неизвестно. */
  until: number | null
}

/** Renderer-safe: НИ токена, НИ credRef, НИ configDir, НИ baseUrl, НИ OAuth-path. */
export interface SubscriptionAccountDTO {
  id: number
  providerId: ProviderId
  label: string
  authMode: SubscriptionAuthMode
  state: SubscriptionState
  active: boolean
  cooldown?: SubscriptionCooldownDTO
  lastUsedAt: number | null
  hasCredential: boolean
}

/** Привязка чата к аккаунту. pin — свойство КОНКРЕТНОГО чата, не глобальный флаг аккаунта. */
export interface ChatSubscriptionBindingDTO {
  chatId: number
  /** Провайдер СИНТЕТИЧЕСКИЙ (в БД провайдера пина нет — main берёт текущий провайдер чата)
   *  и на решение chatAccountView не влияет. Опционален: у легаси-чата провайдер может быть
   *  неизвестен, но висящее закрепление всё равно обязано дойти до UI (ре-ревью honesty #3),
   *  иначе чат-кирпич без выхода. */
  providerId?: ProviderId
  mode: 'auto' | 'pinned'
  accountId: number | null
}

/**
 * Входная (main) форма аккаунта — МОЖЕТ нести секреты. Сериализатор берёт её и отдаёт
 * whitelisted DTO. Поля credRef/configDir/baseUrl тут опциональны — сериализатор их
 * читает только для вывода authMode, но НЕ копирует в DTO.
 */
export interface SubscriptionAccountSource {
  id: number
  providerId: string
  label: string
  credRef?: string
  configDir?: string | null
  baseUrl?: string | null
  active: boolean
  state?: string | null
  coolingUntil?: number | null
  cooldownScope?: string | null
  cooldownReason?: string | null
  cooldownModel?: string | null
  lastUsedAt: number | null
}

const COOLDOWN_SCOPES: readonly string[] = ['account', 'model', 'provider']
const COOLDOWN_REASONS: readonly string[] = ['quota', 'rate-limit', 'auth', 'provider-unavailable', 'unknown']

/** Вид авторизации выводится из ФОРМЫ аккаунта, а не хранится сырым полем в DTO. */
export function subscriptionAuthMode(src: Pick<SubscriptionAccountSource, 'providerId' | 'configDir'>): SubscriptionAuthMode {
  if (src.configDir) return 'config-dir'           // codex-cli мультиаккаунт через CODEX_HOME
  if (src.providerId === 'openai-codex-oauth') return 'oauth-file' // токен из ~/.codex/auth.json
  return 'token'                                   // claude-cli и подобные: токен в SafeStorage
}

/**
 * Единственный безопасный путь аккаунт → renderer. WHITELIST полей (никакого spread src):
 * credRef/configDir/baseUrl физически не могут утечь. Состояние и cooldown вычисляются здесь.
 */
export function toSubscriptionAccountDTO(
  src: SubscriptionAccountSource,
  opts: { hasCredential: boolean; now: number },
): SubscriptionAccountDTO {
  const cooling = typeof src.coolingUntil === 'number' && src.coolingUntil > opts.now
  const state: SubscriptionState =
    src.state === 'invalid' ? 'invalid'
      : !opts.hasCredential ? 'login-required'
        : cooling ? 'cooling'
          : 'ready'

  const dto: SubscriptionAccountDTO = {
    id: src.id,
    // provider_id приходит из storage (валиден по построению); DTO-тип — ProviderId.
    providerId: src.providerId as ProviderId,
    label: src.label,
    authMode: subscriptionAuthMode(src),
    state,
    active: src.active,
    lastUsedAt: src.lastUsedAt,
    hasCredential: opts.hasCredential,
  }

  // cooldown прикрепляем ТОЛЬКО когда итоговое состояние действительно 'cooling' (ревью
  // INFO-3): invalid/login-required перебивают cooling по приоритету, и тогда cooldown-объект
  // в DTO был бы рассинхронен со state. Инвариант: dto.cooldown присутствует ⟺ state==='cooling'.
  if (state === 'cooling') {
    const scope = (COOLDOWN_SCOPES.includes(src.cooldownScope ?? '') ? src.cooldownScope : 'account') as CooldownScope
    const reason = (COOLDOWN_REASONS.includes(src.cooldownReason ?? '') ? src.cooldownReason : 'unknown') as CooldownReason
    const cd: SubscriptionCooldownDTO = { scope, reason, until: src.coolingUntil ?? null }
    if (scope === 'model' && src.cooldownModel) cd.model = src.cooldownModel
    dto.cooldown = cd
  }

  return dto
}

/** Рантайм-валидатор IPC-входа (renderer не доверяем): привязка чата к аккаунту. */
export function isChatSubscriptionBinding(v: unknown): v is ChatSubscriptionBindingDTO {
  if (typeof v !== 'object' || v === null) return false
  const b = v as Record<string, unknown>
  return typeof b.chatId === 'number'
    && isKnownProviderId(b.providerId)
    && (b.mode === 'auto' || b.mode === 'pinned')
    && (b.accountId === null || typeof b.accountId === 'number')
}
