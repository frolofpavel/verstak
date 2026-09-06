/**
 * Губернатор доверия: факты работы возможности → уровень автономности, и уровень
 * → ужесточение решения о вызове инструмента.
 *
 * ПОЧЕМУ СЛОЙ, А НЕ ВТОРАЯ СИСТЕМА РЕЖИМОВ. Режим агента (ask/accept-edits/plan/
 * auto/bypass) выбирает ЧЕЛОВЕК на прогон — это его воля. Доверие ЗАРАБАТЫВАЕТ
 * возможность своей историей. Две воли не должны спорить за один вывод, поэтому
 * доверие не решает ничего само: оно умеет только сделать решение режима строже.
 * `tightenByTrust` монотонна по построению и проверена перебором всех комбинаций
 * (tests/capabilities/trust-governor.test.ts) — дыра в таком слое не краснеет,
 * она молча расширяет права.
 *
 * Порядок гейта, в который слой встраивается, не меняется: deny → plan-block →
 * ОТВЕТСТВЕННОЕ ДЕЙСТВИЕ → ask → allow → режим. Пауза перед платежом, отправкой,
 * публикацией и удалением остаётся выше всего этого и доверием не отменяется.
 */
import { TRUST_FLOOR, TRUST_LEVELS, type TrustLevel } from './capability'
import type { ToolDecision } from '../../electron/ai/mode-policy'

/**
 * Факты о работе возможности. Все поля — счётчики наблюдений, а не оценки:
 * оценку выносит `computeTrust`, и её можно перечитать, а факты подделать сложнее.
 */
export interface TrustEvidence {
  successfulRuns: number
  completedTasks: number
  verificationsPassed: number
  verificationsTotal: number
  reviewsPassed: number
  reviewsTotal: number
  humanAccepted: number
  humanRejected: number
  retries: number
  policyViolations: number
  safetyViolations: number
  unexpectedToolBehavior: number
  costOverruns: number
}

export function emptyEvidence(): TrustEvidence {
  return {
    successfulRuns: 0,
    completedTasks: 0,
    verificationsPassed: 0,
    verificationsTotal: 0,
    reviewsPassed: 0,
    reviewsTotal: 0,
    humanAccepted: 0,
    humanRejected: 0,
    retries: 0,
    policyViolations: 0,
    safetyViolations: 0,
    unexpectedToolBehavior: 0,
    costOverruns: 0,
  }
}

/** Сколько наблюдений нужно, чтобы доля вообще что-то значила. */
const MIN_OBSERVATIONS = 5

/** Доля с порогом значимости: мало наблюдений — не доля, а шум. */
function rate(passed: number, total: number): number | null {
  return total >= MIN_OBSERVATIONS ? passed / total : null
}

export interface TrustVerdict {
  level: TrustLevel
  /** Человекочитаемое основание. Уровень без причины — цифра, которой не верят. */
  reason: string
}

/**
 * Уровень по фактам.
 *
 * Число запусков САМО ПО СЕБЕ доверия не даёт — это прямое требование постановки
 * и защита от накрутки: возможность, которая много работала и ничего не доказала,
 * остаётся на чтении. Поднимают уровень только пройденные проверки, пройденные
 * ревью и принятые ЧЕЛОВЕКОМ результаты.
 */
export function computeTrust(evidence: TrustEvidence): TrustVerdict {
  // Нарушение безопасности и неожиданное поведение инструмента или сети —
  // не слагаемое в средневзвешенном, а обрыв. Никакая история не перевешивает.
  const unsafe = evidence.safetyViolations + evidence.unexpectedToolBehavior
  if (unsafe > 0) {
    return {
      level: TRUST_FLOOR,
      reason: `Нарушений безопасности: ${unsafe}. Автономность снята до разбора.`,
    }
  }

  const verification = rate(evidence.verificationsPassed, evidence.verificationsTotal)
  const review = rate(evidence.reviewsPassed, evidence.reviewsTotal)
  const humanTotal = evidence.humanAccepted + evidence.humanRejected
  const acceptance = rate(evidence.humanAccepted, humanTotal)

  const proofs = [verification, review, acceptance].filter((v): v is number => v !== null)
  if (proofs.length === 0) {
    return {
      level: 'T1',
      reason: 'Доказательств нет: ни проверок, ни ревью, ни принятых человеком результатов.',
    }
  }

  const score = proofs.reduce((a, b) => a + b, 0) / proofs.length

  // Каждое нарушение политики и каждый перерасход — минус ступень. Это не штраф
  // «в среднем»: нарушение уже произошло, и усреднять его с успехами значит
  // прятать его за ними.
  const penalty = evidence.policyViolations + evidence.costOverruns

  let index: number
  if (score >= 0.95 && proofs.length >= 2) index = 4
  else if (score >= 0.85) index = 3
  else if (score >= 0.7) index = 2
  else if (score >= 0.5) index = 1
  else index = 0

  const finalIndex = Math.max(0, index - penalty)
  const level = TRUST_LEVELS[finalIndex]

  const parts = [`доказательная доля ${(score * 100).toFixed(0)}%`]
  if (verification !== null) parts.push(`проверки ${evidence.verificationsPassed}/${evidence.verificationsTotal}`)
  if (review !== null) parts.push(`ревью ${evidence.reviewsPassed}/${evidence.reviewsTotal}`)
  if (acceptance !== null) parts.push(`человек принял ${evidence.humanAccepted} из ${humanTotal}`)
  if (penalty > 0) parts.push(`минус ${penalty} ступ. за нарушения политики и перерасход`)

  return { level, reason: parts.join('; ') }
}

/** Строгость решения. Растёт — значит строже. Единственный порядок в этом слое. */
const STRICTNESS: Record<ToolDecision, number> = { 'auto-accept': 0, confirm: 1, block: 2 }

/** Что уровень доверия разрешает САМ ПО СЕБЕ, до учёта решения режима. */
const CEILING: Record<TrustLevel, ToolDecision> = {
  // Песочница: наружу ничего без человека.
  T0: 'block',
  // Только чтение: изменяющее действие спрашивают.
  T1: 'confirm',
  // Запись с подтверждением.
  T2: 'confirm',
  // Выполнение в рамках политики — решение режима больше не ужесточается.
  T3: 'auto-accept',
  // Самостоятельно в пределах бюджета.
  T4: 'auto-accept',
}

/**
 * Ужесточение решения уровнем доверия.
 *
 * Возвращает СТРОЖАЙШЕЕ из двух: решения, принятого гейтом, и потолка уровня.
 * Ослабить невозможно по построению — ни одна ветка не выбирает менее строгое,
 * и это же проверено перебором. Именно поэтому слой безопасно ставить последним:
 * он не может отменить ни deny-правило, ни plan-режим, ни паузу перед
 * ответственным действием.
 */
export function tightenByTrust(decision: ToolDecision, trust: TrustLevel): ToolDecision {
  const ceiling = CEILING[trust]
  return STRICTNESS[ceiling] > STRICTNESS[decision] ? ceiling : decision
}
