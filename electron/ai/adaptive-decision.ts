import { createHash } from 'crypto'
import type { AdaptiveDecisionV1, StepOutcomeV1 } from '../../shared/contracts/outcome'

export interface AdaptiveDecisionContext {
  attempt: number
  maxAttempts: number
  repeatedFailureCount: number
  budgetExhausted?: boolean
  transientError?: boolean
  policyBlocked?: boolean
  writeScopeViolated?: boolean
}

export function failureSignature(outcome: StepOutcomeV1): string | null {
  if (outcome.status === 'succeeded') return null
  const failedChecks = outcome.checks
    .filter(check => check.status !== 'passed')
    .map(check => `${check.command ?? 'manual'}:${check.status}:${check.exitCode ?? ''}`)
    .sort()
  const raw = JSON.stringify({
    status: outcome.status,
    failedChecks,
    assumptions: [...outcome.assumptionFailures].sort(),
    summary: outcome.summary.toLowerCase().replace(/\d+/g, '#').slice(0, 240),
  })
  return createHash('sha256').update(raw).digest('hex').slice(0, 20)
}

export function decideAdaptiveAction(outcome: StepOutcomeV1, ctx: AdaptiveDecisionContext): AdaptiveDecisionV1 {
  const signature = failureSignature(outcome)
  if (ctx.writeScopeViolated || outcome.status === 'diverged') {
    return { action: 'block', reason: 'Фактическая запись вышла за writeScope', failureSignature: signature, requiresApproval: true }
  }
  if (ctx.policyBlocked || outcome.status === 'blocked') {
    return { action: 'ask-user', reason: 'Продолжение требует пользовательского решения', failureSignature: signature, requiresApproval: true }
  }
  if (ctx.budgetExhausted) {
    return { action: 'block', reason: 'Бюджет попыток исчерпан', failureSignature: signature, requiresApproval: false }
  }
  if (outcome.assumptionFailures.length > 0) {
    return { action: 'replan', reason: 'Допущение плана не подтвердилось', failureSignature: signature, requiresApproval: false }
  }
  const checksPass = outcome.checks.every(check => check.status === 'passed')
  if (outcome.status === 'succeeded' && checksPass) {
    return { action: 'continue', reason: 'Шаг и обязательные проверки подтверждены', failureSignature: null, requiresApproval: false }
  }
  if (ctx.repeatedFailureCount >= 2) {
    return { action: 'block', reason: 'Одинаковая ошибка повторилась после replan', failureSignature: signature, requiresApproval: false }
  }
  if (ctx.repeatedFailureCount >= 1) {
    return { action: 'replan', reason: 'Повторилась та же сигнатура ошибки', failureSignature: signature, requiresApproval: false }
  }
  if (ctx.transientError && ctx.attempt < ctx.maxAttempts) {
    return { action: 'retry', reason: 'Временная ошибка, разрешена ограниченная повторная попытка', failureSignature: signature, requiresApproval: false }
  }
  return { action: 'replan', reason: 'Результат расходится с ожидаемым — нужен новый план остатка', failureSignature: signature, requiresApproval: false }
}
