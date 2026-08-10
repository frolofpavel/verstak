import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatProvider, ChatEvent } from '../../electron/ai/types'

/**
 * V2-2 (agent-runtime-v2.md §4) — проводка автопродолжения бюджета в живом
 * agent-loop. Модульные пины (tests/ai/auto-continue-turns.test.ts) проверяют
 * ПРАВИЛО; здесь проверяется, что правило действительно управляет циклом:
 * работающий прогон переживает исходный бюджет, а остановившийся — нет.
 *
 * Харнес — сокращённая копия tests/ipc/agent-loop.test.ts (его helpers не
 * экспортируются). Тот харнес не трогаем: 30 его пинов обязаны оставаться
 * зелёными без правок.
 */
vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { getPath: () => tmpdir() } }))

const { runApiConversation } = await import('../../electron/ai/runner-api')
const { createFileTools } = await import('../../electron/ai/tools')
const { DEFAULT_AGENT_TURNS, MAX_AUTO_CONTINUES, AUTO_CONTINUE_STEP } = await import('../../electron/ai/runner-shared')

const START_BUDGET = 5

/** Провайдер, считающий свои вызовы: число вызовов = число реально прожитых ходов. */
function countingProvider(script: (turn: number) => ChatEvent[]): ChatProvider & { calls: () => number } {
  let turn = 0
  return {
    id: 'mock', name: 'mock', models: ['mock'],
    calls: () => turn,
    async *send(): AsyncGenerator<ChatEvent> {
      turn++
      for (const e of script(turn)) yield e
    },
  }
}

const readCall = (id: string, path: string): ChatEvent[] => [
  { type: 'tool-call', call: { id, name: 'read_file', args: { path } } } as ChatEvent,
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

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'auto-continue-'))
  for (let i = 1; i <= 60; i++) writeFileSync(join(dir, `f${i}.txt`), `факт номер ${i}`, 'utf8')
})
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* уборка не критична */ } })

describe('V2-2 автопродолжение бюджета в agent-loop', () => {
  it('прогон, узнающий новое каждый ход, переживает исходный бюджет', async () => {
    // Каждый ход читает НОВЫЙ файл — новый факт, значит продвижение есть.
    const provider = countingProvider(turn => readCall(`c${turn}`, `f${turn}.txt`))
    await runApiConversation(runCtx(dir, provider, true) as never)

    expect(provider.calls()).toBeGreaterThan(START_BUDGET)
    // Продлений ровно столько, сколько разрешено: bounded, а не «пока не надоест».
    expect(provider.calls()).toBe(START_BUDGET + MAX_AUTO_CONTINUES * AUTO_CONTINUE_STEP)
  }, 60_000)

  it('КОНТРОЛЬ: ход без нового факта на границе бюджета продления не даёт', async () => {
    // Три новых файла, затем повтор первого: на границе бюджета продвижения нет,
    // и решение остаётся человеку — прогон честно упирается в исходный бюджет.
    const provider = countingProvider(turn => readCall(`c${turn}`, turn <= 3 ? `f${turn}.txt` : 'f1.txt'))
    await runApiConversation(runCtx(dir, provider, true) as never)

    expect(provider.calls()).toBe(START_BUDGET)
  }, 60_000)

  it('КОНТРОЛЬ: без явного разрешения бюджет не растёт даже при продвижении', async () => {
    // Разрешение даёт только тот, кто знает, что бюджет никто не назначал —
    // чат с дефолтом и облачная задача без лимита. Пайплайны, делегирование и
    // спавн-сессии живут в назначенном им бюджете, и трогать его нельзя.
    const provider = countingProvider(turn => readCall(`c${turn}`, `f${turn}.txt`))
    await runApiConversation(runCtx(dir, provider, false) as never)

    expect(provider.calls()).toBe(START_BUDGET)
  }, 60_000)

  it('дефолт обычного прогона реально поднят — стена наступает позже восьмого хода', () => {
    expect(DEFAULT_AGENT_TURNS).toBeGreaterThan(8)
  })
})
