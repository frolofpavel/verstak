// 2.1.10-F: durable-бухгалтерия прогона (agent_runs, привязка dev_task, сторож
// таймаута) вынесена из тела ai:send в ai-send/run-bookkeeping.ts.
//
// Проверяем ровно те свойства, ради которых блок и написан:
//  · наблюдаемость best-effort — падение записи в БД НЕ роняет прогон;
//  · сторож не стреляет по уже оборванному и по уже завершённому прогону (M2:
//    иначе успешный прогон получал ложный timeout-тост в окне гонки finish→clear);
//  · выстрел таймаута пишет статус, финиширует run, шлёт ошибку и рвёт controller.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  app: { getPath: () => tmpdir() },
  BrowserWindow: { fromWebContents: () => null },
}))

const { openAgentRun, linkDevTaskRun, startRunTimeout } = await import('../../electron/ipc/ai-send/run-bookkeeping')

const TIMEOUT_MS = 60_000  // выше MIN_AGENT_RUN_TIMEOUT_MS, политика не зажмёт

function makeRuns(overrides: Record<string, unknown> = {}) {
  return {
    create: vi.fn((_input: Record<string, unknown>) => 0),
    appendEvent: vi.fn(),
    finish: vi.fn(),
    get: vi.fn(() => null),
    ...overrides,
  }
}

const baseRun = {
  runId: 'run-1',
  sendId: 1,
  projectPath: '/proj',
  chatId: 7,
  chatIdRaw: '7',
  owner: 'main' as const,
  title: 'сделай',
  providerId: 'claude' as const,
  model: 'claude-sonnet-4-6',
  requestedProviderId: null,
  requestedModel: null,
  agentMode: 'ask' as const,
  accountId: null,
  account: null,
  oneShotAccountId: null,
}

