import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatProvider, ChatEvent } from '../../electron/ai/types'
import type { ProviderId } from '../../electron/ai/registry'

/**
 * Тест-харнес CLI-пути (runPlainConversation) — 1.9.6 #5. Весь релиз 1.9.5
 * (CLI-глубокая-интеграция) шёл через этот путь БЕЗ единого теста: Control
 * Envelope, проекция tool-событий, redactForDisplay, done/abort правились
 * вслепую. Харнес гоняет реальный loop с мок-провайдером.
 *
 * ipcMain мокаем — ai.ts тянет его на загрузке модуля.
 */
vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { getPath: () => tmpdir() } }))

// Распил 1.9.8: CLI-путь вынесен в runner-plain.
const { runPlainConversation } = await import('../../electron/ai/runner-plain')

const CLEAN_ENV = (() => {
  const e: NodeJS.ProcessEnv = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete e[k]
  return e
})()
const gitRun = (dir: string, args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', env: CLEAN_ENV })

function provider(events: ChatEvent[]): ChatProvider {
  return {
    id: 'claude-cli', name: 'claude-cli', models: ['claude-cli'],
    async *send(): AsyncGenerator<ChatEvent> { for (const e of events) yield e },
  }
}
function makeSender() { return { send: vi.fn(), exec: vi.fn(async () => undefined) } }
type Sender = ReturnType<typeof makeSender>
// Отправляются и ChatEvent, и UI-события (tool-activity/agent-progress) — берём
// широкий тип, а не ChatEvent (у последнего нет 'tool-activity').
type SentEvent = { type: string; text?: string; title?: string; detail?: string }
function sentEvents(sender: Sender): SentEvent[] {
  return sender.send.mock.calls.map(c => (c[1] as { event: SentEvent }).event)
}

// Позиционный вызов runPlainConversation (sender, sendId, provider, projectPath,
// messages, signal, recordJournal, costGuard?, providerId?, model?, fallbackOpts?, agentRuns?, runId?).
function run(dir: string, p: ChatProvider, sender: Sender, opts: { signal?: AbortSignal; agentRuns?: unknown; runId?: string; fallbackOpts?: unknown; providerId?: ProviderId; model?: string } = {}) {
  return runPlainConversation(
    sender as never, 1, p, dir, [{ role: 'user', content: 'сделай' }],
    opts.signal ?? new AbortController().signal, vi.fn(),
    undefined, opts.providerId ?? 'claude-cli', opts.model ?? 'auto', opts.fallbackOpts as never, opts.agentRuns as never, opts.runId
  )
}

describe('runPlainConversation — CLI-путь (1.9.6 #5)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plain-loop-')) })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* win lock */ } })

  it('нормальный текстовый стрим → текст доходит + терминальный done', async () => {
    const sender = makeSender()
    await run(dir, provider([{ type: 'text', text: 'Готово.' }, { type: 'done' }]), sender)
    const evs = sentEvents(sender)
    expect(evs.some(e => e.type === 'text' && (e as { text: string }).text.includes('Готово'))).toBe(true)
    expect(evs.some(e => e.type === 'done')).toBe(true)
  })

  it('Control Envelope: перед CLI-прогоном эмитится контрольная точка', async () => {
    const sender = makeSender()
    await run(dir, provider([{ type: 'text', text: 'ok' }, { type: 'done' }]), sender)
    const evs = sentEvents(sender)
    const envelope = evs.find(e => e.type === 'agent-progress' && (e as { title?: string }).title?.includes('Контрольная точка'))
    expect(envelope).toBeTruthy()
  })

  it('SECURITY: projected tool args редактируются (секрет не течёт в Timeline)', async () => {
    const sender = makeSender()
    const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789'
    await run(dir, provider([
      { type: 'tool-call', call: { id: 't1', name: 'run_command', args: { command: `curl -H "Authorization: Bearer ${secret}" https://api` } } },
      { type: 'text', text: 'ok' }, { type: 'done' },
    ]), sender)
    const evs = sentEvents(sender)
    const activity = evs.find(e => e.type === 'tool-activity') as { detail?: string } | undefined
    expect(activity).toBeTruthy()
    expect(activity!.detail).not.toContain(secret)
    expect(activity!.detail).toContain('REDACTED')
  })

  it('Control Envelope в git-репо: checkpoint-событие с полным sha в ref', async () => {
    gitRun(dir, ['init']); gitRun(dir, ['config', 'user.email', 't@t.t']); gitRun(dir, ['config', 'user.name', 'T']); gitRun(dir, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(dir, 'a.txt'), 'x'); gitRun(dir, ['add', '-A']); gitRun(dir, ['commit', '-m', 'i'])
    const appendEvent = vi.fn()
    const sender = makeSender()
    await run(dir, provider([{ type: 'text', text: 'ok' }, { type: 'done' }]), sender, { agentRuns: { appendEvent }, runId: 'r1' })
    const cp = appendEvent.mock.calls.find(c => c[1] === 'checkpoint')
    expect(cp).toBeTruthy()
    expect(cp![2].ref).toMatch(/[0-9a-f]{40}/) // полный gitHead в ref для отката
  })

  it('BEST-EFFORT persistence (2.0.8-F каветат #1): persistUsage бросает → прогон всё равно финализируется', async () => {
    // Без внутреннего try/catch в runner throw из persistUsage пробросился бы из
    // runPlainConversation → промис бы reject-нулся. Гард ловит → прогон доходит до done.
    const sender = makeSender()
    const finish = vi.fn()
    const persistUsage = vi.fn(() => { throw new Error('boom persistence') })
    await expect(run(dir, provider([
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 50, inputAccounting: 'exclusive' } } as unknown as ChatEvent,
      { type: 'text', text: 'ok' }, { type: 'done' },
    ]), sender, { agentRuns: { appendEvent: vi.fn(), finish, persistUsage }, runId: 'rF' })).resolves.toBeUndefined()
    expect(finish).toHaveBeenCalledWith('rF', expect.anything(), expect.anything()) // финализация состоялась
    expect(persistUsage).toHaveBeenCalledTimes(1) // хук был вызван и упал
    expect(sentEvents(sender).some(e => e.type === 'done')).toBe(true) // прогон дошёл до терминала
  })

  it('SECURITY/RESILIENCE: подписочный лимит → account-switch → re-run на свежем аккаунте (1.9.7 #6)', async () => {
    // Раньше CLI-путь на yielded-error просто сдавался (done+return) — авто-свитч
    // 1.9.4 был мёртв для CLI-подписок (свой главный кейс). Теперь склейка
    // detect→switch→getNextProvider→re-run прогоняется на CLI-пути.
    const limited: ChatProvider = {
      id: 'claude-cli', name: 'claude-cli', models: ['claude-cli'],
      async *send() { yield { type: 'error', message: 'Claude usage limit reached. Try again in 2 hours.' } },
    }
    const freshAccount = provider([{ type: 'text', text: 'Готово на свежем аккаунте.' }, { type: 'done' }])
    const switchAccountOnLimit = vi.fn((_providerId: string, _resetEta: number | null) => ({ switched: true }))
    const fallbackOpts = {
      getNextProvider: (_id: string) => freshAccount,
      getProviderModel: (_id: string) => 'auto',
      configuredProviders: new Set(['claude-cli']),
      triedProviders: new Set(['claude-cli']),
      switchAccountOnLimit,
    }
    const sender = makeSender()
    await run(dir, limited, sender, { fallbackOpts })
    // Свитч вызван с providerId + распарсенным ETA сброса (не null).
    expect(switchAccountOnLimit).toHaveBeenCalledTimes(1)
    expect(switchAccountOnLimit.mock.calls[0][0]).toBe('claude-cli')
    expect(switchAccountOnLimit.mock.calls[0][1]).toBeGreaterThan(0) // resetEta распарсен
    const evs = sentEvents(sender)
    // 2.0.8-D: смена аккаунта теперь структурное route-changed (было эфемерное info).
    expect(evs.some(e => e.type === 'route-changed' && (e as { action?: string }).action === 'rotate-account')).toBe(true)
    // Свежий аккаунт реально отработал (его текст дошёл).
    expect(evs.some(e => e.type === 'text' && (e as { text?: string }).text?.includes('свежем аккаунте'))).toBe(true)
  })

  // 2.0.8-D2 инвариант 1 (координатор #2): pinned-чат НЕ ротирует аккаунт на лимите.
  it('D2: pinned-чат на лимите НЕ переключает аккаунт (switchAccountOnLimit не зван)', async () => {
    const limited: ChatProvider = {
      id: 'claude-cli', name: 'claude-cli', models: ['claude-cli'],
      async *send() { yield { type: 'error', message: 'Claude usage limit reached. Try again in 2 hours.' } },
    }
    const switchAccountOnLimit = vi.fn(() => ({ switched: true }))
    const fallbackOpts = {
      getNextProvider: (_id: string) => provider([{ type: 'text', text: 'НЕ ДОЛЖНО' }, { type: 'done' }]),
      getProviderModel: (_id: string) => 'auto',
      configuredProviders: new Set(['claude-cli']),
      triedProviders: new Set(['claude-cli']),
      switchAccountOnLimit,
      pinnedAccount: true, // ← закреплённый аккаунт: авто-ротация запрещена
    }
    const sender = makeSender()
    await run(dir, limited, sender, { fallbackOpts })
    expect(switchAccountOnLimit).not.toHaveBeenCalled()          // ротации нет
    const evs = sentEvents(sender)
    expect(evs.some(e => e.type === 'route-changed')).toBe(false) // маршрут не менялся
    expect(evs.some(e => e.type === 'text' && (e as { text?: string }).text?.includes('НЕ ДОЛЖНО'))).toBe(false)
  })

  it('РЕВЬЮ-ФИКС: resetEta=null + пул все в лимите → НЕ зацикливается (bounded switches)', async () => {
    // Оба аккаунта в лимите, сообщение без парсируемого ETA (resetEta=null) →
    // switchAccountOnLimit всегда switched:true, свежий аккаунт снова лимит. Без
    // потолка это вечная рекурсия A→B→A→… (HIGH из ревью). Проверяем bound.
    const alwaysLimited = (): ChatProvider => ({
      id: 'claude-cli', name: 'claude-cli', models: ['claude-cli'],
      async *send() { yield { type: 'error', message: 'usage limit reached' } }, // resetEta=null
    })
    const switchAccountOnLimit = vi.fn((_p: string, _e: number | null) => ({ switched: true }))
    const fallbackOpts = {
      getNextProvider: () => alwaysLimited(), getProviderModel: () => 'auto',
      configuredProviders: new Set(['claude-cli']), triedProviders: new Set(['claude-cli']), switchAccountOnLimit,
      accountSwitchCount: 0,
    }
    const sender = makeSender()
    await run(dir, alwaysLimited(), sender, { fallbackOpts })
    // Bounded: свитчей не больше потолка (4), не бесконечно.
    expect(switchAccountOnLimit.mock.calls.length).toBeLessThanOrEqual(4)
    expect(sentEvents(sender).some(e => e.type === 'done')).toBe(true)
  }, 10000)

  it('лимит БЕЗ переключаемого аккаунта (пул исчерпан) → честно сдаётся, без зацикливания', async () => {
    const limited: ChatProvider = {
      id: 'claude-cli', name: 'claude-cli', models: ['claude-cli'],
      async *send() { yield { type: 'error', message: 'usage limit reached' } },
    }
    const switchAccountOnLimit = vi.fn((_providerId: string, _resetEta: number | null) => ({ switched: false })) // пул исчерпан
    const fallbackOpts = {
      getNextProvider: () => null, getProviderModel: () => 'auto',
      configuredProviders: new Set(['claude-cli']), triedProviders: new Set(['claude-cli']), switchAccountOnLimit,
    }
    const sender = makeSender()
    await run(dir, limited, sender, { fallbackOpts })
    expect(switchAccountOnLimit).toHaveBeenCalledTimes(1)
    // Не зациклился — терминальный done есть.
    expect(sentEvents(sender).some(e => e.type === 'done')).toBe(true)
  })

  it('прерванный сигнал → терминальный done, провайдер не зовётся', async () => {
    const ac = new AbortController(); ac.abort()
    const sendSpy = vi.fn()
    const p: ChatProvider = { id: 'claude-cli', name: 'claude-cli', models: ['claude-cli'], async *send() { sendSpy(); } }
    const sender = makeSender()
    await run(dir, p, sender, { signal: ac.signal })
    expect(sentEvents(sender).some(e => e.type === 'done')).toBe(true)
    expect(sendSpy).not.toHaveBeenCalled()
  })

  // ─── 2.1.3-CD: структурное route-evidence ─────────────────────────────────
  it('CD: rotate-account несёт accounts labels + resetAt; persisted ref — JSON с before/after/reason', async () => {
    const limited: ChatProvider = {
      id: 'claude-cli', name: 'claude-cli', models: ['claude-cli'],
      async *send() { yield { type: 'error', message: 'Claude usage limit reached. Try again in 2 hours.' } },
    }
    const freshAccount = provider([{ type: 'text', text: 'ок на B' }, { type: 'done' }])
    const switchAccountOnLimit = vi.fn((_p: string, _e: number | null) =>
      ({ switched: true, newAccountId: 2, fromLabel: 'Аккаунт A', toLabel: 'Аккаунт B' }))
    const fallbackOpts = {
      getNextProvider: (_id: string) => freshAccount,
      getProviderModel: (_id: string) => 'auto',
      configuredProviders: new Set(['claude-cli']),
      triedProviders: new Set(['claude-cli']),
      switchAccountOnLimit,
    }
    const appendEvent = vi.fn()
    const sender = makeSender()
    await run(dir, limited, sender, { fallbackOpts, agentRuns: { appendEvent, finish: vi.fn() }, runId: 'rCD' })
    const evs = sentEvents(sender)
    const rc = evs.find(e => e.type === 'route-changed') as {
      action?: string; reason?: string; resetAt?: number | null
      accounts?: { fromLabel: string | null; toLabel: string | null } | null
    } | undefined
    expect(rc).toBeTruthy()
    expect(rc!.action).toBe('rotate-account')
    expect(rc!.reason).toBe('quota') // «usage limit» → quota (не generic)
    // Время восстановления известно (спарсено «in 2 hours») — передаётся числом.
    expect(typeof rc!.resetAt).toBe('number')
    // Аккаунт A → B виден безопасными label'ами, не id.
    expect(rc!.accounts).toEqual({ fromLabel: 'Аккаунт A', toLabel: 'Аккаунт B' })
    // Persisted evidence: ref — структурный JSON (Timeline/Proof без разбора текста).
    const routeCall = appendEvent.mock.calls.find(c => c[1] === 'route')
    expect(routeCall).toBeTruthy()
    const ref = JSON.parse(routeCall![2].ref) as Record<string, unknown>
    expect(ref).toMatchObject({
      kind: 'rotate-account', reason: 'quota',
      fromAccountLabel: 'Аккаунт A', toAccountLabel: 'Аккаунт B',
    })
    expect(typeof ref.resetAt).toBe('number')
    // detail остаётся человекочитаемым и тоже называет аккаунты.
    expect(routeCall![2].detail).toContain('Аккаунт A')
    expect(routeCall![2].detail).toContain('Аккаунт B')
  })

  it('CD: лимит БЕЗ известного срока → resetAt null (не выдумываем «безлимит»)', async () => {
    const limited: ChatProvider = {
      id: 'claude-cli', name: 'claude-cli', models: ['claude-cli'],
      async *send() { yield { type: 'error', message: 'quota exceeded for your plan' } }, // без ETA
    }
    const freshAccount = provider([{ type: 'text', text: 'ок' }, { type: 'done' }])
    const switchAccountOnLimit = vi.fn(() => ({ switched: true, newAccountId: 2, fromLabel: 'A', toLabel: 'B' }))
    const fallbackOpts = {
      getNextProvider: (_id: string) => freshAccount, getProviderModel: () => 'auto',
      configuredProviders: new Set(['claude-cli']), triedProviders: new Set(['claude-cli']), switchAccountOnLimit,
    }
    const sender = makeSender()
    await run(dir, limited, sender, { fallbackOpts })
    const rc = sentEvents(sender).find(e => e.type === 'route-changed') as { resetAt?: number | null } | undefined
    expect(rc).toBeTruthy()
    expect(rc!.resetAt).toBeNull()
  })

  it('CD: model-fallback на plain-пути обновляет ACTUAL провайдера прогона (паритет с API-loop)', async () => {
    // Реальный сценарий ветки: API-провайдер в чате БЕЗ проекта (useToolsPath=false →
    // plain loop, smartFallbackEnabled=true по transport='API'). У CLI-провайдеров
    // цепочки fallback намеренно нет (smart-fallback.ts), поэтому стартуем с gemini-api.
    const broken: ChatProvider = {
      id: 'gemini-api', name: 'gemini-api', models: ['gemini-3-flash'],
      async *send(): AsyncGenerator<ChatEvent> { throw new Error('HTTP 503 service unavailable') },
    }
    const fallback = provider([{ type: 'text', text: 'ок на запасном' }, { type: 'done' }])
    const fallbackOpts = {
      getNextProvider: (_id: string) => fallback, getProviderModel: (_id: string) => 'claude-sonnet',
      configuredProviders: new Set(['gemini-api', 'claude']), triedProviders: new Set(['gemini-api']),
    }
    const updateActual = vi.fn()
    const sender = makeSender()
    await run(dir, broken, sender, { providerId: 'gemini-api', model: 'gemini-3-flash', fallbackOpts, agentRuns: { appendEvent: vi.fn(), finish: vi.fn(), updateActual }, runId: 'rFB' })
    // Раньше plain-путь НЕ обновлял actual: agent_run.provider_id врал про то, кто ответил.
    expect(updateActual).toHaveBeenCalledWith('rFB', 'claude', 'claude-sonnet')
  })
})


