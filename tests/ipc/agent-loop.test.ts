import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatProvider, ChatEvent, ChatMessage } from '../../electron/ai/types'

/**
 * Тест-харнес для главного agent-loop (runApiConversation). Долгое время это была
 * непокрытая зона (CLAUDE.md §5 #3) — fallback/supplements/finalize правились
 * вслепую (#7/#12/#14/#15). Харнес гоняет реальный loop с мок-провайдером.
 *
 * ipcMain мокаем — ai.ts тянет его на загрузке модуля.
 */
vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { getPath: () => tmpdir() } }))

const { runApiConversation, pushConversationSupplement } = await import('../../electron/ipc/ai')
const { createFileTools } = await import('../../electron/ai/tools')
const { createCostGuard } = await import('../../electron/ai/cost-guard')

/** Мок-провайдер: per-turn скрипт событий. throwErr → падает на send (для fallback). */
function provider(id: string, script: (turn: number) => ChatEvent[], throwErr?: Error): ChatProvider {
  let turn = 0
  return {
    id, name: id, models: [id],
    async *send(): AsyncGenerator<ChatEvent> {
      turn++
      if (throwErr) throw throwErr
      for (const e of script(turn)) yield e
    },
  }
}

type Overrides = {
  provider: ChatProvider
  providerId?: string
  model?: string
  costGuard?: ReturnType<typeof createCostGuard>
  agentRuns?: unknown
  runId?: string
  fallbackOpts?: unknown
  messages?: ChatMessage[]
  sender?: ReturnType<typeof makeSender>
  signal?: AbortSignal
  recordJournal?: ReturnType<typeof vi.fn>
}

function makeSender() { return { send: vi.fn(), exec: vi.fn(async () => undefined) } }

// Сборка AgentRunContext (один объект) для runApiConversation. Возвращаем как
// 1-элементный массив, чтобы существующий спред `...(args() as Parameters<...>)`
// в вызовах работал без правок (Parameters теперь = [AgentRunContext]).
function args(dir: string, o: Overrides): unknown[] {
  const signal = o.signal ?? new AbortController().signal
  const ctx = {
    sender: o.sender ?? makeSender(), sendId: 1, provider: o.provider, tools: createFileTools(dir, signal), projectPath: dir,
    initialMessages: o.messages ?? [{ role: 'user', content: 'hi' }], signal,
    recordWrite: vi.fn(), recordPlan: vi.fn(() => ({ id: 1 })), recordJournal: o.recordJournal ?? vi.fn(), readJournal: vi.fn(() => []),
    saveMemory: vi.fn(() => ({ id: 'm' })), saveDecision: vi.fn(() => ({ id: 1 })),
    searchMemories: vi.fn(() => []), searchConversations: vi.fn(() => []),
    connectors: { list: () => [], query: async () => ({}) }, agentMode: 'bypass', turnsBudget: 5,
    skillRegistry: undefined, getSecretForDelegate: () => null, costGuard: o.costGuard,
    providerId: o.providerId, model: o.model, fallbackOpts: o.fallbackOpts,
    mcpClientRef: undefined, appendAuditFn: undefined, trackToolPatternFn: undefined,
    parentChatId: null, subSessions: undefined, sessionTodos: undefined,
    agentRuns: o.agentRuns, runId: o.runId, verifications: undefined, toolsAllow: null,
  }
  return [ctx]
}

function mockRuns() {
  return { finish: vi.fn(), appendEvent: vi.fn(), tick: vi.fn(), saveCheckpoint: vi.fn(), clearCheckpoint: vi.fn() }
}

