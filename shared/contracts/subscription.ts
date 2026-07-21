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
  // Колонка state авторитетна и согласована с pre-flight resolver'ом: markAccountCooling
  // всегда пишет state='cooling' вместе с cooling_until. until=NULL — «срок неизвестен»:
  // аккаунт остаётся cooling и НЕ становится ready автоматически (EF S3).
  const cooling = src.state === 'cooling' && (src.coolingUntil == null || src.coolingUntil > opts.now)
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

// ─── Срез 2.1.3-B: Subscription Doctor — renderer-safe отчёт диагностики ─────
// Doctor (electron/ai/subscription-doctor.ts) проверяет аккаунт и возвращает ЧЕЛОВЕЧЕСКИЙ
// отчёт: что работает, что требует входа и почему недоступен. Инвариант безопасности
// тот же, что у SubscriptionAccountDTO: ни токена, ни refresh, ни credRef, ни путей
// (configDir / имя файла авторизации) — только статусы и статический текст.

export type SubscriptionDoctorCheckStatus = 'ok' | 'warn' | 'fail' | 'info'

export type SubscriptionDoctorCheckId =
  | 'config-dir'     // папка стейта аккаунта существует (только config-dir аккаунты)
  | 'credential'     // авторизация присутствует (секрет в SafeStorage / непустой access_token)
  | 'oauth-expiry'   // срок действия OAuth-доступа из JWT exp: valid / скоро / истёк / неизвестен
  | 'refresh'        // есть ли refresh-токен для автообновления доступа
  | 'models'         // каталог моделей провайдера известен (справочно, без запроса)
  | 'cooldown'       // активное остывание: причина и время восстановления
  | 'last-use'       // последняя ПОПЫТКА использования (lastUsedAt пишется до результата;
                     // настоящий lastSuccessAt — осознанный долг, нужен touch после ответа)
  | 'route'          // как прогон идёт в аккаунт (конфигурация маршрута, без запуска)

export interface SubscriptionDoctorCheckDTO {
  id: SubscriptionDoctorCheckId
  status: SubscriptionDoctorCheckStatus
  /** Человеческий однострочник. Статический текст — БЕЗ путей, токенов и credRef. */
  label: string
}

export interface SubscriptionDoctorReportDTO {
  accountId: number
  providerId: ProviderId
  /** Итоговое состояние по правилам DTO + честный login-required при истёкшем доступе. */
  state: SubscriptionState
  /** fail > warn > ok (info на итог не влияет). */
  overall: 'ok' | 'warn' | 'fail'
  checks: SubscriptionDoctorCheckDTO[]
  /** Одна строка итога («Аккаунт готов к работе» / «Аккаунт недоступен: …»). */
  summary: string
  /** Следующий шаг человеку; null когда ничего делать не нужно. */
  nextStep: string | null
  checkedAt: number
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

/** Аккаунты Codex общие для codex-cli и нативного openai-codex-oauth (реестр 'codex-cli').
 *  Канонизация обязательна во ВСЕХ обращениях к парку аккаунтов (resolver, switch-on-limit,
 *  success): иначе для oauth-провайдера пул codex-cli невидим — охлаждение/выбор молча
 *  теряются. Живёт в contracts: импортируют и ai-слой, и storage (storage → ai нельзя). */
export function canonicalAccountProvider(providerId: string): string {
  return providerId === 'openai-codex-oauth' ? 'codex-cli' : providerId
}
