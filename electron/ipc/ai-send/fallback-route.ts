// Распил ai.ts (2.1.10-E, срез 3): подготовка fallback-маршрута для ai:send.
//
// Вынесено из registerAiIpc БЕЗ изменения логики. Собраны три части, которые раньше
// висели в теле хендлера и дублировались между API- и CLI-веткой:
//  · isSmartFallbackAllowed — гейт: включён ли smart-fallback для этой отправки;
//  · createFallbackAttemptFactory — создание attempt'а кандидата (провайдер + аккаунт);
//  · createLimitAccountSwitcher — охлаждение аккаунта, на котором РЕАЛЬНО упал запрос;
//  · buildFallbackOpts — единый envelope для обоих runner'ов (раньше два литерала).
//
// Строгие инварианты маршрута:
//  · explicit prompt-route по умолчанию strict — при сбое НЕ переезжать молча;
//  · выбран КОНКРЕТНЫЙ аккаунт (one-shot) → строго всегда, независимо от политики;
//  · парк аккаунтов есть, но кандидат unavailable/blocked → кандидата просто НЕТ
//    (никакой молчаливой подмены на legacy-credential).

import { createProvider, PROVIDERS, type ProviderId, type ProviderDescriptor } from '../../ai/registry'
import type { PromptRouteOverride } from '../../../shared/contracts/provider'
import { getConfiguredApiProviders } from '../../ai/cross-verify'
import type { FallbackAttempt, FallbackOpts } from '../../ai/runner-shared'
import type { AgentMode } from '../../ai/mode-policy'
import type { AgentRuns } from '../../storage/agent-runs'
import type { SwitchResult } from '../../storage/subscription-accounts'
import type { CooldownReason } from '../../../shared/contracts/subscription'
import { resolveCodexHome } from './route-selection'
import type { ResolveSubscriptionAccountFn } from './account-preflight'

/**
 * Smart fallback: при ошибке (429/5xx/сеть) пробуем следующего провайдера. Только если
 * smart_fallback не отключён явно, только для API-провайдеров, только без reviewer
 * override (ревьюер работает в изоляции).
 * 2.0.7-F: explicit prompt-route по умолчанию strict. 2.1.3-CD: выбран конкретный
 * аккаунт → строго всегда (иначе запрос молча уехал бы с осознанно выбранного аккаунта).
 */
export function isSmartFallbackAllowed(input: {
  getSecret: (key: string) => string | null
  descriptor: ProviderDescriptor
  overrideProviderId?: ProviderId
  promptRoute: PromptRouteOverride | null
  oneShotAccountId: number | null
}): boolean {
  const routeFallbackAllowed = (!input.promptRoute || input.promptRoute.fallbackPolicy === 'allow') && input.oneShotAccountId == null
  return input.getSecret('smart_fallback') !== 'false'
    && input.descriptor.transport === 'API'
    && !input.overrideProviderId  // не задействуем fallback в Explicit Review
    && routeFallbackAllowed       // strict prompt-route отключает fallback
}

export interface FallbackAttemptDeps {
  getSecret: (key: string) => string | null
  getProviderModel: (id: ProviderId) => string | null
  resolveSubscriptionAccount?: ResolveSubscriptionAccountFn
}

/**
 * Создаёт fallback-attempt (провайдер + аккаунт попытки) для кандидата с теми же опциями.
 * EF-R2 Б2: возвращает FallbackAttempt — lineage аккаунта доезжает до runner'а, который
 * фиксирует/очищает run.account_id ДО выполнения попытки.
 */
