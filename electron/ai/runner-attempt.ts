import type { AgentRuns } from '../storage/agent-runs'
import { cooldownReasonForLimitKind } from './route-policy'
import { MAX_ACCOUNT_SWITCHES, MAX_FALLBACK_ATTEMPTS, type FallbackOpts } from './runner-shared'
import { getNextFallback, shouldFallback } from './smart-fallback'
import { detectSubscriptionLimit } from './subscription-limits'
import type { ChatMessage, ChatProvider } from './types'
import type { ProviderId } from './registry'

interface Attempt {
  provider: ChatProvider
  accountId: number | null | undefined
}

export interface RouteChangeExtras {
  resetAt?: number | null
  accounts?: {
    fromLabel: string | null
    toLabel: string | null
  } | null
}

export interface FallbackFramePatch<TTools> {
  isFallbackFrame: true
  provider: ChatProvider
  tools: TTools
  initialMessages: ChatMessage[]
  providerId: ProviderId
  model: string | undefined
  nudgeBudgetUsed: number
}

export interface ApiFallbackControllerInput<TTools> {
  providerId?: ProviderId
  model?: string
  fallbackOpts?: FallbackOpts
  agentRuns?: AgentRuns
  runId?: string
  currentMessages: ChatMessage[]
  createTools: () => TTools
  getNudgeBudgetUsed: () => number
  emitRouteChanged: (
    action: 'rotate-account' | 'model-fallback' | 'refresh-auth',
    err: unknown,
    actual: { providerId: string; model: string },
    attempt: number,
    extras?: RouteChangeExtras
  ) => void
  onHandedOff: () => void
  runFallbackFrame: (patch: FallbackFramePatch<TTools>) => Promise<void>
}

export interface ApiFallbackController {
  attemptProviderFallback: (err: unknown, force?: boolean) => Promise<void> | null
  attemptAccountSwitch: (err: unknown) => Promise<void> | null
}

function createAttempt(fallbackOpts: FallbackOpts, id: ProviderId): Attempt | null {
  const viaAttempt = fallbackOpts.getNextAttempt?.(id)
  if (viaAttempt) return viaAttempt
  const provider = fallbackOpts.getNextProvider?.(id)
  return provider ? { provider, accountId: undefined } : null
}

function updateAttemptAccount(
  agentRuns: AgentRuns | undefined,
  runId: string | undefined,
  accountId: number | null | undefined
): void {
  if (accountId === undefined || !agentRuns || !runId) return
  try {
    agentRuns.updateActualAccount(runId, accountId)
  } catch {
    // Durable lineage is best-effort and must not block the fallback itself.
  }
}

function canFallback(
  fallbackOpts: FallbackOpts | undefined
): fallbackOpts is FallbackOpts {
  if (!fallbackOpts || fallbackOpts.pinnedAccount) return false
  return fallbackOpts.triedProviders.size - 1 < MAX_FALLBACK_ATTEMPTS
}

function canSwitchAccount(
  fallbackOpts: FallbackOpts | undefined
): fallbackOpts is FallbackOpts {
  if (!fallbackOpts || fallbackOpts.pinnedAccount) return false
  return (fallbackOpts.accountSwitchCount ?? 0) < MAX_ACCOUNT_SWITCHES
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Управляет только переходами между provider/account attempts.
 *
 * Основной runner по-прежнему владеет сообщениями и рекурсивным запуском кадра,
 * но bounded-policy, lineage и выбор следующей попытки теперь имеют одну точку.
 */
export function createApiFallbackController<TTools>(
  input: ApiFallbackControllerInput<TTools>
): ApiFallbackController {
  const { fallbackOpts, providerId } = input

  const attemptProviderFallback = (
    err: unknown,
    force = false
  ): Promise<void> | null => {
    if (!providerId || !canFallback(fallbackOpts)) return null

    fallbackOpts.triedProviders.add(providerId)
    if (!force && !shouldFallback(err)) return null

    const nextId = getNextFallback(
      providerId,
      fallbackOpts.triedProviders,
      fallbackOpts.configuredProviders
    )
    const attempt = nextId ? createAttempt(fallbackOpts, nextId) : null
    if (!attempt || !nextId) return null

    console.log(
      `[fallback] ${providerId} failed: ${errorMessage(err)}. Trying ${nextId}...`
    )
    fallbackOpts.triedProviders.add(nextId)
    const nextModel = fallbackOpts.getProviderModel(nextId) ?? input.model
    input.emitRouteChanged(
      'model-fallback',
      err,
      { providerId: nextId, model: nextModel ?? '' },
      fallbackOpts.triedProviders.size
    )

    if (input.agentRuns && input.runId) {
      try {
        input.agentRuns.updateActual(input.runId, nextId, nextModel ?? '')
      } catch {
        // Route evidence is best-effort and must not block the fallback itself.
      }
    }
    updateAttemptAccount(input.agentRuns, input.runId, attempt.accountId)
    input.onHandedOff()

    return input.runFallbackFrame({
      isFallbackFrame: true,
      provider: attempt.provider,
      tools: input.createTools(),
      initialMessages: input.currentMessages,
      providerId: nextId,
      model: nextModel,
      nudgeBudgetUsed: input.getNudgeBudgetUsed(),
    })
  }

  const attemptAccountSwitch = (err: unknown): Promise<void> | null => {
    if (!providerId || !canSwitchAccount(fallbackOpts)) return null

    const hit = detectSubscriptionLimit(err)
    if (!hit.limited) return null
    const switched = fallbackOpts.switchAccountOnLimit?.(
      providerId,
      hit.resetEta,
      cooldownReasonForLimitKind(hit.kind)
    )
    if (!switched?.switched) return null

    fallbackOpts.accountSwitchCount = (fallbackOpts.accountSwitchCount ?? 0) + 1
    const attempt = createAttempt(fallbackOpts, providerId)
    if (!attempt) return null

    updateAttemptAccount(input.agentRuns, input.runId, attempt.accountId)
    input.emitRouteChanged(
      'rotate-account',
      err,
      { providerId, model: input.model ?? '' },
      fallbackOpts.accountSwitchCount,
      {
        resetAt: hit.resetEta ?? null,
        accounts: {
          fromLabel: switched.fromLabel ?? null,
          toLabel: switched.toLabel ?? null,
        },
      }
    )
    input.onHandedOff()

    return input.runFallbackFrame({
      isFallbackFrame: true,
      provider: attempt.provider,
      tools: input.createTools(),
      initialMessages: input.currentMessages,
      providerId,
      model: input.model,
      nudgeBudgetUsed: input.getNudgeBudgetUsed(),
    })
  }

  return { attemptProviderFallback, attemptAccountSwitch }
}
