import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatProvider, ChatEvent } from '../../electron/ai/types'

/**
 * Д4 (приёмка браузера 10.08) — проводка правила безаргументной подписи в живой
 * agent-loop. Модульные пины (tests/ai/loop-detect-argless.test.ts) проверяют
 * ПРАВИЛО; здесь — что оно действительно управляет детектором зацикливания:
 * снимок другой страницы доходит до исполнения, снимок неизменной — нет.
 *
 * Фикстура намеренно продовой формы (§3.1): вызов идёт через тот же
 * browserHandler и тот же ctx.sender.exec, что в приложении, а не через
 * выдуманный инструмент — иначе пин стерёг бы форму, которой в проде нет.
 *
 * Харнес — сокращённая копия tests/ipc/auto-continue-wiring.test.ts (его helpers
 * не экспортируются; тот файл не трогаем).
 */
vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { getPath: () => tmpdir() } }))

const { runApiConversation } = await import('../../electron/ai/runner-api')
const { createFileTools } = await import('../../electron/ai/tools')

const BUDGET = 6

function snapshotProvider(): ChatProvider & { calls: () => number } {
  let turn = 0
  return {
    id: 'mock', name: 'mock', models: ['mock'],
    calls: () => turn,
    async *send(): AsyncGenerator<ChatEvent> {
      turn++
      yield { type: 'tool-call', call: { id: `c${turn}`, name: 'browser_snapshot', args: {} } } as ChatEvent
      yield { type: 'done' } as ChatEvent
    },
  }
}

/** Контекст прогона; exec подставляет ответ «страницы» на каждый снимок. */
function runCtx(dir: string, provider: ChatProvider, exec: () => unknown) {
  const signal = new AbortController().signal
  return {
    sender: { send: vi.fn(), exec: vi.fn(async () => exec()) },
    sendId: 1, provider, tools: createFileTools(dir, signal), projectPath: dir,
    initialMessages: [{ role: 'user' as const, content: 'посмотри страницы' }], signal,
    recordWrite: vi.fn(), recordPlan: vi.fn(() => ({ id: 1 })), recordJournal: vi.fn(), readJournal: vi.fn(() => []),
    saveMemory: vi.fn(() => ({ id: 'm' })), saveDecision: vi.fn(() => ({ id: 1 })),
    searchMemories: vi.fn(() => []), searchConversations: vi.fn(() => []),
    connectors: { list: () => [], query: async () => ({}) },
    agentMode: 'bypass', turnsBudget: BUDGET, autoContinueTurns: false,
    getSecretForDelegate: () => null, parentChatId: null,
  }
}

/** Сколько раз детектор зацикливания заблокировал снимок. */
function loopBlocks(sender: { send: ReturnType<typeof vi.fn> }): number {
  return sender.send.mock.calls
    .map(([, payload]) => (payload as { event?: { type?: string; name?: string; reason?: string } })?.event)
    .filter(e => e?.type === 'tool-blocked' && e.name === 'browser_snapshot' && /Зацикливание/.test(String(e.reason)))
    .length
}

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'loop-detect-')) })
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* уборка не критична */ } })

describe('Д4 в живом цикле: безаргументный снимок различается наблюдением', () => {
  it('снимки РАЗНЫХ страниц не блокируются — дефект приёмки закрыт', async () => {
    // До фикса третий снимок за прогон блокировался всегда: подпись «имя +
    // аргументы» у browser_snapshot константна, аргументов у него нет.
    let page = 0
    const provider = snapshotProvider()
    const ctx = runCtx(dir, provider, () => {
      page++
      return { url: `https://habr.com/page-${page}`, title: `Страница ${page}`, gen: `g${page}`, count: page, elements: [] }
    })

    await runApiConversation(ctx as never)

    expect(loopBlocks(ctx.sender), 'снимок другой страницы заблокирован').toBe(0)
    expect(provider.calls()).toBe(BUDGET)
  }, 60_000)

  it('КОНТРОЛЬНЫЙ КЕЙС: три снимка ОДНОЙ неизменной страницы по-прежнему ловятся', async () => {
    // Обязателен по §3.1: пин «снимки больше не блокируются» зелен и тогда,
    // когда детектор сломан целиком. Здесь он обязан сработать.
    const provider = snapshotProvider()
    const ctx = runCtx(dir, provider, () => (
      { url: 'https://habr.com/', title: 'Хабр', gen: 'g1', count: 40, elements: [] }
    ))

    await runApiConversation(ctx as never)

    expect(loopBlocks(ctx.sender), 'топтание на одной странице не поймано').toBeGreaterThan(0)
  }, 60_000)
})
