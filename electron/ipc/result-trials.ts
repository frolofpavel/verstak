/**
 * P1 (волна 2.6.0): IPC состязания исполнителей.
 *
 * Одна постановка → несколько исполнителей → таблица факта → принятие ОДНОГО.
 * Здесь только контур: завести состязание с изолированными каталогами, отдать
 * таблицу, показать дифф, принять результат. Сами прогоны запускает обычный
 * путь `ai:send` — отдельного «режима бенчмарка» в продукте нет и не должно
 * быть (постановка: сравнение — побочный продукт обычной работы).
 *
 * ПОЧЕМУ ЗАПУСК НЕ АВТОМАТИЧЕСКИЙ. Второй исполнитель — это трата денег
 * человека, поэтому состязание заводится только явным вызовом, а оценка
 * расхода показывается ДО (по прайсу выбранных моделей) и факт — ПОСЛЕ
 * (из agent_runs).
 */
import { ipcMain } from 'electron'
import type { ResultTrials, TrialAttempt } from '../storage/result-trials'
import type { ChatSessions } from '../storage/chat-sessions'
import type { AiSendInvoker } from './ai'
import type { ChatMessage } from '../ai/types'
import { isKnownProviderId } from '../../shared/contracts/provider'
import { estimateTrialAttempts, type TrialTokenAssumption } from '../ai/trial-estimate'
import { createTrialWorkspaces, trialWorkspaceDiff, isGitRepo, type TrialWorkspace } from '../ai/trial-workspace'
import { logRuntime } from '../runtime-log'

export interface TrialCompetitorInput {
  providerId: string
  model?: string | null
}

/** Зависимости запуска попыток: чаты — чтобы завести скрытую сессию попытке,
 *  invokeAiSend — ТОТ ЖЕ код, что обслуживает канал ai:send (второго движка нет). */
export interface ResultTrialsDeps {
  chatSessions: Pick<ChatSessions, 'create'>
  invokeAiSend: AiSendInvoker
}

/**
 * P1 шаг 1: запуск попыток состязания. Каждая pending-попытка уходит ОБЫЧНЫМ
 * ai:send — со своей моделью, своим скрытым чатом (kind 'subagent') и своим
 * workspace (internal.isolatedRoot). Попытки не делят состояние.
 *
 * Режим прогона — 'auto' сознательно: человек ЯВНО запустил состязание, попытка
 * работает в одноразовом изолированном worktree, а окна попытки нет (панель —
 * шаг 3) — подтверждение 'ask' было бы вопросом в пустоту и молча вешало прогон.
 *
 * Отказ одного участника (нет ключа / провайдер неизвестен / ранний стоп
 * маршрута) НЕ роняет остальных и остаётся видимым: попытка помечается failed с
 * причиной — тихо исчезнувший исполнитель хуже честного отказа.
 */
export async function startTrialRuns(
  trials: ResultTrials,
  deps: ResultTrialsDeps,
  sender: Electron.WebContents,
  trialId: number,
): Promise<{ started: number; attempts: TrialAttempt[] }> {
  const trial = trials.get(trialId)
  if (!trial) throw new Error('состязание: не найдено')
  if (trial.status !== 'running') throw new Error('состязание: уже завершено — перезапуск завёл бы второй комплект прогонов')
  const pending = trials.attempts(trialId).filter(a => a.status === 'pending')
  if (pending.length === 0) throw new Error('состязание: нет ожидающих попыток — прогоны уже запускались')

  let started = 0
  for (const attempt of pending) {
    // Валидация ДО каких-либо следов: неизвестному провайдеру чат не заводим.
    if (!isKnownProviderId(attempt.providerId)) {
      trials.finishAttempt(attempt.id, { status: 'failed', error: `провайдер «${attempt.providerId}» неизвестен этой сборке` })
      continue
    }
    const chat = deps.chatSessions.create(trial.projectPath, {
      title: `Состязание #${trialId}: ${attempt.providerId}${attempt.model ? ` · ${attempt.model}` : ''}`,
      kind: 'subagent',
      parentChatId: trial.parentChatId,
      providerId: attempt.providerId,
      model: attempt.model,
    })
    trials.bindRun(attempt.id, { chatId: chat.id, status: 'running' })
    const messages: ChatMessage[] = [{ role: 'user', content: trial.prompt }]
    try {
      // invokeAiSend возвращается ПОСЛЕ подготовки (run-строка уже создана), сам
      // прогон продолжается в фоне — попытки стартуют одна за другой, работают
      // параллельно. sendId=0 — ранний стоп маршрута: run-строки нет.
      const sendId = await deps.invokeAiSend(
        sender, messages, trial.projectPath, undefined,
        { providerId: attempt.providerId, model: attempt.model, agentMode: 'auto' },
        String(chat.id),
        { isolatedRoot: attempt.workspace },
      )
      if (sendId === 0) {
        trials.finishAttempt(attempt.id, { status: 'failed', error: 'прогон не стартовал: маршрут/ключ/аккаунт (причина — в событиях чата попытки)' })
        continue
      }
      // runId генерит сам ai:send — снимаем ФАКТ из agent_runs чата попытки и
      // привязываем: по нему summary читает деньги/ходы тем же путём, что «Итого».
      const runId = trials.latestRunIdForChat(chat.id)
      if (runId) trials.bindRun(attempt.id, { runId })
      started++
      logRuntime('trial.attempt.start', { trialId, attemptId: attempt.id, chatId: chat.id, runId, providerId: attempt.providerId, model: attempt.model })
    } catch (err) {
      trials.finishAttempt(attempt.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) })
    }
  }
  logRuntime('trial.runs.started', { trialId, started, total: pending.length })
  return { started, attempts: trials.attempts(trialId) }
}