describe('agent-loop (runApiConversation) — харнес', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-loop-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('happy path: plain-ответ → completed, finish("done")', async () => {
    const runs = mockRuns()
    const p = provider('p1', () => [{ type: 'text', text: 'привет' }, { type: 'done' }])
    await runApiConversation(...(args(dir, { provider: p, providerId: 'gemini-api', model: 'gemini-3-flash', costGuard: createCostGuard(100), agentRuns: runs, runId: 'r1' }) as Parameters<typeof runApiConversation>))
    expect(runs.finish).toHaveBeenCalledTimes(1)
    expect(runs.finish).toHaveBeenCalledWith('r1', 'done', expect.anything())
  })

  // Crash-resume Фаза 2: turn с tool-call снапшотит историю (saveCheckpoint),
  // чистое завершение — чистит (clearCheckpoint). Прерванная сессия возобновится
  // с накопленным контекстом, доведённая — нет.
  it('checkpoint: tool-turn сохраняет снапшот истории, completed чистит', async () => {
    const runs = mockRuns()
    const p = provider('p1', (turn) => turn === 1
      ? [{ type: 'tool-call', call: { id: 'c1', name: 'read_file', args: { path: 'foo.txt' } } }, { type: 'done' }]
      : [{ type: 'text', text: 'готово' }, { type: 'done' }])
    await runApiConversation(...(args(dir, { provider: p, providerId: 'gemini-api', model: 'gemini-3-flash', costGuard: createCostGuard(100), agentRuns: runs, runId: 'r1' }) as Parameters<typeof runApiConversation>))
    // turn с tool-call → снапшот сохранён с сериализованной историей (turnIndex=1)
    expect(runs.saveCheckpoint).toHaveBeenCalled()
    const [rid, turnIdx, msgsJson] = runs.saveCheckpoint.mock.calls[0]
    expect(rid).toBe('r1')
    expect(turnIdx).toBe(1)
    expect(Array.isArray(JSON.parse(msgsJson))).toBe(true)   // валидный JSON истории
    // completed → снапшот вычищен
    expect(runs.clearCheckpoint).toHaveBeenCalledWith('r1')
  })

  // #15 + #7: упавший провайдер → fallback успешен. run финализируется как 'done'
  // (не 'failed'/'crashed'), ровно один раз, а cost считается по модели fallback'а.
  it('успешный fallback → finish("done") один раз + cost по модели fallback', async () => {
    const runs = mockRuns()
    const cg = createCostGuard(100)
    const recordSpy = vi.spyOn(cg, 'recordAndCheck')
    const failing = provider('gemini-api', () => [], new Error('503 Service Unavailable'))
    const fallback = provider('claude', () => [
      { type: 'usage', usage: { inputTokens: 1000, outputTokens: 1000, cachedInputTokens: 0 } },
      { type: 'text', text: 'ответ от fallback' },
      { type: 'done' },
    ])
    const fallbackOpts = {
      getNextProvider: (_id: string) => fallback,
      getProviderModel: (_id: string) => 'claude-opus-4-5',
      configuredProviders: new Set(['gemini-api', 'claude']),
      triedProviders: new Set(['gemini-api']),
    }
    await runApiConversation(...(args(dir, {
      provider: failing, providerId: 'gemini-api', model: 'gemini-3-flash',
      costGuard: cg, agentRuns: runs, runId: 'r1', fallbackOpts,
    }) as Parameters<typeof runApiConversation>))

    expect(runs.finish).toHaveBeenCalledTimes(1)
    expect(runs.finish).toHaveBeenCalledWith('r1', 'done', expect.anything()) // #15
    // #7: стоимость записана по модели fallback (claude-opus-4-5), не упавшего gemini-3-flash.
    expect(recordSpy).toHaveBeenCalledWith('claude', 'claude-opus-4-5', 1000, 1000, 0)
  }, 15000)

  // 6.2 (ревью + конкурентный разбор): fallback ПОСЛЕ накопленной работы должен
  // получить currentMessages (с проделанными tool-результатами), а не initialMessages.
  // Иначе downstream-провайдер начинает с нуля → переделывает = повторно пишет файлы.
  it('fallback получает накопленную историю (currentMessages), не исходную (6.2)', async () => {
    const runs = mockRuns()
    // Провайдер A: turn 1 — read_file (накапливает assistant+tool-результат), turn 2 — падает.
    let aTurn = 0
    const failing: ChatProvider = {
      id: 'gemini-api', name: 'gemini-api', models: ['gemini-api'],
      async *send(): AsyncGenerator<ChatEvent> {
        aTurn++
        if (aTurn === 1) {
          yield { type: 'tool-call', call: { id: 'c1', name: 'read_file', args: { path: 'foo.txt' } } }
          yield { type: 'done' }
        } else {
          throw new Error('503 Service Unavailable')
        }
      },
    }
    // Fallback-провайдер каптурит полученную историю.
    let captured: ChatMessage[] | null = null
    const fallback: ChatProvider = {
      id: 'claude', name: 'claude', models: ['claude'],
      async *send(messages: ChatMessage[]): AsyncGenerator<ChatEvent> {
        captured = messages
        yield { type: 'text', text: 'ответ от fallback' }
        yield { type: 'done' }
      },
    }
    const fallbackOpts = {
      getNextProvider: () => fallback,
      getProviderModel: () => 'claude-opus-4-5',
      configuredProviders: new Set(['gemini-api', 'claude']),
      triedProviders: new Set(['gemini-api']),
    }
    await runApiConversation(...(args(dir, {
      provider: failing, providerId: 'gemini-api', model: 'gemini-3-flash',
      costGuard: createCostGuard(100), agentRuns: runs, runId: 'r1', fallbackOpts,
      messages: [{ role: 'user', content: 'сделай' }],
    }) as Parameters<typeof runApiConversation>))

    expect(captured).not.toBeNull()
    // С багом fallback получил бы только [{user:'сделай'}] (длина 1, без assistant).
    expect(captured!.length).toBeGreaterThan(1)
    expect(captured!.some(m => m.role === 'assistant')).toBe(true)
  }, 15000)

  // #12: принятые propose_edits попадают в filesTouched → finish.filesCount > 0.
  it('propose_edits (accepted) → filesTouched учтён в finish', async () => {
    const runs = mockRuns()
    const p = provider('p1', (turn) => turn === 1
      ? [{ type: 'tool-call', call: { id: 'c1', name: 'propose_edits', args: { edits: [{ path: 'a.txt', content: 'hello' }] } } }, { type: 'done' }]
      : [{ type: 'text', text: 'готово' }, { type: 'done' }])
    await runApiConversation(...(args(dir, { provider: p, providerId: 'gemini-api', model: 'gemini-3-flash', costGuard: createCostGuard(100), agentRuns: runs, runId: 'r1' }) as Parameters<typeof runApiConversation>))
    expect(runs.finish).toHaveBeenCalledWith('r1', 'done', expect.objectContaining({ filesCount: 1 }))
  }, 15000)

  // Diagnostic Loop v2: правка .ts → авто check_diagnostics в цикле. В temp-dir нет
  // tsconfig, диагностика возвращается gracefully и цикл доходит до done — тест
  // гарантирует, что хук авто-tsc не роняет agent-loop.
  it('Diagnostic Loop: write_file .ts → авто-диагностика не ломает цикл', async () => {
    const runs = mockRuns()
    const p = provider('p1', (turn) => turn === 1
      ? [{ type: 'tool-call', call: { id: 'w1', name: 'write_file', args: { path: 'a.ts', content: 'export const x = 1\n' } } }, { type: 'done' }]
      : [{ type: 'text', text: 'готово' }, { type: 'done' }])
    await runApiConversation(...(args(dir, { provider: p, providerId: 'gemini-api', model: 'gemini-3-flash', costGuard: createCostGuard(100), agentRuns: runs, runId: 'r1' }) as Parameters<typeof runApiConversation>))
    expect(runs.finish).toHaveBeenCalledWith('r1', 'done', expect.anything())
  }, 20000)

  // #14: supplement, догруженный во время plain-ответа, перезапускает turn и
  // попадает в контекст следующего хода (раньше continue гасил стрим, не turn).
  it('supplement после plain-ответа перезапускает turn и доходит до провайдера', async () => {
    const runs = mockRuns()
    const received: string[] = []
    let turn = 0
    const p: ChatProvider = {
      id: 'p1', name: 'p1', models: ['p1'],
      async *send(messages): AsyncGenerator<ChatEvent> {
        received.push(JSON.stringify(messages))
        turn++
        if (turn === 1) {
          pushConversationSupplement(1, 'СРОЧНАЯ-ДОБАВКА') // инъекция во время хода 1
          yield { type: 'text', text: 'первый ответ' }
          yield { type: 'done' }
          return
        }
        yield { type: 'text', text: 'учёл добавку' }
        yield { type: 'done' }
      },
    }
    await runApiConversation(...(args(dir, { provider: p, providerId: 'gemini-api', model: 'gemini-3-flash', costGuard: createCostGuard(100), agentRuns: runs, runId: 'r1' }) as Parameters<typeof runApiConversation>))

    expect(turn).toBeGreaterThanOrEqual(2)                       // turn перезапустился
    expect(received[1]).toContain('СРОЧНАЯ-ДОБАВКА')             // добавка дошла до хода 2
  }, 15000)

  // v3 Шаг D: max-steps hard-stop. Зацикленный прогон (модель всегда зовёт tool)
  // упирается в turnsBudget=5. На ПОСЛЕДНЕМ turn'е тулзы убраны + инжектится
  // инструкция отчёта — модель не молчит в лимит, а отчитывается структурой.
  it('max-steps hard-stop: на последнем turn тулзы сняты + инжектится отчёт', async () => {
    const runs = mockRuns()
    const captured: Array<{ toolCount: number; hasReport: boolean }> = []
    const p: ChatProvider = {
      id: 'p1', name: 'p1', models: ['p1'],
      async *send(messages: ChatMessage[], tools): AsyncGenerator<ChatEvent> {
        const hasReport = messages.some(m => typeof m.content === 'string' && m.content.includes('ЛИМИТ ШАГОВ'))
        captured.push({ toolCount: (tools as unknown[]).length, hasReport })
        // Всегда зовём tool (РАЗНЫЙ путь — иначе сработает loop-detector) —
        // сами не финишируем, упираемся в turnsBudget.
        yield { type: 'tool-call', call: { id: `c${captured.length}`, name: 'read_file', args: { path: `nope${captured.length}.txt` } } }
        yield { type: 'done' }
      },
    }
    await runApiConversation(...(args(dir, { provider: p, providerId: 'gemini-api', model: 'gemini-3-flash', costGuard: createCostGuard(100), agentRuns: runs, runId: 'r1' }) as Parameters<typeof runApiConversation>))

    expect(captured.length).toBe(5)                    // turnsBudget=5
    expect(captured[0].toolCount).toBeGreaterThan(0)   // обычные turn'ы — с тулзами
    expect(captured[0].hasReport).toBe(false)
    const last = captured[captured.length - 1]
    expect(last.toolCount).toBe(0)                     // последний — без тулзов
    expect(last.hasReport).toBe(true)                  // и с инструкцией отчёта
  }, 15000)

  // Ревью 23.06 (#1): стоп пользователя ВО ВРЕМЯ backoff-retry. sleep() в
  // withInitialRetry бросает Error('aborted'), которая вылетает мимо per-event
  // abort-проверок прямо в внешний catch. Без guard'а это падало в ветку
  // 'crashed' → пользователь видел СТРАШНЫЙ error-тост и run писался 'failed',
  // хотя он сам нажал Стоп. Должно быть: чистый 'aborted' → finish('stopped'),
  // никакого error-события.
  it('stop во время retry-backoff → aborted/stopped, без error-события', async () => {
    const runs = mockRuns()
    const sender = makeSender()
    const ctrl = new AbortController()
    // Retriable-ошибка с Retry-After=10s → backoff заснёт на 10с (не jitter).
    const retryErr = Object.assign(new Error('503 service unavailable'), { retryAfter: 10 })
    const p = provider('p1', () => [], retryErr)
    // Пользователь жмёт Стоп во время сна (через ~20мс, задолго до 10с).
    setTimeout(() => ctrl.abort(), 20)
    await runApiConversation(...(args(dir, {
      provider: p, providerId: 'gemini-api', model: 'gemini-3-flash',
      costGuard: createCostGuard(100), agentRuns: runs, runId: 'r1',
      sender, signal: ctrl.signal,
    }) as Parameters<typeof runApiConversation>))

    // Штатный стоп — НИКАКОГО error-события пользователю.
    const errorEvents = sender.send.mock.calls.filter(
      (c: unknown[]) => (c[1] as { event?: { type?: string } })?.event?.type === 'error'
    )
    expect(errorEvents).toHaveLength(0)
    // Run финализируется как 'stopped' (aborted), не 'failed' (crashed).
    expect(runs.finish).toHaveBeenCalledWith('r1', 'stopped', expect.anything())
  }, 15000)

  // Ревью 23.06 (#3): supervisor-нота при зацикливании БЫЛА мёртвым кодом —
  // пушилась в currentMessages и тут же return, модель её не видела. Должно:
  // нота скармливается модели (шанс сменить подход), и только при повторном
  // зацикливании — hard-stop.
  it('loop-detected: модель получает supervisor-ноту, затем hard-stop', async () => {
    const runs = mockRuns()
    const received: string[] = []
    // Провайдер всегда зовёт ОДИН И ТОТ ЖЕ read_file → детектор зацикливания.
    const p: ChatProvider = {
      id: 'p1', name: 'p1', models: ['p1'],
      async *send(messages: ChatMessage[]): AsyncGenerator<ChatEvent> {
        received.push(JSON.stringify(messages))
        yield { type: 'tool-call', call: { id: `c${received.length}`, name: 'read_file', args: { path: 'same.txt' } } }
        yield { type: 'done' }
      },
    }
    await runApiConversation(...(args(dir, {
      provider: p, providerId: 'gemini-api', model: 'gemini-3-flash',
      costGuard: createCostGuard(100), agentRuns: runs, runId: 'r1',
    }) as Parameters<typeof runApiConversation>))

    // Нота «смените подход» дошла до провайдера (раньше — мёртвый код, никогда).
    expect(received.some(m => m.includes('Смените подход'))).toBe(true)
    // Цикл всё равно завершается штатно (hard-stop после нуджа): loop-detected → done.
    expect(runs.finish).toHaveBeenCalledWith('r1', 'done', expect.anything())
  }, 15000)

  // Ревью 23.06 (F2): writeSessionJournal был выпилен в void-стаб (регрессия
  // 4f94c72) — журнал сессии на завершении НЕ писался, хотя ai.ts гарантирует
  // запись на каждом exit. Сессия с изменением файла обязана оставить
  // 'session'-запись в журнале.
  it('session journal: завершение с изменениями пишет session-запись (F2 восстановление)', async () => {
    const runs = mockRuns()
    const recordJournal = vi.fn()
    const p = provider('p1', (turn) => turn === 1
      ? [{ type: 'tool-call', call: { id: 'w1', name: 'write_file', args: { path: 'note.txt', content: 'hi' } } }, { type: 'done' }]
      : [{ type: 'text', text: 'готово' }, { type: 'done' }])
    await runApiConversation(...(args(dir, {
      provider: p, providerId: 'gemini-api', model: 'gemini-3-flash',
      costGuard: createCostGuard(100), agentRuns: runs, runId: 'r1', recordJournal,
    }) as Parameters<typeof runApiConversation>))

    // Раньше (void-стаб) recordJournal не вызывался ни разу. Теперь — 'session'-запись.
    const sessionCalls = recordJournal.mock.calls.filter((c: unknown[]) => c[1] === 'session')
    expect(sessionCalls.length).toBeGreaterThan(0)
  }, 20000)
})