describe('openAgentRun — строка прогона и route-evidence', () => {
  it('создаёт run и пишет исходный запрос первым событием Timeline', () => {
    const agentRuns = makeRuns()
    openAgentRun({ ...baseRun, agentRuns: agentRuns as never, emit: vi.fn() })
    expect(agentRuns.create).toHaveBeenCalledTimes(1)
    expect(agentRuns.create.mock.calls[0][0]).toMatchObject({ runId: 'run-1', chatId: 7, owner: 'main', accountId: null })
    expect(agentRuns.appendEvent).toHaveBeenCalledWith('run-1', 'user_msg', { detail: 'сделай' })
  })

  it('падение записи в БД не роняет прогон — наблюдаемость best-effort', () => {
    const agentRuns = makeRuns({ create: vi.fn(() => { throw new Error('db locked') }) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => openAgentRun({ ...baseRun, agentRuns: agentRuns as never, emit: vi.fn() })).not.toThrow()
    warn.mockRestore()
  })

  it('Auto-ротация аккаунта: событие в Timeline + route-changed рендереру, без секретов', () => {
    const agentRuns = makeRuns()
    const emit = vi.fn()
    openAgentRun({
      ...baseRun,
      agentRuns: agentRuns as never,
      account: {
        accountId: 5, secret: 'sk-SECRET', configDir: null, baseUrl: null, pinned: false, label: 'Аккаунт B',
        skipped: { fromLabel: 'Аккаунт A', reason: 'cooling', resetAt: 1_800_000_000_000 },
      },
      emit,
    })
    const route = agentRuns.appendEvent.mock.calls.find(c => c[1] === 'route')
    expect(route).toBeTruthy()
    expect(JSON.stringify(route![2])).toContain('Аккаунт A')
    expect(JSON.stringify(route![2])).not.toContain('sk-SECRET')
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][0]).toMatchObject({ type: 'route-changed', action: 'rotate-account' })
  })

  it('обычный маршрут (без one-shot и без ротации) route-событий не порождает', () => {
    const agentRuns = makeRuns()
    const emit = vi.fn()
    openAgentRun({ ...baseRun, agentRuns: agentRuns as never, emit })
    expect(agentRuns.appendEvent.mock.calls.some(c => c[1] === 'route')).toBe(false)
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('linkDevTaskRun — привязка прогона к открытой задаче', () => {
  it('привязывает только main-прогон с проектом', () => {
    const link = vi.fn()
    linkDevTaskRun({ link, projectPath: '/proj', chatId: 7, chatIdRaw: '7', runId: 'r', sendId: 1, owner: 'main' })
    expect(link).toHaveBeenCalledWith('/proj', 7, 'r')
  })

  it('review-прогон и прогон без проекта не привязываются', () => {
    const link = vi.fn()
    linkDevTaskRun({ link, projectPath: '/proj', chatId: 7, chatIdRaw: '7', runId: 'r', sendId: 1, owner: 'review' })
    linkDevTaskRun({ link, projectPath: null, chatId: 7, chatIdRaw: '7', runId: 'r', sendId: 1, owner: 'main' })
    expect(link).not.toHaveBeenCalled()
  })

  it('сбой привязки не роняет прогон', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => linkDevTaskRun({
      link: () => { throw new Error('no task table') },
      projectPath: '/proj', chatId: null, chatIdRaw: null, runId: 'r', sendId: 1, owner: 'main',
    })).not.toThrow()
    warn.mockRestore()
  })
})

describe('startRunTimeout — сторож времени прогона', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const startArgs = (agentRuns: unknown, controller: AbortController, emit: (e: unknown) => void) => ({
    getSecret: (k: string) => (k === 'agent_run_timeout_ms' ? String(TIMEOUT_MS) : null),
    agentRuns: agentRuns as never,
    controller,
    runId: 'run-1',
    sendId: 1,
    projectPath: '/proj',
    chatIdRaw: '7',
    providerId: 'claude' as const,
    model: 'claude-sonnet-4-6',
    emit,
  })

  it('по истечении срока: статус, finish, ошибка в чат и обрыв прогона', () => {
    const agentRuns = makeRuns()
    const ctrl = new AbortController()
    const emit = vi.fn()
    startRunTimeout(startArgs(agentRuns, ctrl, emit))
    vi.advanceTimersByTime(TIMEOUT_MS)
    expect(agentRuns.appendEvent).toHaveBeenCalledWith('run-1', 'status', expect.objectContaining({ label: 'timeout', status: 'timed_out' }))
    expect(agentRuns.finish).toHaveBeenCalledWith('run-1', 'timed_out', expect.objectContaining({ error: expect.stringContaining('таймауту') }))
    expect(emit.mock.calls[0][0]).toMatchObject({ type: 'error' })
    expect(ctrl.signal.aborted).toBe(true)
  })

  it('прогон уже оборван — сторож молчит (никакого ложного тоста поверх Stop)', () => {
    const agentRuns = makeRuns()
    const ctrl = new AbortController()
    const emit = vi.fn()
    startRunTimeout(startArgs(agentRuns, ctrl, emit))
    ctrl.abort()
    vi.advanceTimersByTime(TIMEOUT_MS)
    expect(agentRuns.finish).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('M2: прогон уже успешно завершён (endedAt проставлен) — сторож молчит', () => {
    const agentRuns = makeRuns({ get: vi.fn(() => ({ endedAt: 123 })) })
    const ctrl = new AbortController()
    const emit = vi.fn()
    startRunTimeout(startArgs(agentRuns, ctrl, emit))
    vi.advanceTimersByTime(TIMEOUT_MS)
    expect(agentRuns.finish).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect(ctrl.signal.aborted).toBe(false)
  })

  it('снятый таймер не стреляет (cleanup прогона)', () => {
    const agentRuns = makeRuns()
    const ctrl = new AbortController()
    const emit = vi.fn()
    const timer = startRunTimeout(startArgs(agentRuns, ctrl, emit))
    clearTimeout(timer)
    vi.advanceTimersByTime(TIMEOUT_MS * 2)
    expect(emit).not.toHaveBeenCalled()
  })
})