/** Каталоги живут в памяти процесса: они временные и снимаются вместе с состязанием. */
const workspacesByTrial = new Map<number, TrialWorkspace[]>()

export function registerResultTrialsIpc(trials: ResultTrials, deps: ResultTrialsDeps): void {
  // Можно ли вообще состязаться в этом проекте. UI спрашивает ДО показа кнопки:
  // предложить действие, которое немедленно откажет, — хуже, чем не предлагать.
  ipcMain.handle('result-trials:available', (_e, projectPath: string) => ({
    available: isGitRepo(projectPath),
    reason: isGitRepo(projectPath)
      ? null
      : 'Проект не под git: дать каждому исполнителю свою копию дерева нечем, а общий каталог они бы затёрли.',
  }))

  ipcMain.handle('result-trials:start', (_e, input: {
    projectPath: string
    prompt: string
    parentChatId?: number | null
    competitors: TrialCompetitorInput[]
  }) => {
    const competitors = input.competitors ?? []
    if (competitors.length < 2) {
      throw new Error('Состязание имеет смысл от двух исполнителей — иначе сравнивать не с чем.')
    }
    const spaces = createTrialWorkspaces(input.projectPath, competitors.length, 'trial')
    try {
      const trial = trials.create({
        projectPath: input.projectPath,
        parentChatId: input.parentChatId ?? null,
        prompt: input.prompt,
        attempts: competitors.map((c, i) => ({
          providerId: c.providerId,
          model: c.model ?? null,
          workspace: spaces[i].path,
        })),
      })
      workspacesByTrial.set(trial.id, spaces)
      logRuntime('trial.start', { trialId: trial.id, competitors: competitors.length, projectPath: input.projectPath })
      return { trial, attempts: trials.attempts(trial.id) }
    } catch (err) {
      // Каталоги не осиротеют: состязание не завелось — убираем за собой.
      for (const s of spaces) s.dispose()
      throw err
    }
  })

  /** P1 шаг 1: прогнать pending-попытки состязания обычным ai:send. */
  ipcMain.handle('result-trials:start-runs', (e, trialId: number) => startTrialRuns(trials, deps, e.sender, trialId))

  /** P1 шаг 2: оценка расхода ДО запуска — по прайсу выбранных моделей.
   *  Неизвестная цена остаётся null («неизвестна»), объём допущения — в ответе UI. */
  ipcMain.handle('result-trials:estimate', (_e, competitors: TrialCompetitorInput[], tokens?: TrialTokenAssumption) =>
    estimateTrialAttempts(competitors ?? [], tokens))

  ipcMain.handle('result-trials:list', (_e, projectPath: string, limit?: number) => trials.list(projectPath, limit))

  /** Таблица «что получилось · ходов · минут · рублей» — из фактов прогонов. */
  ipcMain.handle('result-trials:summary', (_e, trialId: number) => trials.summary(trialId))

  ipcMain.handle('result-trials:bind-run', (_e, attemptId: number, opts: { chatId?: number | null; runId?: string | null; status?: 'running' }) => {
    trials.bindRun(attemptId, opts)
  })

  ipcMain.handle('result-trials:finish-attempt', (_e, attemptId: number, opts: { status: 'done' | 'failed'; outcome?: string | null; error?: string | null }) => {
    trials.finishAttempt(attemptId, opts)
  })

  /** Дифф работы попытки — и принятой, и отклонённой (работа не теряется). */
  ipcMain.handle('result-trials:diff', (_e, trialId: number, attemptId: number) => {
    const attempt = trials.attempts(trialId).find(a => a.id === attemptId)
    if (!attempt) throw new Error('Попытка не найдена в этом состязании.')
    return trialWorkspaceDiff(attempt.workspace)
  })

  ipcMain.handle('result-trials:accept', (_e, trialId: number, attemptId: number) => {
    trials.accept(trialId, attemptId)
    logRuntime('trial.accept', { trialId, attemptId })
    // Каталоги СОЗНАТЕЛЬНО не удаляются на принятии: отклонённая работа должна
    // остаться доступной как дифф. Их снимает явная уборка ниже.
    return trials.summary(trialId)
  })

  /** Явная уборка каталогов состязания. Отдельным действием — по решению человека. */
  ipcMain.handle('result-trials:dispose', (_e, trialId: number) => {
    const spaces = workspacesByTrial.get(trialId)
    if (!spaces) return false
    for (const s of spaces) s.dispose()
    workspacesByTrial.delete(trialId)
    logRuntime('trial.dispose', { trialId })
    return true
  })
}
