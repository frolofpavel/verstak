import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatProvider, ChatEvent } from '../../electron/ai/types'

/**
 * Д2 + остаток Д1 — проводка исхода прогона. Правило считает
 * shared/contracts/run-outcome.ts (пины в tests/lib/run-outcome-label.test.ts);
 * здесь проверяется, что финал действительно НЕСЁТ исход в ленту, — иначе
 * правило было бы верным и никем не применённым.
 */
vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { getPath: () => tmpdir() } }))

const { runApiConversation } = await import('../../electron/ai/runner-api')
const { createFileTools } = await import('../../electron/ai/tools')

function textProvider(text: string): ChatProvider {
  return {
    id: 'mock', name: 'mock', models: ['mock'],
    async *send(): AsyncGenerator<ChatEvent> {
      if (text) yield { type: 'text', text } as ChatEvent
      yield { type: 'done' } as ChatEvent
    },
  }
}

function runCtx(dir: string, provider: ChatProvider) {
  const signal = new AbortController().signal
  return {
    sender: { send: vi.fn(), exec: vi.fn(async () => undefined) },
    sendId: 1, provider, tools: createFileTools(dir, signal), projectPath: dir,
    initialMessages: [{ role: 'user' as const, content: 'найди на хабре ai агентов' }], signal,
    recordWrite: vi.fn(), recordPlan: vi.fn(() => ({ id: 1 })), recordJournal: vi.fn(), readJournal: vi.fn(() => []),
    saveMemory: vi.fn(() => ({ id: 'm' })), saveDecision: vi.fn(() => ({ id: 1 })),
    searchMemories: vi.fn(() => []), searchConversations: vi.fn(() => []),
    connectors: { list: () => [], query: async () => ({}) },
    agentMode: 'bypass', turnsBudget: 4, autoContinueTurns: false,
    getSecretForDelegate: () => null, parentChatId: null,
  }
}

/** Исход, приехавший вместе с финалом прогона. */
function doneOutcome(sender: { send: ReturnType<typeof vi.fn> }): string | undefined {
  const done = sender.send.mock.calls
    .map(([, payload]) => (payload as { event?: { type?: string; outcome?: string } })?.event)
    .filter(e => e?.type === 'done')
    .pop()
  return done?.outcome
}

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'run-outcome-')) })
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* уборка не критична */ } })

describe('Д2: финал прогона несёт исход', () => {
  it('агент сам назвал работу неполной → partial уезжает в ленту', async () => {
    const ctx = runCtx(dir, textProvider('Что сделано: открыл сайт.\n\n## Что НЕ доделано\nФорма не отправилась.'))
    await runApiConversation(ctx as never)
    expect(doneOutcome(ctx.sender)).toBe('partial')
  }, 60_000)

  it('ноль вызовов и пустой ответ → no-work (прогон с нулевой работой не «выполнен»)', async () => {
    const ctx = runCtx(dir, textProvider(''))
    await runApiConversation(ctx as never)
    expect(doneOutcome(ctx.sender)).toBe('no-work')
  }, 60_000)

  it('КОНТРОЛЬ: обычный ответ закрывается как completed', async () => {
    const ctx = runCtx(dir, textProvider('Готово: вот пять материалов Хабра по запросу.'))
    await runApiConversation(ctx as never)
    expect(doneOutcome(ctx.sender)).toBe('completed')
  }, 60_000)
})
