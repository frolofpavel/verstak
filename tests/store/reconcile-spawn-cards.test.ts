// Реконсиляция карточек-следов из ПРАВДЫ БД (страховка от недоставки терминала).
//
// Дефект, который это чинит: осадка карточки-следа держится на доставке
// done/error/run-finalized в renderer (ai.onEvent). Если подписка их пропустила
// (полный размонтаж Chat при смене проекта и т.п.), карточка вечно висит
// «выполняется», хотя дочерний прогон в БД давно терминален. Реконсиляция при
// входе в родительский чат сверяет agentRuns и осаживает зависшие.
//
// Событийный путь (settleSpawnCard по ai.onEvent) остаётся ПЕРВИЧНЫМ — покрыт
// tests/store/spawn-child-session.test.ts и tests/components/spawn-session-card.test.ts.
// Здесь — второй рубеж и его КОНТРОЛЬ: живой прогон карточку НЕ гасит.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const listRunsSpy = vi.fn(async (_p: string, _o?: unknown) => [] as Array<{ chatId: number | null; status: string }>)
const journalSpy = vi.fn(async (_p: string, _k: string, _t: string, _d?: string | null) => ({}))

const windowStub = {
  api: {
    agentRuns: { list: listRunsSpy },
    journal: { append: journalSpy },
    chatSessions: { list: vi.fn(async () => []), listReviews: vi.fn(async () => []) },
    settings: { setKey: vi.fn(async () => {}), getKey: vi.fn(async () => null) },
  },
}
vi.stubGlobal('window', windowStub)

import { useProject } from '../../src/store/projectStore'
import { freshSnapshot, type SpawnedSessionCard } from '../../src/store/session-snapshot'

function seedParent(parentId: number, cards: SpawnedSessionCard[]) {
  useProject.setState({
    path: '/proj',
    activeChatId: parentId,
    chats: { [parentId]: { ...freshSnapshot(), chatId: parentId, spawnCards: cards } },
  }, false)
}

beforeEach(() => {
  vi.stubGlobal('window', windowStub)
  listRunsSpy.mockClear()
  listRunsSpy.mockResolvedValue([])
  journalSpy.mockClear()
  useProject.setState({ path: '/proj', activeChatId: null, chats: {} }, false)
})

