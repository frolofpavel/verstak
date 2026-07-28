/**
 * §10 ТЗ VSK-TASK-FLOW-A1 — ожидание согласования плана живёт СНАРУЖИ прогона.
 *
 * ЧТО БЫЛО СЛОМАНО. Гейт ждал решения человека ВНУТРИ прогона: `create_plan`
 * блокировался на промисе, пока пользователь не нажмёт кнопку. Параллельно
 * тикал сторож времени прогона (`startRunTimeout`, настройка
 * `agent_run_timeout_ms`, по умолчанию 90 мин). Человек, ушедший от карточки на
 * обед, возвращался к мёртвому прогону: «Прогон остановлен по таймауту».
 * Утвердить было уже нечего — промис резолвился в оборванный цикл.
 *
 * РЕШЕНИЕ (вариант «б» из §10, выбран Павлом). Прогон не ждёт. `create_plan`
 * сохраняет план, привязывает его к прогону (`plans.agent_run_id`), показывает
 * карточку и СРАЗУ возвращает управление. Прогон завершается штатно, сторож
 * снимается вместе с ним. Ожидание держит БД: строка плана в `draft` + живой
 * чекпойнт прогона. После approve выполнение стартует ПРОДОЛЖЕНИЕМ по этому
 * чекпойнту (`resumeFromRunId`), а не пересборкой истории с нуля.
 *
 * Почему не вариант «а» («сторож не тикает, пока ждём человека»): пауза сторожа
 * оставляет прогон живым в памяти неограниченно долго — переживает закрытие
 * приложения только на бумаге. Сценарий 8 ТЗ (приложение закрыто во время
 * ожидания) при живом-в-памяти ожидании не выполняется в принципе, а при
 * ожидании в БД выполняется бесплатно.
 *
 * Здесь только чистая логика решения. Персистенс — в `ipc/plans.ts`, отправка
 * продолжения — в `PlanConfirm.tsx`.
 */
import type { AgentMode } from './mode-policy'
import type { PlanStatus } from '../storage/plans'
import { resolvePlanGate, type PlanDecision } from './plan-gate'

/** Что отправить в чат, чтобы работа продолжилась с места ожидания. */
export interface PlanContinuation {
  /** Текст для модели — тот же, что раньше приходил tool-результатом. */
  text: string
  /** Прогон, чей чекпойнт реплеим. null — чекпойнта нет, будет свежий старт. */
  resumeFromRunId: string | null
  /** Режим продолжения. null — режим не меняется. */
  agentMode: AgentMode | null
}

export interface PlanDecisionOutcome {
  /** Новый статус плана в БД. */
  planStatus: PlanStatus
  /** null — продолжать нечего (отклонённый план не выполняется вообще). */
  continuation: PlanContinuation | null
  /** Чекпойнт прогона больше не нужен: продолжения не будет. */
  releaseCheckpoint: boolean
}

/** Ссылка на план в момент решения — ровно то, что нужно логике. */
export interface AwaitingPlan {
  id: number
  title: string
  agentRunId: string | null
}

/**
 * Tool-результат `create_plan`, когда карточка показана, а прогон продолжать не
 * должен. Текст адресован модели: она видит его как результат инструмента.
 */
export function awaitingApprovalResult(plan: { id: number; stepCount: number }): string {
  return (
    `План #${plan.id} (${plan.stepCount} шаг(ов)) сохранён и отправлен на согласование. ` +
    'Решение принимает человек, и оно придёт ОТДЕЛЬНЫМ сообщением — ждать его в этом ходе не нужно и нельзя. ' +
    'Заверши ответ одной фразой: план готов, ждём подтверждения. ' +
    'Ни одного шага плана не выполняй.'
  )
}

/**
 * Решение человека, принятое снаружи прогона → что делать дальше.
 *
 * Тексты берём у `resolvePlanGate` — того же источника, что и раньше: смысл
 * решения от переноса ожидания не изменился, менять формулировки под новый путь
 * значило бы развести две правды об одном решении.
 */
export function planDecisionOutsideRun(
  decision: PlanDecision,
  feedback: string | undefined,
  plan: AwaitingPlan,
): PlanDecisionOutcome {
  const gate = resolvePlanGate(decision, feedback, plan.title)

  if (decision === 'reject') {
    // Ноль действий (§11.2). Продолжения нет — модели нечего сообщать, прогон
    // давно завершён. Чекпойнт освобождаем: реплеить эту историю больше некуда.
    return { planStatus: 'cancelled', continuation: null, releaseCheckpoint: true }
  }

  if (decision === 'revise') {
    // Доработка идёт ТЕМ ЖЕ планом (§11.5). Раньше это держал реестр
    // идемпотентности внутри прогона; продолжение — уже другой прогон с другим
    // sendId, реестр его не покрывает. Поэтому инструмент называем явно.
    return {
      planStatus: 'draft',
      continuation: {
        text: `${gate.result} Правь план #${plan.id} через replan_plan — новый план не создавай.`,
        resumeFromRunId: plan.agentRunId,
        agentMode: gate.newMode,
      },
      releaseCheckpoint: false,
    }
  }

  return {
    planStatus: 'running',
    continuation: {
      text: gate.result,
      resumeFromRunId: plan.agentRunId,
      agentMode: gate.newMode,
    },
    releaseCheckpoint: false,
  }
}
