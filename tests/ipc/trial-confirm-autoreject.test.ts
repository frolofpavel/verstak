// Б2 (пакет живой приёмки P1, 11.08) · подтверждение опасной команды из
// СКРЫТОГО чата не виснет навсегда.
//
// ЖИВОЙ ФАКТ. Попытка состязания (скрытый чат kind=subagent) захотела `del` —
// авто-режим ответственное действие НЕ покрывает (и не должен), карточка
// подтверждения улетела в sendId, неизвестный renderer'у, показать её некому:
// попытка висела бы вечно. Прогон-источник спасло только то, что его чат открыт.
//
// РЕШЕНИЕ (вариант «б» постановки): у прогона без поверхности подтверждений
// ожидание АВТО-ОТКЛОНЯЕТСЯ (reject, никогда не accept — пауза ответственного
// действия не ослабляется ни на волос), а попытка состязания помечается честным
// failed «требовало подтверждения человека: <команда>» и прогон останавливается.
// Хук доступен ТОЛЬКО main-вызовам (AiSendInternal) — из renderer'а его нет.
//
// КОНТРОЛЬ «происходит»: обычный прогон БЕЗ хука ждёт человека как раньше и
// резолвится через pendingCommands — та же механика, что у ai:resolve.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  app: { getPath: () => tmpdir() },
}))

import type { AiSendOverrides, AiSendInternal } from '../../electron/ipc/ai'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'

const { awaitCommandConfirm } = await import('../../electron/ipc/tool-handlers/shared')
const { startTrialRuns } = await import('../../electron/ipc/result-trials')
const { openDb } = await import('../../electron/storage/db')
const { createResultTrials } = await import('../../electron/storage/result-trials')
const { createChatSessions } = await import('../../electron/storage/chat-sessions')
const { createAgentRuns } = await import('../../electron/storage/agent-runs')

const ROOT = join(__dirname, '..', '..')
const SENDER = {} as unknown as Electron.WebContents

/** Минимальный ctx для awaitCommandConfirm — ровно те поля, что он читает. */
function confirmCtx(extra?: Partial<ToolContext>): ToolContext {
  return {
    sendId: 7,
    signal: new AbortController().signal,
    pendingCommands: new Map(),
    scopedKey: (sendId: number, callId: string) => `${sendId}::${callId}`,
    ...extra,
  } as unknown as ToolContext
}

