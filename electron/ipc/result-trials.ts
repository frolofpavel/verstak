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
import type { ResultTrials } from '../storage/result-trials'
import { createTrialWorkspaces, trialWorkspaceDiff, isGitRepo, type TrialWorkspace } from '../ai/trial-workspace'
import { logRuntime } from '../runtime-log'

export interface TrialCompetitorInput {
  providerId: string
  model?: string | null
}

/** Каталоги живут в памяти процесса: они временные и снимаются вместе с состязанием. */
const workspacesByTrial = new Map<number, TrialWorkspace[]>()

export function registerResultTrialsIpc(trials: ResultTrials): void {
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