// EF-R2 Б2: account lineage при handoff — durable run получает фактический аккаунт
// попытки (или явный null при уходе на провайдер без managed-аккаунта).
describe('EF-R2 Б2: account lineage при fallback (production-path)', () => {
  let dir2: string
  beforeEach(() => { dir2 = mkdtempSync(join(tmpdir(), 'plain-lineage-')) })
  afterEach(() => { try { rmSync(dir2, { recursive: true, force: true }) } catch { /* win lock */ } })

  it('same-provider rotation: accountId нового аккаунта доезжает до run (production getNextAttempt)', async () => {
    const limited: ChatProvider = {
      id: 'claude-cli', name: 'claude-cli', models: ['claude-cli'],
      async *send() { yield { type: 'error', message: 'Claude usage limit reached. Try again in 2 hours.' } },
    }
    const freshAccount = provider([{ type: 'text', text: 'ок на B' }, { type: 'done' }])
    const switchAccountOnLimit = vi.fn(() => ({ switched: true, newAccountId: 7, fromLabel: 'A', toLabel: 'B' }))
    // Production ai.ts передаёт getNextAttempt (не legacy getNextProvider).
    const fallbackOpts = {
      getNextAttempt: (_id: string) => ({ provider: freshAccount, accountId: 7 }),
      getProviderModel: () => 'auto',
      configuredProviders: new Set(['claude-cli']), triedProviders: new Set(['claude-cli']),
      switchAccountOnLimit,
    }
    const updateActualAccount = vi.fn()
    const sender = makeSender()
    await run(dir2, limited, sender, { fallbackOpts, agentRuns: { appendEvent: vi.fn(), finish: vi.fn(), updateActualAccount }, runId: 'rROT' })
    expect(updateActualAccount).toHaveBeenCalledWith('rROT', 7)
    expect(sentEvents(sender).some(e => e.type === 'route-changed' && (e as { action?: string }).action === 'rotate-account')).toBe(true)
  })

  it('cross-provider: managed → API БЕЗ managed-аккаунта → run.account_id очищается до null', async () => {
    const broken: ChatProvider = {
      id: 'gemini-api', name: 'gemini-api', models: ['gemini-3-flash'],
      async *send(): AsyncGenerator<ChatEvent> { throw new Error('HTTP 503 service unavailable') },
    }
    const fallback = provider([{ type: 'text', text: 'ок на запасном' }, { type: 'done' }])
    const fallbackOpts = {
      // У fallback-провайдера managed-аккаунта нет → attempt несёт ЯВНЫЙ null.
      getNextAttempt: (_id: string) => ({ provider: fallback, accountId: null }),
      getProviderModel: (_id: string) => 'claude-sonnet',
      configuredProviders: new Set(['gemini-api', 'claude']), triedProviders: new Set(['gemini-api']),
    }
    const updateActual = vi.fn()
    const updateActualAccount = vi.fn()
    const sender = makeSender()
    await run(dir2, broken, sender, { providerId: 'gemini-api', model: 'gemini-3-flash', fallbackOpts, agentRuns: { appendEvent: vi.fn(), finish: vi.fn(), updateActual, updateActualAccount }, runId: 'rCLR' })
    // account_id очищен — success/cooldown НЕ уйдут аккаунту упавшего провайдера.
    expect(updateActualAccount).toHaveBeenCalledWith('rCLR', null)
    expect(updateActual).toHaveBeenCalledWith('rCLR', 'claude', 'claude-sonnet')
  })

  it('cross-provider: API → managed-аккаунт B → run получает B ДО выполнения попытки', async () => {
    const broken: ChatProvider = {
      id: 'gemini-api', name: 'gemini-api', models: ['gemini-3-flash'],
      async *send(): AsyncGenerator<ChatEvent> { throw new Error('HTTP 503 service unavailable') },
    }
    const fallback = provider([{ type: 'text', text: 'ок на codex B' }, { type: 'done' }])
    const fallbackOpts = {
      getNextAttempt: (_id: string) => ({ provider: fallback, accountId: 42 }),
      getProviderModel: (_id: string) => 'claude-sonnet',
      configuredProviders: new Set(['gemini-api', 'claude']), triedProviders: new Set(['gemini-api']),
    }
    const updateActualAccount = vi.fn()
    const sender = makeSender()
    await run(dir2, broken, sender, { providerId: 'gemini-api', model: 'gemini-3-flash', fallbackOpts, agentRuns: { appendEvent: vi.fn(), finish: vi.fn(), updateActual: vi.fn(), updateActualAccount }, runId: 'rSET' })
    expect(updateActualAccount).toHaveBeenCalledWith('rSET', 42)
    expect(sentEvents(sender).some(e => e.type === 'text' && (e as { text?: string }).text?.includes('codex B'))).toBe(true)
  })

  it('legacy getNextProvider без lineage → accountId прогона НЕ трогается (обратная совместимость)', async () => {
    const broken: ChatProvider = {
      id: 'gemini-api', name: 'gemini-api', models: ['gemini-3-flash'],
      async *send(): AsyncGenerator<ChatEvent> { throw new Error('HTTP 503 service unavailable') },
    }
    const fallback = provider([{ type: 'text', text: 'ок' }, { type: 'done' }])
    const fallbackOpts = {
      getNextProvider: (_id: string) => fallback, // legacy-вариант, как в старых тестах
      getProviderModel: (_id: string) => 'claude-sonnet',
      configuredProviders: new Set(['gemini-api', 'claude']), triedProviders: new Set(['gemini-api']),
    }
    const updateActualAccount = vi.fn()
    const sender = makeSender()
    await run(dir2, broken, sender, { providerId: 'gemini-api', model: 'gemini-3-flash', fallbackOpts, agentRuns: { appendEvent: vi.fn(), finish: vi.fn(), updateActual: vi.fn(), updateActualAccount }, runId: 'rLEG' })
    expect(updateActualAccount).not.toHaveBeenCalled()
  })
})
