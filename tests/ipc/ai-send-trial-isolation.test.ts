// P1 шаг 1 (запуск попыток состязания): прогон попытки обязан работать в ЕЁ workspace.
//
// Два утверждения, добытые постановкой «попытки не делят состояние»:
//  1. cwd провайдера следует за изолированным корнем чата. Раньше isolatedRoot
//     (worktree изолированного чата) доезжал только до file-тулзов API-пути, а сам
//     провайдер создавался с cwd = основное дерево. Для CLI-исполнителя cwd — это
//     рабочий каталог его собственного агента: два CLI-участника состязания писали бы
//     в один каталог человека и затирали друг друга.
//  2. invokeAiSend (main-путь запуска попытки) принимает isolatedRoot ЯВНЫМ внутренним
//     параметром, а IPC-регистрация его НЕ форвардит: renderer не может подсунуть
//     произвольный корень мимо гейта известных проектов.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatEvent, ChatMessage } from '../../electron/ai/types'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  app: { getPath: () => tmpdir() },
  BrowserWindow: { fromWebContents: () => null },
}))

/** Ловушка аргументов createProvider — сюда доезжает cwd прогона. */
let providerOpts: Record<string, unknown> | null = null
vi.mock('../../electron/ai/registry', async importOriginal => {
  const actual = await importOriginal<typeof import('../../electron/ai/registry')>()
  return {
    ...actual,
    createProvider: (_id: string, opts: Record<string, unknown>) => {
      providerOpts = opts
      return {
        id: 'claude-cli', name: 'claude-cli', models: ['auto'],
        async *send(): AsyncGenerator<ChatEvent> {
          yield { type: 'text', text: 'готово' }
          yield { type: 'done' }
        },
      }
    },
  }
})

const { registerAiIpc } = await import('../../electron/ipc/ai')

const messages: ChatMessage[] = [{ role: 'user', content: 'сделай' }]

describe('ai:send — изоляция прогона попытки (P1 шаг 1)', () => {
  let dir: string
  let isolated: string
  let agentRuns: { create: ReturnType<typeof vi.fn>; appendEvent: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn>; persistUsage: ReturnType<typeof vi.fn>; tick: ReturnType<typeof vi.fn> }
  let registered: ReturnType<typeof registerAiIpc>

  const fakeSender = () => ({
    isDestroyed: () => false,
    send: () => {},
  }) as unknown as Electron.WebContents

  function makeDeps() {
    return {
      getSecret: (k: string) => (k === 'claude_code_oauth_token' ? 'sk-legacy' : null),
      getProviderId: () => 'claude-cli' as const,
      getProviderModel: () => 'auto',
      getKnownRoots: () => [dir],
      recordWrite: () => {},
      recentWrites: () => [],
      getAgentMode: () => 'ask' as const,
      recordPlan: () => ({ id: 1 }),
      recordJournal: () => {},
      readJournal: () => [],
      saveMemory: () => ({ id: 'm' }),
      saveDecision: (r: unknown) => r,
      searchMemories: () => [],
      searchConversations: () => [],
      agentRuns,
      worktreeSessions: {
        // Изолированный worktree ЕСТЬ только у чата 7 — контрольный чат без него.
        activePath: (chatId: number) => (chatId === 7 ? isolated : null),
      },
    } as unknown as Parameters<typeof registerAiIpc>[0]
  }

  async function sendOnce(chatId: string, ...extra: unknown[]) {
    return handlers.get('ai:send')!(
      { sender: fakeSender() }, messages, dir, undefined, undefined, chatId, ...extra
    ) as Promise<number>
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gg-trial-iso-'))
    isolated = join(dir, 'wt')
    mkdirSync(isolated)
    providerOpts = null
    agentRuns = { create: vi.fn(() => 0), appendEvent: vi.fn(), get: vi.fn(() => null), finish: vi.fn(), persistUsage: vi.fn(), tick: vi.fn() }
    handlers.clear()
    registered = registerAiIpc(makeDeps())
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('изолированный чат: провайдер создаётся с cwd = worktree, а не основное дерево', async () => {
    const sendId = await sendOnce('7')
    expect(sendId).toBeGreaterThan(0)
    expect(providerOpts).toBeTruthy()
    expect(providerOpts!.cwd, 'CLI-исполнитель работал бы в дереве человека — изоляция фиктивна').toBe(isolated)
  })

  it('КОНТРОЛЬ: чат без изоляции — cwd остаётся основным деревом проекта', async () => {
    const sendId = await sendOnce('8')
    expect(sendId).toBeGreaterThan(0)
    expect(providerOpts!.cwd).toBe(dir)
  })

  it('invokeAiSend: internal.isolatedRoot ведёт прогон попытки на её workspace', async () => {
    expect(registered, 'registerAiIpc обязан вернуть invokeAiSend для main-запуска попыток').toBeTruthy()
    const sendId = await registered.invokeAiSend(
      fakeSender(), messages, dir, undefined,
      { providerId: 'claude-cli', model: 'auto', agentMode: 'auto' },
      '9',
      { isolatedRoot: isolated },
    )
    expect(sendId).toBeGreaterThan(0)
    expect(providerOpts!.cwd).toBe(isolated)
    // Прогон попытки — обычная строка agent_runs своего чата (таблица читает факт оттуда).
    expect(agentRuns.create).toHaveBeenCalledTimes(1)
    expect(agentRuns.create.mock.calls[0][0]).toMatchObject({ chatId: 9 })
  })

  it('renderer НЕ может подсунуть isolatedRoot седьмым аргументом IPC (гейт корней не обходится)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'gg-evil-'))
    try {
      const sendId = await sendOnce('8', { isolatedRoot: outside })
      expect(sendId).toBeGreaterThan(0)
      expect(providerOpts!.cwd, 'седьмой аргумент из renderer обязан игнорироваться').toBe(dir)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