export function createFallbackAttemptFactory(deps: FallbackAttemptDeps, opts: {
  chatId: number | undefined
  cwd: string
  signal: AbortSignal
  projectSystemPrompt: string | null
  skillPrompt: string | null
  effortLevel?: 'quick' | 'standard' | 'deep'
  agentMode: AgentMode
}): (fallbackId: ProviderId) => FallbackAttempt | null {
  return function makeFallbackAttempt(fallbackId: ProviderId): FallbackAttempt | null {
    const fallbackDesc = PROVIDERS[fallbackId]
    if (!fallbackDesc) return null
    const fallbackKey = fallbackDesc.secretKey ? deps.getSecret(fallbackDesc.secretKey) : null
    if (fallbackDesc.secretKey && !fallbackKey) return null
    const fallbackModel = deps.getProviderModel(fallbackId) ?? fallbackDesc.defaultModel
    // EF-R1 Б2: pre-flight НЕПОСРЕДСТВЕННО перед созданием fallback-attempt. Парк
    // аккаунтов есть, но выбор unavailable/blocked/allBlocked → НЕ подменяем молча
    // default credential (legacy env-токен / ~/.codex) — fallback-кандидата просто нет.
    // Парка нет (resolver → null) → прежний legacy-путь, accountId=null (очистка).
    const fbRes = deps.resolveSubscriptionAccount?.(fallbackId, opts.chatId) ?? null
    if (fbRes && ('unavailable' in fbRes || 'blocked' in fbRes || 'allBlocked' in fbRes)) return null
    // 1.9.3/1.9.4: при пересоздании CLI-провайдера резолвим активный аккаунт ЗАНОВО —
    // для account-switch на лимите берётся новый токен/CODEX_HOME переключённого аккаунта.
    const fbClaudeToken = fallbackId === 'claude-cli'
      ? (fbRes && 'secret' in fbRes ? fbRes.secret : deps.getSecret('claude_code_oauth_token'))
      : null
    const fbCodexHome = fbRes && 'configDir' in fbRes
      ? (fbRes.configDir || null)
      : resolveCodexHome(fallbackId, deps.resolveSubscriptionAccount, opts.chatId)
    try {
      const provider = createProvider(fallbackId, {
        apiKey: fallbackKey,
        model: fallbackModel,
        cwd: opts.cwd,
        signal: opts.signal,
        projectSystemPrompt: opts.projectSystemPrompt,
        skillPrompt: opts.skillPrompt,
        effortLevel: opts.effortLevel,
        agentMode: opts.agentMode,
        claudeOauthToken: fbClaudeToken,
        codexHome: fbCodexHome
      })
      // EF-R2 Б2: аккаунт, закреплённый за ЭТОЙ попыткой. Resolver вернул success →
      // его accountId; парка нет → null (handoff явно очистит run.account_id).
      const accountId = fbRes && 'accountId' in fbRes ? fbRes.accountId : null
      return { provider, accountId }
    } catch {
      return null
    }
  }
}

/**
 * EF-R1 Б3: охлаждаем аккаунт, на котором РЕАЛЬНО упал запрос (run.account_id), а не
 * текущий global active. EF-R2 Б2: accountId нового attempt фиксирует runner через
 * handoff-envelope (getNextAttempt) — здесь только охлаждение.
 */
export function createLimitAccountSwitcher(input: {
  agentRuns?: AgentRuns
  runId: string
  switchSubscriptionAccountOnLimit?: (providerId: string, resetEta: number | null, reason?: CooldownReason, fromAccountId?: number | null) => SwitchResult
}): (providerId: string, resetEta: number | null, reason?: CooldownReason) => SwitchResult {
  return (pid, eta, reason) => {
    let fromAccountId: number | null = null
    try {
      fromAccountId = input.agentRuns?.get(input.runId)?.accountId ?? null
    } catch { /* best-effort */ }
    return input.switchSubscriptionAccountOnLimit?.(pid, eta, reason, fromAccountId) ?? { switched: false }
  }
}

/** Единый fallback-envelope для обоих runner'ов (API и CLI получают одинаковый). */
export function buildFallbackOpts(input: {
  getSecret: (key: string) => string | null
  getProviderModel: (id: ProviderId) => string | null
  makeFallbackAttempt: (id: ProviderId) => FallbackAttempt | null
  switchAccountOnLimit: (providerId: string, resetEta: number | null, reason?: CooldownReason) => SwitchResult
  providerId: ProviderId
  pinnedAccount: boolean
}): FallbackOpts {
  return {
    getNextAttempt: input.makeFallbackAttempt,
    getProviderModel: id => input.getProviderModel(id) ?? PROVIDERS[id]?.defaultModel ?? null,
    configuredProviders: new Set(getConfiguredApiProviders(input.getSecret)),
    triedProviders: new Set([input.providerId]),
    switchAccountOnLimit: input.switchAccountOnLimit,
    pinnedAccount: input.pinnedAccount,
  }
}
