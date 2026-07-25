// Распил ai.ts (2.1.10-F): durable-бухгалтерия прогона ai:send.
//
// Вынесено из registerAiIpc БЕЗ изменения логики:
//  · openAgentRun — строка agent_runs на один ai:send + первое событие Timeline +
//    route-evidence аккаунта (запрошенный one-shot / Auto-ротация);
//  · linkDevTaskRun — привязка прогона к открытой dev_task чата;
//  · startRunTimeout — сторож времени прогона.
//
// Всё best-effort: наблюдаемость не имеет права уронить прогон, поэтому каждая запись
// в БД обёрнута try/catch ровно как была. Побочные эффекты (ai:event) передаются
// callback'ом emit — порядок событий остаётся за вызывающим хендлером.

import type { AgentRuns, AgentRunOwner } from '../../storage/agent-runs'
import type { ProviderId } from '../../ai/registry'
import type { AgentMode } from '../../ai/mode-policy'
import { logRuntime, logRuntimeError } from '../../runtime-log'
import {
  AGENT_RUN_TIMEOUT_SETTING_KEY,
  abortAgentRunForTimeout,
  resolveAgentRunTimeoutPolicy,
  shouldFireRunTimeout,
} from '../../ai/run-lifecycle'
import { buildRequestedAccountEvent, buildRotateAccountEvidence, type SubscriptionSuccess } from './account-preflight'

export interface OpenAgentRunInput {
  agentRuns?: AgentRuns
  runId: string
  sendId: number
  projectPath: string | null
  chatId: number | null
  /** Сырой chatId рендерера — только для payload'ов runtime-лога. Числовой уходит в БД,
   *  сырой исторически пишется в лог; расхождение сохранено дословно при переезде. */
  chatIdRaw: string | null
  owner: AgentRunOwner
  title: string
  providerId: ProviderId
  model: string | null
  /** 2.0.7-F: что выбрал пользователь (promptRoute) — отдельно от actual после fallback. */
  requestedProviderId: ProviderId | null
  requestedModel: string | null
  agentMode: AgentMode
  /** EF-R1 Б3: аккаунт, подтверждённый pre-flight именно для этого прогона. */
  accountId: number | null
  /** Аккаунт попытки — источник route-evidence (label'ы, без id/секретов). */
  account: SubscriptionSuccess | null
  /** Явно выбранный на один запрос аккаунт (null — обычный маршрут). */
  oneShotAccountId: number | null
  emit: (event: unknown) => void
}

/**
 * Multi-agent Manager (Фаза 2): один ai:send = одна строка agent_runs. Owner
 * определяется по реально доступному в main сигналу: Explicit Review форсит
 * reviewer-промпт → 'review'; всё остальное через этот путь — обычный чат → 'main'.
 * autonomous loop НЕ проходит через runner'ы (зовёт provider.send напрямую), поэтому
 * 'background' здесь недостижим. finish вызывают сами runner'ы в finally по exitReason.
 */
