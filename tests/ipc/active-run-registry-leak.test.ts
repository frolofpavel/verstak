import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatEvent } from '../../electron/ai/types'

/**
 * Хвост ревью 2.0.11-B, находки #5/#7 (high): реестр «чат занят» тёк на раннем выходе.
 *
 * СЦЕНАРИЙ. Чат закреплён за аккаунтом, который потом удалили → ai:send честно
 * останавливается с вопросом («переоткрепите аккаунт») и выходит РАНО, ещё до создания
 * прогона. Этот выход убирал за собой activeAborts, но реестр компакции — нет.
 * Результат: чат числится «занят» ВЕЧНО, кнопка «Свернуть начало разговора» серая до
 * перезапуска приложения, причём человеку никто не объясняет почему.
 *
 * Путь стал достижим ровно после фикса #2 (chatId наконец доезжает до main, а значит
 * и pin-резолв, и регистрация прогона заработали) — то есть мой же фикс его и открыл.
 */

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  app: { getPath: () => tmpdir() },
  BrowserWindow: { fromWebContents: () => null },
}))

vi.mock('../../electron/ai/registry', async importOriginal => {
  const actual = await importOriginal<typeof import('../../electron/ai/registry')>()
  return {
    ...actual,
    createProvider: () => ({
      id: 'claude', name: 'claude', models: ['m'],
      async *send(): AsyncGenerator<ChatEvent> { yield { type: 'text', text: 'ок' } },
    }),
  }
})

const { registerAiIpc } = await import('../../electron/ipc/ai')
const { hasActiveRunForChat } = await import('../../electron/ai/runner-shared')

const dir = mkdtempSync(join(tmpdir(), 'vst-leak-'))
const CHAT = 77

const baseDeps = {
  getSecret: (k: string) => (k === 'anthropic_api_key' ? 'key' : k === 'provider' ? 'claude' : null),
  getProviderId: () => 'claude' as const,
  getProviderModel: () => 'claude-opus-4-8',
  getKnownRoots: () => [dir],
  recordWrite: () => {},
  recentWrites: () => [],
  getAgentMode: () => 'ask' as const,
  getContextSnapshot: () => null,
}

function eventWithDone(): { event: unknown; done: Promise<void> } {
  let resolve!: () => void
  const done = new Promise<void>(r => { resolve = r })
  const event = {
    sender: {
      isDestroyed: () => false,
      send: (_ch: string, payload?: { event?: { type?: string } }) => {
        const t = payload?.event?.type
        if (t === 'done' || t === 'error') resolve()
      },
    },
  }
  return { event, done }
}

beforeEach(() => { handlers.clear() })

describe('реестр «чат занят» не течёт (ревью B #5/#7)', () => {
  // Ключевой сценарий: чат закреплён на удалённый аккаунт → ранний выход.
  it('стоп из-за удалённого закреплённого аккаунта НЕ оставляет чат занятым навсегда', async () => {
    registerAiIpc({
      ...baseDeps,
      resolveSubscriptionAccount: () => ({ unavailable: true }),
    } as unknown as Parameters<typeof registerAiIpc>[0])

    const { event } = eventWithDone()
    const sendId = await handlers.get('ai:send')!(event, [{ role: 'user', content: 'привет' }], dir, undefined, undefined, String(CHAT))

    expect(sendId).toBe(0) // ранний выход, прогон не стартовал
    // Прогона нет — значит и «занятости» быть не должно, иначе сжатие мертво до рестарта.
    expect(hasActiveRunForChat(CHAT)).toBe(false)
  })

  it('обычный прогон освобождает чат после завершения', async () => {
    registerAiIpc(baseDeps as unknown as Parameters<typeof registerAiIpc>[0])

    const { event, done } = eventWithDone()
    await handlers.get('ai:send')!(event, [{ role: 'user', content: 'привет' }], dir, undefined, undefined, String(CHAT + 1))
    await done

    // Ждём именно СОСТОЯНИЕ, а не событие: 'done' летит из runner'а, а снятие регистрации
    // происходит в finally — на пару тиков позже. Проверка сразу после done ловила бы гонку
    // теста, а не дефект кода.
    await vi.waitFor(() => expect(hasActiveRunForChat(CHAT + 1)).toBe(false))
  })
})
