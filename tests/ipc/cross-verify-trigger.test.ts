import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatProvider, ChatEvent, ChatMessage } from '../../electron/ai/types'

/**
 * Lock-in триггера cross-verify в agent-loop (runner-api). Распил 1.9.8 #1 срез 4c
 * вынес runApiConversation + fireCrossVerify в runner-api.ts; проводка была байт-в-байт
 * (2 ревьюера подтвердили), но САМ триггер («после completed-хода с изменениями →
 * fireCrossVerify → cross-verify event») до сих пор не покрыт тестом. Если кто-то
 * позже уронит вызов fireCrossVerify в finish-ветке, авто-cross-verify тихо умрёт.
 * Этот тест ловит именно это. Внутренности cross-verify мокаем — они уже покрыты
 * cross-verify.test.ts (8), тут проверяем ТОЛЬКО что цикл дёргает триггер и эмитит событие.
 */
vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { getPath: () => tmpdir() } }))

// Мок внутренностей cross-verify: без сети, канонический результат.
vi.mock('../../electron/ai/cross-verify', () => ({
  getConfiguredApiProviders: () => ['gemini-api', 'claude'],
  pickReviewProvider: () => 'claude',
  buildCrossVerifyPrompt: () => 'prompt',
  runCrossVerify: async () => ({ result: 'выглядит корректно', provider: 'claude', ok: true }),
}))

const { runApiConversation } = await import('../../electron/ai/runner-api')
const { createFileTools } = await import('../../electron/ai/tools')
const { createCostGuard } = await import('../../electron/ai/cost-guard')

function makeSender() { return { send: vi.fn(), exec: vi.fn(async () => undefined) } }
function mockRuns() {
  return { finish: vi.fn(), appendEvent: vi.fn(), tick: vi.fn(), saveCheckpoint: vi.fn(), clearCheckpoint: vi.fn() }
}

/** Минимальный AgentRunContext (зеркалит args() из agent-loop.test, только нужные поля). */
function ctx(dir: string, o: { provider: ChatProvider; sender: ReturnType<typeof makeSender>; getSecretForDelegate?: (k: string) => string | null; messages?: ChatMessage[] }): unknown[] {
  const signal = new AbortController().signal
  return [{
    sender: o.sender, sendId: 1, provider: o.provider, tools: createFileTools(dir, signal), projectPath: dir,
    initialMessages: o.messages ?? [{ role: 'user', content: 'hi' }], signal,
    recordWrite: vi.fn(), recordPlan: vi.fn(() => ({ id: 1 })), recordJournal: vi.fn(), readJournal: vi.fn(() => []),
    saveMemory: vi.fn(() => ({ id: 'm' })), saveDecision: vi.fn(() => ({ id: 1 })),
    searchMemories: vi.fn(() => []), searchConversations: vi.fn(() => []),
    connectors: { list: () => [], query: async () => ({}) }, agentMode: 'bypass', turnsBudget: 5,
    skillRegistry: undefined, getSecretForDelegate: o.getSecretForDelegate ?? (() => null),
    costGuard: createCostGuard(100), providerId: 'gemini-api', model: 'gemini-3-flash', fallbackOpts: undefined,
    mcpClientRef: undefined, appendAuditFn: undefined, trackToolPatternFn: undefined,
    parentChatId: null, subSessions: undefined, sessionTodos: undefined,
    agentRuns: mockRuns(), runId: 'r1', verifications: undefined, toolsAllow: null, processRegistry: undefined,
  }]
}

/** turn1: write_file (→ sessionChange), turn2: done (→ completed → триггер). */
function writeThenDone(): ChatProvider {
  let turn = 0
  return {
    id: 'gemini-api', name: 'gemini-api', models: ['gemini-api'],
    async *send(): AsyncGenerator<ChatEvent> {
      turn++
      if (turn === 1) {
        yield { type: 'tool-call', call: { id: 'c1', name: 'write_file', args: { path: 'foo.txt', content: 'привет' } } }
        yield { type: 'done' }
      } else {
        yield { type: 'text', text: 'готово' }
        yield { type: 'done' }
      }
    },
  }
}

describe('cross-verify триггер в agent-loop (runner-api)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gg-cv-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('completed-ход с изменениями + getSecret → эмитит cross-verify event', async () => {
    const sender = makeSender()
    await runApiConversation(...(ctx(dir, {
      provider: writeThenDone(), sender, getSecretForDelegate: () => 'k',
    }) as Parameters<typeof runApiConversation>))
    // fireCrossVerify — fire-and-forget (void promise), даём микротаскам стечь.
    await vi.waitFor(() => {
      const cv = sender.send.mock.calls.find(c => c[0] === 'ai:event' && (c[1] as { event?: { type?: string } })?.event?.type === 'cross-verify')
      expect(cv).toBeTruthy()
    })
    const cv = sender.send.mock.calls.find(c => c[0] === 'ai:event' && (c[1] as { event?: { type?: string } })?.event?.type === 'cross-verify')!
    const ev = (cv[1] as { event: { type: string; result: string; provider: string; ok: boolean } }).event
    expect(ev).toMatchObject({ result: 'выглядит корректно', provider: 'claude', ok: true })
  })

  it('cross_verify=false → триггер тихо не эмитит событие (off-switch)', async () => {
    const sender = makeSender()
    await runApiConversation(...(ctx(dir, {
      provider: writeThenDone(), sender,
      // fireCrossVerify вызывается, но внутренний гард getSecret('cross_verify')==='false' его гасит.
      getSecretForDelegate: (k) => (k === 'cross_verify' ? 'false' : 'k'),
    }) as Parameters<typeof runApiConversation>))
    await new Promise(r => setTimeout(r, 20))  // дать шанс ложному async-эмиту
    const cv = sender.send.mock.calls.find(c => c[0] === 'ai:event' && (c[1] as { event?: { type?: string } })?.event?.type === 'cross-verify')
    expect(cv).toBeFalsy()
  })
})
