/**
 * Ядро надёжности Pipeline (v3, Шаг A): verify-gate.
 *
 * Принцип украден у ClawCode-статус-машины: модель НЕ вправе объявить задачу
 * «готовой» — решает ПРОВЕРКА (код), а не модель. Провал проверки не идёт в
 * proof/completed, а возвращает прогон на execute (авто-починка, «без извини»),
 * с лимитом попыток → честный стоп 'blocked' вместо тихого «готово».
 *
 * Чистая функция: вызывающий (оркестрация Pipeline) маппит реальный verify-статус
 * в VerifyOutcome и исполняет решение. Тестируется без UI/БД.
 */

export type VerifyOutcome = 'pass' | 'fail' | 'unknown'

export type GateDecision =
  | { action: 'proof' }                          // проверка прошла → к доказательству
  | { action: 'retry'; nextAttempt: number }     // провал, есть попытки → назад на execute
  | { action: 'blocked'; reason: string }        // попытки исчерпаны → честный стоп

/** Сколько раз прогоняем execute→verify до честного стопа. 2 = исходный + 1 авто-починка. */
export const MAX_VERIFY_ATTEMPTS = 2

/**
 * Решение verify-gate.
 * @param verify  результат проверки: pass / fail / unknown (нет проверки в проекте)
 * @param attempt какая это по счёту проверка (1-based: 1 = первый прогон verify)
 * @param maxAttempts лимит попыток (default MAX_VERIFY_ATTEMPTS)
 */
export function decidePipelineGate(
  verify: VerifyOutcome,
  attempt: number,
  maxAttempts: number = MAX_VERIFY_ATTEMPTS,
): GateDecision {
  // pass → проверка решила «готово», идём к proof.
  if (verify === 'pass') return { action: 'proof' }

  // unknown → нет доказуемой проверки для этого прогона. Для Proof Pack лучше
  // остановиться честно, чем выпустить красивое, но неподтверждённое «готово».
  if (verify === 'unknown') {
    return {
      action: 'blocked',
      reason: 'Проверка для этого прогона не найдена. Нужен attest_verification или ручная проверка.',
    }
  }

  // fail → НЕ идём в proof. Пока есть попытки — назад на execute (само-починка).
  if (attempt < maxAttempts) return { action: 'retry', nextAttempt: attempt + 1 }

  // Попытки исчерпаны — честный стоп, а не тихое «completed».
  return {
    action: 'blocked',
    reason: `Проверка не прошла после ${maxAttempts} попыток. Нужно вмешательство.`,
  }
}