describe('reconcileSpawnCards — страховка от недоставки терминала', () => {
  it('зависшая карточка + дочерний прогон ТЕРМИНАЛЕН в БД → осаживается (done)', async () => {
    seedParent(5, [{ childChatId: 42, title: 'Аудит', status: 'running', sendId: 500 }])
    listRunsSpy.mockResolvedValue([{ chatId: 42, status: 'done' }])
    await useProject.getState().reconcileSpawnCards(5)
    expect(useProject.getState().chats[5].spawnCards[0].status).toBe('done')
  })

  it('КОНТРОЛЬ: дочерний прогон РЕАЛЬНО идёт (running) → карточка ОСТАЁТСЯ «выполняется»', async () => {
    seedParent(5, [{ childChatId: 42, title: 'Аудит', status: 'running', sendId: 500 }])
    listRunsSpy.mockResolvedValue([{ chatId: 42, status: 'running' }])
    await useProject.getState().reconcileSpawnCards(5)
    expect(useProject.getState().chats[5].spawnCards[0].status).toBe('running')
  })

  it('КОНТРОЛЬ 2: терминальный И активный прогон в одном дочернем чате (человек дослал) → НЕ осаживаем', async () => {
    // Оригинальный спавн done, но пользователь открыл дочерний чат и запустил новый —
    // «выполняется» всё ещё правда, живую индикацию гасить нельзя.
    seedParent(5, [{ childChatId: 42, title: 'Аудит', status: 'running', sendId: 500 }])
    listRunsSpy.mockResolvedValue([{ chatId: 42, status: 'done' }, { chatId: 42, status: 'running' }])
    await useProject.getState().reconcileSpawnCards(5)
    expect(useProject.getState().chats[5].spawnCards[0].status).toBe('running')
  })

  it('failed → error, stopped/timed_out/interrupted → terminated', async () => {
    seedParent(5, [
      { childChatId: 1, title: 'a', status: 'running', sendId: 501 },
      { childChatId: 2, title: 'b', status: 'running', sendId: 502 },
      { childChatId: 3, title: 'c', status: 'running', sendId: 503 },
    ])
    listRunsSpy.mockResolvedValue([
      { chatId: 1, status: 'failed' },
      { chatId: 2, status: 'stopped' },
      { chatId: 3, status: 'timed_out' },
    ])
    await useProject.getState().reconcileSpawnCards(5)
    const byChild = Object.fromEntries(useProject.getState().chats[5].spawnCards.map(c => [c.childChatId, c.status]))
    expect(byChild).toEqual({ 1: 'error', 2: 'terminated', 3: 'terminated' })
  })

  it('дочернего прогона в БД нет вовсе (ещё не стартовал / вне окна) → карточка не трогается', async () => {
    seedParent(5, [{ childChatId: 42, title: 'Аудит', status: 'running', sendId: 500 }])
    listRunsSpy.mockResolvedValue([{ chatId: 99, status: 'done' }]) // другой чат
    await useProject.getState().reconcileSpawnCards(5)
    expect(useProject.getState().chats[5].spawnCards[0].status).toBe('running')
  })

  it('уже осаженную карточку (done) реконсиляция не переклеивает — трогает только running', async () => {
    seedParent(5, [{ childChatId: 42, title: 'Аудит', status: 'done', sendId: 500 }])
    listRunsSpy.mockResolvedValue([{ chatId: 42, status: 'stopped' }])
    await useProject.getState().reconcileSpawnCards(5)
    expect(useProject.getState().chats[5].spawnCards[0].status).toBe('done')
    // Нет бегущих карточек → БД даже не опрашиваем.
    expect(listRunsSpy).not.toHaveBeenCalled()
  })

  it('БД недоступна (list бросает) → молча выходим, карточка остаётся running', async () => {
    seedParent(5, [{ childChatId: 42, title: 'Аудит', status: 'running', sendId: 500 }])
    listRunsSpy.mockRejectedValue(new Error('db down'))
    await useProject.getState().reconcileSpawnCards(5)
    expect(useProject.getState().chats[5].spawnCards[0].status).toBe('running')
  })
})

// СЛЕД (правило «у фолбэка обязан быть видимый след»): реконсиляция, реально осадившая
// карточку, ОБЯЗАНА оставить запись в журнале — иначе системная поломка доставки событий
// станет неотличима от нормы (тихое доосаживание при каждом входе). При 0 — молчит.
describe('reconcileSpawnCards — видимый след при фактической осадке', () => {
  it('осадила карточку → пишет запись в журнал прогона (факт недоставки)', async () => {
    seedParent(5, [{ childChatId: 42, title: 'Аудит', status: 'running', sendId: 500 }])
    listRunsSpy.mockResolvedValue([{ chatId: 42, status: 'done' }])
    await useProject.getState().reconcileSpawnCards(5)
    expect(journalSpy).toHaveBeenCalledTimes(1)
    expect(journalSpy.mock.calls[0][0]).toBe('/proj')
    expect(String(journalSpy.mock.calls[0][2])).toContain('сверк')
  })

  it('НИЧЕГО не осадила (прогон идёт) → журнал МОЛЧИТ (не засоряем на каждом входе)', async () => {
    seedParent(5, [{ childChatId: 42, title: 'Аудит', status: 'running', sendId: 500 }])
    listRunsSpy.mockResolvedValue([{ chatId: 42, status: 'running' }])
    await useProject.getState().reconcileSpawnCards(5)
    expect(journalSpy).not.toHaveBeenCalled()
  })
})
