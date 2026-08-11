// P1 шаг 1: startTrialRuns — каждая pending-попытка состязания уходит ОБЫЧНЫМ
// ai:send со своей моделью, своим скрытым чатом и своим workspace.
//
// Что стерегут пины:
//  · попытки не делят состояние: у каждой — СВОЙ чат и СВОЙ isolatedRoot;
//  · runId привязывается из ФАКТА (agent_runs своего чата), не выдумывается;
//  · маршрут попытки строгий: провайдер/модель — попытки, не дефолт чата;
//  · отказ одного участника не роняет остальных и остаётся видимым (failed + причина);
//  · повторный запуск того же состязания — громкий отказ, не второй комплект прогонов.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  app: { getPath: () => tmpdir() },
}))

import type { AiSendOverrides, AiSendInternal } from '../../electron/ipc/ai'

const { openDb } = await import('../../electron/storage/db')
const { createResultTrials } = await import('../../electron/storage/result-trials')
const { createChatSessions } = await import('../../electron/storage/chat-sessions')
const { createAgentRuns } = await import('../../electron/storage/agent-runs')
const { startTrialRuns } = await import('../../electron/ipc/result-trials')

const SENDER = {} as unknown as Electron.WebContents

describe('P1: startTrialRuns — запуск попыток обычным ai:send', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let trials: ReturnType<typeof createResultTrials>
  let chatSessions: ReturnType<typeof createChatSessions>
  let runs: ReturnType<typeof createAgentRuns>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-trial-runs-'))
    db = openDb(join(dir, 'test.db'))
    trials = createResultTrials(db)
    chatSessions = createChatSessions(db)
    runs = createAgentRuns(db)
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  function makeTrial() {
    return trials.create({
      projectPath: '/p', prompt: 'сделай X',
      attempts: [
        { providerId: 'deepseek', model: 'deepseek-chat', workspace: '/w/a' },
        { providerId: 'openai', model: 'gpt-5', workspace: '/w/b' },
      ],
    })
  }

  /** Инвокер-двойник ai:send: пишет строку agent_runs своего чата (как openAgentRun)
   *  и возвращает sendId > 0 — тот же наблюдаемый контракт, что у настоящего. */
  function recordingInvoker() {
    let n = 0
    const calls: Array<{ messages: unknown; projectPath: string | null; overrides: AiSendOverrides | undefined; chatId: string | undefined; internal: AiSendInternal | undefined }> = []
    const invoke = vi.fn(async (
      _sender: unknown, messages: unknown, projectPath: string | null, _budget?: number,
      overrides?: AiSendOverrides, chatId?: string, internal?: AiSendInternal,
    ) => {
      n++
      calls.push({ messages, projectPath, overrides, chatId, internal })
      runs.create({
        runId: `run-${n}`, projectPath: projectPath ?? '/p', chatId: chatId ? Number(chatId) : null,
        title: 'попытка', providerId: String(overrides?.providerId ?? ''), model: (overrides?.model as string | null) ?? null,
      })
      return n
    })
    return { invoke, calls }
  }

  it('каждая попытка: свой чат, свой workspace, её провайдер/модель, режим auto', async () => {
    const trial = makeTrial()
    const { invoke, calls } = recordingInvoker()
    const res = await startTrialRuns(trials, { chatSessions, invokeAiSend: invoke, abortSend: vi.fn(() => true) }, SENDER, trial.id)

    // Контрольный кейс «действие происходит»: ровно по вызову на попытку.
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(res.started).toBe(2)

    // Постановка уходит НЕ переписанной — одним user-сообщением.
    expect(calls[0].messages).toEqual([{ role: 'user', content: 'сделай X' }])

    // Маршрут — попытки, не дефолт чата.
    expect(calls[0].overrides).toMatchObject({ providerId: 'deepseek', model: 'deepseek-chat', agentMode: 'auto' })
    expect(calls[1].overrides).toMatchObject({ providerId: 'openai', model: 'gpt-5', agentMode: 'auto' })

    // Изоляция: свой workspace каждому. (Фикстура-локатор обновлена Б2 11.08:
    // internal дополнился main-only хуком onConfirmAutoRejected — само
    // обязательство «свой isolatedRoot каждой попытке» не менялось.)
    expect(calls[0].internal).toMatchObject({ isolatedRoot: '/w/a' })
    expect(calls[1].internal).toMatchObject({ isolatedRoot: '/w/b' })

    // Свой чат каждому — скрытый (subagent), привязанный к постановке.
    const chatIds = calls.map(c => Number(c.chatId))
    expect(new Set(chatIds).size).toBe(2)
    for (const id of chatIds) {
      const chat = chatSessions.get(id)
      expect(chat).toBeTruthy()
      expect(chat!.kind).toBe('subagent')
    }
  })

  it('runId привязан из факта agent_runs — summary наполняется тем же путём, что «Итого»', async () => {
    const trial = makeTrial()
    const { invoke } = recordingInvoker()
    await startTrialRuns(trials, { chatSessions, invokeAiSend: invoke, abortSend: vi.fn(() => true) }, SENDER, trial.id)

    const attempts = trials.attempts(trial.id)
    expect(attempts.map(a => a.runId)).toEqual(['run-1', 'run-2'])
    expect(attempts.every(a => a.status === 'running')).toBe(true)

    // Факт прогона доезжает до таблицы через JOIN, без копий цифр.
    runs.finish('run-1', 'done', { costCents: 42, toolCount: 7 })
    const summary = trials.summary(trial.id)
    expect(summary[0].costCents).toBe(42)
    expect(summary[0].runStatus).toBe('done')
    expect(summary[1].runStatus).toBe('running')
  })

  it('отказ одного участника (sendId=0) — failed с причиной, второй стартует', async () => {
    const trial = makeTrial()
    const good = recordingInvoker()
    let first = true
    const invoke = vi.fn(async (...args: Parameters<typeof good.invoke>) => {
      if (first) { first = false; return 0 } // ранний стоп маршрута: run-строки нет
      return good.invoke(...args)
    })
    const res = await startTrialRuns(trials, { chatSessions, invokeAiSend: invoke, abortSend: vi.fn(() => true) }, SENDER, trial.id)

    const attempts = trials.attempts(trial.id)
    expect(attempts[0].status).toBe('failed')
    expect(attempts[0].error).toMatch(/не стартовал/i)
    expect(attempts[1].status).toBe('running')
    expect(res.started).toBe(1)
  })

  it('исключение инвокера — failed с текстом ошибки, состязание не рушится целиком', async () => {
    const trial = makeTrial()
    const good = recordingInvoker()
    let first = true
    const invoke = vi.fn(async (...args: Parameters<typeof good.invoke>) => {
      if (first) { first = false; throw new Error('нет ключа DeepSeek') }
      return good.invoke(...args)
    })
    const res = await startTrialRuns(trials, { chatSessions, invokeAiSend: invoke, abortSend: vi.fn(() => true) }, SENDER, trial.id)

    const attempts = trials.attempts(trial.id)
    expect(attempts[0].status).toBe('failed')
    expect(attempts[0].error).toContain('нет ключа DeepSeek')
    expect(res.started).toBe(1)
  })

  it('неизвестный провайдер — failed БЕЗ вызова инвокера; валидный участник стартует', async () => {
    const trial = trials.create({
      projectPath: '/p', prompt: 'сделай X',
      attempts: [
        { providerId: 'no-such-provider', model: null, workspace: '/w/a' },
        { providerId: 'deepseek', model: 'deepseek-chat', workspace: '/w/b' },
      ],
    })
    const { invoke } = recordingInvoker()
    await startTrialRuns(trials, { chatSessions, invokeAiSend: invoke, abortSend: vi.fn(() => true) }, SENDER, trial.id)

    const attempts = trials.attempts(trial.id)
    expect(attempts[0].status).toBe('failed')
    expect(attempts[0].error).toMatch(/провайдер/i)
    expect(attempts[1].status).toBe('running')
    // Инвокер звался только для валидного.
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('повторный запуск — громкий отказ: pending-попыток больше нет', async () => {
    const trial = makeTrial()
    const { invoke } = recordingInvoker()
    await startTrialRuns(trials, { chatSessions, invokeAiSend: invoke, abortSend: vi.fn(() => true) }, SENDER, trial.id)
    await expect(startTrialRuns(trials, { chatSessions, invokeAiSend: invoke, abortSend: vi.fn(() => true) }, SENDER, trial.id))
      .rejects.toThrow(/ожидающих/i)
    // Второго комплекта прогонов не случилось.
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('завершённое состязание не перезапускается', async () => {
    const trial = makeTrial()
    const { invoke } = recordingInvoker()
    await startTrialRuns(trials, { chatSessions, invokeAiSend: invoke, abortSend: vi.fn(() => true) }, SENDER, trial.id)
    trials.accept(trial.id, trials.attempts(trial.id)[0].id)
    await expect(startTrialRuns(trials, { chatSessions, invokeAiSend: invoke, abortSend: vi.fn(() => true) }, SENDER, trial.id))
      .rejects.toThrow(/заверш/i)
  })

  it('несуществующее состязание — понятная ошибка', async () => {
    const { invoke } = recordingInvoker()
    await expect(startTrialRuns(trials, { chatSessions, invokeAiSend: invoke, abortSend: vi.fn(() => true) }, SENDER, 999))
      .rejects.toThrow(/не найдено/i)
  })
})
