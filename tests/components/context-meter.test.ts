// @vitest-environment jsdom
//
// Срез 2.0.11-B: сжатие контекста получает интерфейс.
//
// Зачем живой компонент, если тексты и доступность уже покрыты (tests/lib/context-meter):
// ровно потому, что фича без работающей кнопки — полая. Здесь проверяется проводка:
// читает состояние, зовёт сжатие нужного чата, честно показывает осечку и НЕ падает на ней.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react'
import { makeApiMock, CHAT_API_DEFAULTS, type ApiMock } from './helpers/window-api-mock'

const { useProject } = await import('../../src/store/projectStore')
const { ContextMeter } = await import('../../src/components/ContextMeter')

const state = (over: Record<string, unknown> = {}) => ({
  totalMessages: 20, estimatedTokens: 5000, compacted: false,
  compactedThroughMessageId: null, canCompact: true, busy: false, ...over,
})

let api: ApiMock

function mount(contextState: unknown, compact?: () => Promise<unknown>, path: string | null = 'C:/proj') {
  api = makeApiMock({
    ...CHAT_API_DEFAULTS,
    context: {
      state: async () => contextState,
      compact: compact ?? (async () => ({ ok: true, compactedCount: 14, keptCount: 6, snapshot: { summary: 'итог' } })),
    },
  })
  ;(globalThis as { window?: unknown }).window = Object.assign(globalThis.window ?? {}, { api: api.api })
  useProject.setState({ path, activeChatId: 7, isStreaming: false })
  return render(createElement(ContextMeter))
}

/** Кнопка сжатия (в компоненте она единственная). */
const button = async (): Promise<HTMLButtonElement> => (await screen.findByRole('button')) as HTMLButtonElement

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup() })

describe('ContextMeter — проводка', () => {
  it('длинный разговор → кнопка активна', async () => {
    mount(state())
    await waitFor(async () => expect((await button()).disabled).toBe(false))
  })

  // Сжать под работающей моделью = увести историю у неё из-под ног на полуслове.
  it('идёт ответ → кнопка заблокирована и сказано почему', async () => {
    mount(state({ busy: true }))
    await waitFor(async () => expect((await button()).disabled).toBe(true))
    expect((await button()).textContent).toContain('Дождись')
  })

  it('короткий разговор → кнопка заблокирована', async () => {
    mount(state({ canCompact: false }))
    await waitFor(async () => expect((await button()).disabled).toBe(true))
  })

  it('нажатие зовёт сжатие ИМЕННО этого чата', async () => {
    mount(state())
    await waitFor(async () => expect((await button()).disabled).toBe(false))
    fireEvent.click(await button())
    await waitFor(() => expect(api.calls.get('context.compact')).toBeDefined())
    expect(api.calls.get('context.compact')!.mock.calls[0]).toEqual([7])
  })

  it('успех → человеку сказано, что переписка цела', async () => {
    mount(state())
    await waitFor(async () => expect((await button()).disabled).toBe(false))
    fireEvent.click(await button())
    const note = await screen.findByRole('status')
    expect(note.textContent).toMatch(/видно целиком|14/)
  })

  // Осечка — не ошибка приложения: контекст цел, человек видит причину.
  it('осечка → показана причина, интерфейс жив', async () => {
    mount(state(), async () => ({ ok: false, reason: 'busy', detail: 'идёт ответ — дождитесь окончания' }))
    await waitFor(async () => expect((await button()).disabled).toBe(false))
    fireEvent.click(await button())
    const note = await screen.findByRole('status')
    expect(note.textContent).toContain('дождитесь')
  })

  it('падение вызова не роняет компонент', async () => {
    mount(state(), async () => { throw new Error('IPC умер') })
    await waitFor(async () => expect((await button()).disabled).toBe(false))
    fireEvent.click(await button())
    const note = await screen.findByRole('status')
    expect(note.textContent).toContain('IPC умер')
  })

  it('нет проекта → зовёт открыть проект, а не молчит', async () => {
    mount(state(), undefined, null)
    expect(screen.getByText(/Открой проект/)).toBeTruthy()
  })
})