export function openAgentRun(input: OpenAgentRunInput): void {
  try {
    const createdGeneration = input.agentRuns?.create({
      runId: input.runId,
      projectPath: input.projectPath ?? '',
      chatId: input.chatId,
      owner: input.owner,
      title: input.title,
      providerId: input.providerId,
      model: input.model,
      requestedProviderId: input.requestedProviderId,
      requestedModel: input.requestedModel,
      sendId: input.sendId,
      // Crash-resume: режим прогона — гард деструктива в баннере возобновления
      // (auto/bypass → авто-resume запрещён).
      agentMode: input.agentMode,
      accountId: input.accountId
    })
    const runGeneration = typeof createdGeneration === 'number' ? createdGeneration : 0
    logRuntime('agent_runs.create', {
      runId: input.runId,
      sendId: input.sendId,
      projectPath: input.projectPath,
      chatId: input.chatId,
      owner: input.owner,
      providerId: input.providerId,
      model: input.model,
      generation: runGeneration
    })
    // Timeline: исходный запрос пользователя первым событием — чтобы лента читалась
    // как нарратив (запрос → действия → итог), а не только механика.
    if (input.title) input.agentRuns?.appendEvent(input.runId, 'user_msg', { detail: input.title })
    // 2.1.3-CD: запрошенный one-shot аккаунт — первая запись route-evidence прогона.
    if (input.oneShotAccountId != null && input.account) {
      try {
        input.agentRuns?.appendEvent(input.runId, 'route', buildRequestedAccountEvent(input.account.label))
      } catch { /* best-effort */ }
    }
    // EF S1+S6: Auto pre-flight выбрал следующий готовый аккаунт ДО сетевого запроса —
    // фиксируем ротацию в Timeline и шлём route-changed (пилюля «⇄ A → B» сразу).
    if (input.account?.skipped) {
      const evidence = buildRotateAccountEvidence({
        skipped: input.account.skipped,
        toLabel: input.account.label,
        providerId: input.providerId,
        model: input.model,
      })
      try {
        input.agentRuns?.appendEvent(input.runId, 'route', evidence.runEvent)
      } catch { /* best-effort */ }
      input.emit(evidence.routeChanged)
    }
  } catch (err) {
    logRuntimeError('agent_runs.create.fail', err, { runId: input.runId, sendId: input.sendId, projectPath: input.projectPath, chatId: input.chatIdRaw })
    console.warn('[agent-runs] create failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * Dev Task Flow (Фаза 2): если у активного чата есть открытая dev_task — привязываем
 * этот прогон к ней (один dev_task ↔ N run_id). Не для review-прогонов (их активность
 * к задаче не относится). Best-effort.
 */
export function linkDevTaskRun(input: {
  link?: (projectPath: string, chatId: number | null, runId: string) => void
  projectPath: string | null
  chatId: number | null
  runId: string
  sendId: number
  owner: AgentRunOwner
  /** Сырой chatId рендерера — payload runtime-лога (см. OpenAgentRunInput.chatIdRaw). */
  chatIdRaw: string | null
}): void {
  if (!input.projectPath || input.owner !== 'main') return
  try {
    input.link?.(input.projectPath, input.chatId, input.runId)
  } catch (err) {
    logRuntimeError('dev_task.link_run.fail', err, { runId: input.runId, sendId: input.sendId, projectPath: input.projectPath, chatId: input.chatIdRaw })
    console.warn('[dev-task] linkDevTaskRun failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * Сторож времени прогона. M2: не слать таймаут, если прогон уже оборван ИЛИ уже
 * успешно завершён (endedAt проставлен finish() до clearRunTimeout в cleanup) — иначе
 * ложный timeout-тост на успешном прогоне в окне гонки finish→clearTimeout.
 */
export function startRunTimeout(input: {
  getSecret: (key: string) => string | null
  agentRuns?: AgentRuns
  controller: AbortController
  runId: string
  sendId: number
  projectPath: string | null
  /** Сырой chatId рендерера — payload runtime-лога (см. OpenAgentRunInput.chatIdRaw). */
  chatIdRaw: string | null
  providerId: ProviderId
  model: string | null
  emit: (event: unknown) => void
}): ReturnType<typeof setTimeout> {
  const timeoutPolicy = resolveAgentRunTimeoutPolicy(input.getSecret(AGENT_RUN_TIMEOUT_SETTING_KEY))
  const timeoutMinutes = Math.max(1, Math.round(timeoutPolicy.timeoutMs / 60_000))
  const timeoutMessage = `Прогон остановлен по таймауту ${timeoutMinutes} мин. Можно переотправить задачу или увеличить agent_run_timeout_ms.`
  const timer = setTimeout(() => {
    if (!shouldFireRunTimeout(input.controller.signal.aborted, input.agentRuns?.get(input.runId)?.endedAt)) return
    logRuntime('ai.run.timeout', {
      sendId: input.sendId,
      runId: input.runId,
      projectPath: input.projectPath,
      chatId: input.chatIdRaw,
      providerId: input.providerId,
      model: input.model,
      timeoutMs: timeoutPolicy.timeoutMs,
      source: timeoutPolicy.source,
      clamped: timeoutPolicy.clamped
    }, 'warn')
    try {
      input.agentRuns?.appendEvent(input.runId, 'status', {
        label: 'timeout',
        detail: timeoutMessage,
        status: 'timed_out'
      })
      input.agentRuns?.finish(input.runId, 'timed_out', { error: timeoutMessage })
    } catch (err) {
      logRuntimeError('agent_runs.timeout.finish.fail', err, { runId: input.runId, sendId: input.sendId, projectPath: input.projectPath })
    }
    input.emit({ type: 'error', message: timeoutMessage })
    abortAgentRunForTimeout(input.controller, timeoutPolicy.timeoutMs)
  }, timeoutPolicy.timeoutMs)
  timer.unref?.()
  return timer
}
