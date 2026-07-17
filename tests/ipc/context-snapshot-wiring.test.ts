import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatEvent, ChatMessage } from '../../electron/ai/types'

/**
 * Срез 2.0.11-B: ПРОВОДКА снапшота в ai:send.
 *
 * Зачем отдельный тест. prepareHistoryForModel покрыт своими тестами, но сам по себе он
 * ничего не решает: если ai:send его не зовёт (или зовёт не над теми сообщениями),
 * компакция записывается в БД и не влияет ни на что — модель по-прежнему получает всю
 * простыню. Это ровно класс «полой фичи»: снапшот есть, эффекта нет.
 *
 * Поэтому проверяем ФАКТ: что реально доехало до провайдера.
 *
 * ipcMain мокаем и перехватываем зарегистрированные хендлеры; createProvider — мокаем,
 * чтобы поймать messages на входе модели.
 */

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  app: { getPath: () => tmpdir() },
  BrowserWindow: { fromWebContents: () => null },
}))

/** Ловушка входа модели: сюда попадают messages, которые ai:send отдал провайдеру. */
let seenMessages: ChatMessage[] = []
vi.mock('../../electron/ai/registry', async importOriginal => {
  const actual = await importOriginal<typeof import('../../electron/ai/registry')>()
  return {
    ...actual,
    createProvider: () => ({
      id: 'claude', name: 'claude', models: ['m'],
      async *send(messages: ChatMessage[]): AsyncGenerator<ChatEvent> {
        seenMessages = messages
        yield { type: 'text', text: 'ок' }
      },
    }),
  }
})

const { registerAiIpc } = await import('../../electron/ipc/ai')

const dir = mkdtempSync(join(tmpdir(), 'vst-wiring-'))

/** Минимальные deps: нас интересует только сборка истории. */
const makeDeps = (snapshot: { summary: string; throughMessageId: number } | null) => ({
  getSecret: (k: string) => (k === 'anthropic_api_key' ? 'key' : k === 'provider' ? 'claude' : null),
  getProviderId: () => 'claude' as const,
  getProviderModel: () => 'claude-opus-4-8',
  getKnownRoots: () => [dir],
  recordWrite: () => {},
  recentWrites: () => [],
  getAgentMode: () => 'ask' as const,
  getContextSnapshot: () => snapshot,
})

/**
 * ai:send возвращает sendId сразу, а прогон идёт в фоне и рапортует событиями. Поэтому
 * ждём именно 'done'/'error' — иначе проверяли бы пустоту сразу после старта.
 */
function eventWithDone(): { event: unknown; done: Promise<void> } {
  let resolve!: () => void
  const done = new Promise<void>(r => { resolve = r })
  const event = {
    sender: {
      isDestroyed: () => false,
      // Форма ai:event — { id, event }, а не голое событие.
      send: (_ch: string, payload?: { event?: { type?: string } }) => {
        const t = payload?.event?.type
        if (t === 'done' || t === 'error') resolve()
      },
    },
  }
  return { event, done }
}

const history: ChatMessage[] = [
  { role: 'user', content: 'первое', dbId: 1 },
  { role: 'assistant', content: 'ответ на первое', dbId: 2 },
  { role: 'user', content: 'свежий вопрос', dbId: 3 },
]

beforeEach(() => {
  seenMessages = []
  handlers.clear()
})

describe('проводка снапшота компакции в ai:send', () => {
  it('снапшота нет → модель получает историю целиком (поведение прежнее)', async () => {
    registerAiIpc(makeDeps(null) as unknown as Parameters<typeof registerAiIpc>[0])
    const { event, done } = eventWithDone()
    await handlers.get('ai:send')!(event, history, dir, undefined, undefined, '7')
    await done

    const texts = seenMessages.map(m => m.content).join('\n')
    expect(texts).toContain('первое')
    expect(texts).toContain('ответ на первое')
    expect(texts).toContain('свежий вопрос')
  })

  // Главное: снапшот обязан ДОЙТИ до запроса, иначе сжатие — фикция.
  it('снапшот есть → модель получает summary вместо сжатого начала', async () => {
    registerAiIpc(makeDeps({ summary: 'обсудили первое', throughMessageId: 2 }) as unknown as Parameters<typeof registerAiIpc>[0])
    const { event, done } = eventWithDone()
    await handlers.get('ai:send')!(event, history, dir, undefined, undefined, '7')
    await done

    const texts = seenMessages.map(m => m.content).join('\n')
    expect(texts).toContain('обсудили первое')      // итог доехал
    expect(texts).not.toContain('ответ на первое')  // сжатое НЕ дублируется
    expect(texts).toContain('свежий вопрос')        // хвост на месте
  })
})
