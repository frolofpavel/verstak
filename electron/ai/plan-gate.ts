/**
 * #3 — локальный plan-approval-gate. В режиме планирования агент предлагает план
 * через create_plan, гейт БЛОКИРУЕТ-И-ЖДЁТ явного решения пользователя:
 * Approve (одобрить → выполнять) / Revise (доработать) / Reject (отклонить).
 * «Высокий контроль»: человек одобряет план ДО выполнения.
 *
 * Чистая логика решения (тестируемая); блокировка/await и UI — в ai.ts/handler.
 */
import type { AgentMode } from './mode-policy'

export type PlanDecision = 'approve' | 'revise' | 'reject'

export interface PlanGateOutcome {
  /** Текст-результат tool create_plan, который видит модель. */
  result: string
  /** Новый режим на остаток текущего прогона (approve → выполнение), иначе null. */
  newMode: AgentMode | null
}

/**
 * Отобразить решение пользователя в исход гейта. approve → включаем выполнение
 * (accept-edits: правки авто, команды всё ещё с подтверждением — безопасно).
 */
export function resolvePlanGate(decision: PlanDecision, feedback: string | undefined, title: string): PlanGateOutcome {
  const fb = feedback && feedback.trim() ? `: ${feedback.trim()}` : ''
  switch (decision) {
    case 'approve':
      return {
        result: `✅ Пользователь ОДОБРИЛ план «${title}». Приступай к выполнению его шагов по порядку. Режим переключён на выполнение правок.`,
        newMode: 'accept-edits',
      }
    case 'revise':
      return {
        result: `✏ Пользователь просит ДОРАБОТАТЬ план «${title}»${fb}. Обнови план через create_plan с учётом замечаний и снова предложи на одобрение. НЕ начинай выполнение.`,
        newMode: null,
      }
    case 'reject':
      return {
        result: `🚫 Пользователь ОТКЛОНИЛ план «${title}»${fb}. Не выполняй его. Уточни задачу или предложи принципиально другой подход.`,
        newMode: null,
      }
  }
}