/** Бюджет ожидания сознательно МНОГО меньше testTimeout (§3.1): осмысленный
 *  красный «повисло», а не безымянный таймаут прогона. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | 'hung'> {
  return Promise.race([p, new Promise<'hung'>(res => setTimeout(() => res('hung'), ms))])
}

describe('Б2 · awaitCommandConfirm: прогон без поверхности подтверждений', () => {
  it('авто-отклоняется сразу (reject, не accept) — а не висит навсегда', async () => {
    const seen: Array<{ callId: string; toolName: string; subject: string }> = []
    const ctx = confirmCtx({ autoRejectConfirms: info => { seen.push(info) } })

    const verdict = await withDeadline(
      awaitCommandConfirm(ctx, 'call-1', { toolName: 'run_command', subject: 'del /f important.txt' }),
      250,
    )

    expect(verdict, 'подтверждение из скрытого чата всё ещё висит вечно').not.toBe('hung')
    // Пауза ответственного действия НЕ ослабляется: только отказ, никогда согласие.
    expect(verdict).toBe(false)
    // След с командой — из него собирается честный failed попытки.
    expect(seen).toEqual([{ callId: 'call-1', toolName: 'run_command', subject: 'del /f important.txt' }])
    // Висящей записи не остаётся — нечему протухать в pendingCommands.
    expect(ctx.pendingCommands.size).toBe(0)
  })

  // КОНТРОЛЬ «происходит»: без хука — прежнее поведение, человек отвечает через
  // pendingCommands (тот же ключ, что у ai:resolve), и согласие доходит.
  it('контроль: прогон с открытым чатом ждёт человека и принимает его «да»', async () => {
    const ctx = confirmCtx()
    const p = awaitCommandConfirm(ctx, 'call-2', { toolName: 'run_command', subject: 'git push' })

    expect(ctx.pendingCommands.size).toBe(1)
    const entry = ctx.pendingCommands.get('7::call-2')
    expect(entry?.sendId).toBe(7)
    entry!.resolve(true)

    await expect(p).resolves.toBe(true)
    expect(ctx.pendingCommands.size).toBe(0)
  })
})

describe('Б2 · состязание: попытка с danger-командой не виснет, а честно падает', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let trials: ReturnType<typeof createResultTrials>
  let chatSessions: ReturnType<typeof createChatSessions>
  let runs: ReturnType<typeof createAgentRuns>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-trial-confirm-'))
    db = openDb(join(dir, 'test.db'))
    trials = createResultTrials(db)
    chatSessions = createChatSessions(db)
    runs = createAgentRuns(db)
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  function makeTrial() {
    return trials.create({
      projectPath: '/p', prompt: 'почини баг',
      attempts: [
        { providerId: 'deepseek', model: 'deepseek-chat', workspace: '/w/a' },
        { providerId: 'openai', model: 'gpt-5', workspace: '/w/b' },
      ],
    })
  }

  function recordingInvoker() {
    let n = 0
    const calls: Array<{ overrides: AiSendOverrides | undefined; chatId: string | undefined; internal: AiSendInternal | undefined }> = []
    const invoke = vi.fn(async (
      _sender: unknown, _messages: unknown, projectPath: string | null, _budget?: number,
      overrides?: AiSendOverrides, chatId?: string, internal?: AiSendInternal,
    ) => {
      n++
      calls.push({ overrides, chatId, internal })
      runs.create({
        runId: `run-${n}`, projectPath: projectPath ?? '/p', chatId: chatId ? Number(chatId) : null,
        title: 'попытка', providerId: String(overrides?.providerId ?? ''), model: (overrides?.model as string | null) ?? null,
      })
      return n
    })
    return { invoke, calls }
  }

  it('хук авто-отклонения передан каждой попытке, и он main-only (internal)', async () => {
    const trial = makeTrial()
    const { invoke, calls } = recordingInvoker()
    await startTrialRuns(trials, { chatSessions, invokeAiSend: invoke, abortSend: vi.fn() }, SENDER, trial.id)

    for (const c of calls) {
      expect(typeof c.internal?.onConfirmAutoRejected, 'попытка ушла без пути честного отказа — подтверждение снова повиснет').toBe('function')
    }
  })

  it('срабатывание хука: failed «требовало подтверждения человека: <команда>» + стоп прогона', async () => {
    const trial = makeTrial()
    const { invoke, calls } = recordingInvoker()
    const abortSend = vi.fn(() => true)
    await startTrialRuns(trials, { chatSessions, invokeAiSend: invoke, abortSend }, SENDER, trial.id)

    calls[0].internal!.onConfirmAutoRejected!({ toolName: 'run_command', subject: 'del /f important.txt' })

    const attempts = trials.attempts(trial.id)
    expect(attempts[0].status).toBe('failed')
    expect(attempts[0].error).toContain('требовало подтверждения человека')
    expect(attempts[0].error).toContain('del /f important.txt')
    // Прогон попытки остановлен — модель не бродит дальше на деньгах человека.
    expect(abortSend).toHaveBeenCalledWith(1)
    // Вторая попытка не тронута.
    expect(attempts[1].status).toBe('running')
  })

  it('повторное срабатывание хука не затирает первую причину и не стопит дважды', async () => {
    const trial = makeTrial()
    const { invoke, calls } = recordingInvoker()
    const abortSend = vi.fn(() => true)
    await startTrialRuns(trials, { chatSessions, invokeAiSend: invoke, abortSend }, SENDER, trial.id)

    calls[0].internal!.onConfirmAutoRejected!({ toolName: 'run_command', subject: 'del /f a.txt' })
    calls[0].internal!.onConfirmAutoRejected!({ toolName: 'run_command', subject: 'rd /s b' })

    expect(trials.attempts(trial.id)[0].error).toContain('del /f a.txt')
    expect(abortSend).toHaveBeenCalledTimes(1)
  })

  it('пустой subject не делает причину пустой — остаётся имя инструмента', async () => {
    const trial = makeTrial()
    const { invoke, calls } = recordingInvoker()
    await startTrialRuns(trials, { chatSessions, invokeAiSend: invoke, abortSend: vi.fn(() => true) }, SENDER, trial.id)

    calls[0].internal!.onConfirmAutoRejected!({ toolName: 'execute_code', subject: '' })

    expect(trials.attempts(trial.id)[0].error).toContain('execute_code')
  })
})

// Пин на ИСТОЧНИК: правильный хук, который ai:send не доносит до ToolContext, —
// ложная закрытость (приём проекта: popup-navigation, SEC-CMD-08).
describe('Б2 · проводка хука до ToolContext реально существует', () => {
  it('ipc/ai.ts переводит internal.onConfirmAutoRejected в autoRejectConfirms прогона', () => {
    const ai = readFileSync(join(ROOT, 'electron', 'ipc', 'ai.ts'), 'utf8')
    expect(ai).toContain('onConfirmAutoRejected')
    expect(ai).toContain('autoRejectConfirms')
  })

  it('runner-api.ts кладёт autoRejectConfirms в ToolContext агентного цикла', () => {
    const runner = readFileSync(join(ROOT, 'electron', 'ai', 'runner-api.ts'), 'utf8')
    expect(runner).toContain('autoRejectConfirms')
  })
})
