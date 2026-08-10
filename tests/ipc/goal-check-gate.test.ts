import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatProvider, ChatEvent, ChatMessage } from '../../electron/ai/types'

/**
 * Д7 (приёмка браузера 10.08) — гейт «цель закрыта?» на продлении бюджета V2-2.
 *
 * Дефект: правило прогресса продлевало бюджет на ЛЮБОЙ новый факт и не знало
 * признака «цель закрыта» — прогон, уже выдавший финальный ответ, молча жёг
 * деньги до потолка (живой случай: ↑2.4M/$0.67 → ↑3.7M/$1.04 после финала).
 *
 * Починка — на точке продления, потому что это единственное место, где рантайм
 * САМ решает потратить деньги человека. Признак «цель закрыта» не выводится
 * кодом (код видит меньше модели, §3.1) — рантайм спрашивает модель нотой и
 * читает её решение структурно: ответ без вызова инструментов = цель закрыта,
 * прогон завершается; вызовы инструментов = продолжение, и оно ВИДИМО в ленте.
 *
 * Харнес — сокращённая копия tests/ipc/auto-continue-wiring.test.ts (его
 * helpers не экспортируются; тот файл не трогаем — его пины остаются зелёными).
 */
vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { getPath: () => tmpdir() } }))

const { runApiConversation } = await import('../../electron/ai/runner-api')
const { createFileTools } = await import('../../electron/ai/tools')
const { MAX_AUTO_CONTINUES, AUTO_CONTINUE_STEP, buildGoalCheckNote } = await import('../../electron/ai/runner-shared')

const START_BUDGET = 5

/** Провайдер, видящий историю: решает по сообщениям, как ответить на этом ходу. */
function goalAwareProvider(
  script: (turn: number, messages: ChatMessage[]) => ChatEvent[],
): ChatProvider & { calls: () => number; sawNote: () => boolean } {
  let turn = 0
  let sawNote = false
  return {
    id: 'mock', name: 'mock', models: ['mock'],
    calls: () => turn,
    sawNote: () => sawNote,
    async *send(messages: ChatMessage[]): AsyncGenerator<ChatEvent> {
      turn++
      if (messages.some(m => m.role === 'user' && m.content === buildGoalCheckNote())) sawNote = true
      for (const e of script(turn, messages)) yield e
    },
  }
}

const readCall = (id: string, path: string): ChatEvent[] => [
  { type: 'tool-call', call: { id, name: 'read_file', args: { path } } } as ChatEvent,
  { type: 'done' } as ChatEvent,
]

const finalAnswer = (): ChatEvent[] => [
  { type: 'text', text: 'Готово: цель достигнута, вот итог.' } as ChatEvent,
  { type: 'done' } as ChatEvent,
]

function runCtx(dir: string, provider: ChatProvider, autoContinueTurns: boolean) {
  const signal = new AbortController().signal
  return {
    sender: { send: vi.fn(), exec: vi.fn(async () => undefined) },
    sendId: 1, provider, tools: createFileTools(dir, signal), projectPath: dir,
    initialMessages: [{ role: 'user' as const, content: 'иди по шагам' }], signal,
    recordWrite: vi.fn(), recordPlan: vi.fn(() => ({ id: 1 })), recordJournal: vi.fn(), readJournal: vi.fn(() => []),
    saveMemory: vi.fn(() => ({ id: 'm' })), saveDecision: vi.fn(() => ({ id: 1 })),
    searchMemories: vi.fn(() => []), searchConversations: vi.fn(() => []),
    connectors: { list: () => [], query: async () => ({}) },
    agentMode: 'bypass', turnsBudget: START_BUDGET, autoContinueTurns,
    getSecretForDelegate: () => null, parentChatId: null,
  }
}

/** Все info-сообщения, отправленные в ленту прогона. */
function infoMessages(sender: { send: ReturnType<typeof vi.fn> }): string[] {
  return sender.send.mock.calls
    .map(([, payload]) => (payload as { event?: { type?: string; message?: string } })?.event)
    .filter((e): e is { type: string; message: string } => e?.type === 'info' && typeof e.message === 'string')
    .map(e => e.message)
}

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'goal-check-'))
  for (let i = 1; i <= 60; i++) writeFileSync(join(dir, `f${i}.txt`), `факт номер ${i}`, 'utf8')
})
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* уборка не критична */ } })

describe('Д7: гейт «цель закрыта?» на продлении бюджета', () => {
  it('прогон, чья цель закрыта, останавливается на гейте — а не едет до потолка', async () => {
    // Модель работает с продвижением; на ноте гейта отвечает финалом без
    // инструментов. До фикса ноты не существовало — прогон ехал до потолка
    // (START_BUDGET + 3×8 = 29 вызовов) и жёг деньги после выданного ответа.
    const provider = goalAwareProvider((turn, messages) =>
      messages.some(m => m.role === 'user' && m.content === buildGoalCheckNote())
        ? finalAnswer()
        : readCall(`c${turn}`, `f${turn}.txt`))
    const ctx = runCtx(dir, provider, true)
    await runApiConversation(ctx as never)

    expect(provider.sawNote()).toBe(true)
    // Гейт стоит на первом ходу продления: ход с нотой и есть последний.
    expect(provider.calls()).toBe(START_BUDGET)
    // Человеку видно, что рантайм спросил агента, а не молча продлил.
    expect(infoMessages(ctx.sender).some(m => m.includes('закрыта ли цель'))).toBe(true)
  }, 60_000)

  it('КОНТРОЛЬ: законное продолжение не душится — и оно ВИДИМО в ленте', async () => {
    // Модель на гейте продолжает звать инструменты (нашла ошибку в своём же
    // результате). Продление обязано состояться в полном объёме V2-2 — и лента
    // обязана показать, что продолжение выбрал агент, а не тихий рантайм.
    const provider = goalAwareProvider(turn => readCall(`c${turn}`, `f${turn}.txt`))
    const ctx = runCtx(dir, provider, true)
    await runApiConversation(ctx as never)

    expect(provider.sawNote()).toBe(true)
    expect(provider.calls()).toBe(START_BUDGET + MAX_AUTO_CONTINUES * AUTO_CONTINUE_STEP)
    expect(infoMessages(ctx.sender).some(m => m.includes('Агент продолжает'))).toBe(true)
  }, 60_000)

  it('КОНТРОЛЬ: без разрешения автопродления гейт не появляется вовсе', async () => {
    // Пайплайны, делегирование и спавн-сессии живут в назначенном бюджете:
    // им рантайм ни ноты не шлёт, ни бюджета не растит — как и раньше.
    const provider = goalAwareProvider(turn => readCall(`c${turn}`, `f${turn}.txt`))
    const ctx = runCtx(dir, provider, false)
    await runApiConversation(ctx as never)

    expect(provider.sawNote()).toBe(false)
    expect(provider.calls()).toBe(START_BUDGET)
  }, 60_000)
})

describe('нота гейта — контракт текста', () => {
  it('нота требует остановки при закрытой цели и разрешает продолжение при найденной ошибке', () => {
    const note = buildGoalCheckNote()
    // Обе ветви решения названы прямо: остановка без инструментов и продолжение
    // с объяснением остатка. Вторая ветвь — контрольный кейс постановки Д7.
    expect(note).toContain('без вызова инструментов')
    expect(note).toContain('ошибку в собственном результате')
  })
})
