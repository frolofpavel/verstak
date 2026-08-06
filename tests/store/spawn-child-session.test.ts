// Задача 10 (оркестратор): spawnChildSession + settleSpawnCard.
//
// Что здесь стережётся:
//  · дочерняя сессия — ВИДИМАЯ (kind='main' + parentChatId), а не скрытый суб-агент;
//  · seed уходит в СВОЙ дочерний чат (chatId=child), owner прогона зарегистрирован;
//  · карточка-СЛЕД ложится в bundle РОДИТЕЛЯ, а не активного/дочернего;
//  · ВОЗВРАТ РЕЗУЛЬТАТА = обновление карточки (done/error/terminated), а НЕ инъекция
//    ответа ребёнка в контекст родителя (то был бы delegate_task);
//  · НЕСУЩЕЕ: смерть mid-stream (run-finalized, ни done ни error) переводит карточку
//    в «оборвался» и НЕ застревает в «выполняется»; первый терминал побеждает.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const createSpy = vi.fn(async (_path: string, opts: { title?: string; providerId?: string | null; model?: string | null; kind?: string; parentChatId?: number | null }) => ({
  id: 42,
  title: opts.title ?? 'new',
  providerId: opts.providerId ?? null,
  model: opts.model ?? null,
  kind: opts.kind ?? 'main',
  parentChatId: opts.parentChatId ?? null,
}))
const listSpy = vi.fn(async () => [] as Array<{ id: number }>)
let nextSendId = 500
const sendSpy = vi.fn(async (_msgs: unknown, _path: unknown, _ov: unknown, _chatId?: string) => nextSendId)

const windowStub = {
  api: {
    chatSessions: { create: createSpy, list: listSpy, listReviews: vi.fn(async () => []) },
    ai: { sendWithOverrides: sendSpy },
    settings: { setKey: vi.fn(async () => {}), getKey: vi.fn(async () => null) },
    journal: { append: vi.fn(async () => {}) },
  },
}
vi.stubGlobal('window', windowStub)

import { useProject } from '../../src/store/projectStore'
import { freshSnapshot, type SpawnedSessionCard } from '../../src/store/session-snapshot'

function seedParent(parentId: number, cards: SpawnedSessionCard[], activeId = parentId) {
  useProject.setState({
    path: '/proj',
    activeChatId: activeId,
    chatSessions: [{ id: parentId, providerId: 'claude', model: 'opus' }] as never,
    chats: { [parentId]: { ...freshSnapshot(), chatId: parentId, spawnCards: cards } },
    sendOwners: {},
  }, false)
}

beforeEach(() => {
  vi.stubGlobal('window', windowStub)
  nextSendId = 500
  createSpy.mockClear(); listSpy.mockClear(); sendSpy.mockClear()
  useProject.setState({ path: '/proj', activeChatId: null, chatSessions: [], chats: {}, sendOwners: {} }, false)
})

describe('spawnChildSession — видимая дочерняя сессия + карточка-след', () => {
  it('создаёт ребёнка kind=main+parent, шлёт seed в его чат, регистрирует owner, кладёт карточку в родителя', async () => {
    seedParent(5, [])
    const childId = await useProject.getState().spawnChildSession({ parentChatId: 5, title: 'Аудит', seed: 'сделай аудит' })

    expect(childId).toBe(42)
    // Дочерняя сессия — ВИДИМАЯ: kind='main' + parentChatId (⑂ в Sidebar), провайдер/модель от родителя.
    expect(createSpy).toHaveBeenCalledWith('/proj', expect.objectContaining({
      kind: 'main', parentChatId: 5, title: 'Аудит', providerId: 'claude', model: 'opus',
    }))
    // Seed уходит в СВОЙ дочерний чат (chatId=42), overrides пустые.
    expect(sendSpy).toHaveBeenCalledWith([{ role: 'user', content: 'сделай аудит' }], '/proj', {}, '42')
    // Owner прогона привязан к ДОЧЕРНЕМУ чату — стрим пойдёт в chats[42].
    expect(useProject.getState().sendOwners[500]).toMatchObject({ kind: 'chat', chatId: 42, projectPath: '/proj' })
    // Карточка-след — в bundle РОДИТЕЛЯ (5), не ребёнка, со статусом «выполняется» и sendId.
    const card = useProject.getState().chats[5].spawnCards[0]
    expect(card).toMatchObject({ childChatId: 42, title: 'Аудит', status: 'running', sendId: 500 })
    // В дочернем чате карточки-следа быть не должно (след живёт у родителя).
    expect(useProject.getState().chats[42]?.spawnCards ?? []).toHaveLength(0)
  })

  it('провайдер недоступен (sendId<=0) → карточка честно «ошибка», не висит «выполняется»', async () => {
    nextSendId = 0
    seedParent(5, [])
    await useProject.getState().spawnChildSession({ parentChatId: 5, title: 'X', seed: 's' })
    expect(useProject.getState().chats[5].spawnCards[0].status).toBe('error')
    // owner не регистрируется на мёртвый sendId
    expect(Object.keys(useProject.getState().sendOwners)).toHaveLength(0)
  })
})

describe('settleSpawnCard — возврат результата = статус карточки', () => {
  it('done дочернего чата → карточка «готово» (по childChatId)', () => {
    seedParent(5, [{ childChatId: 42, title: 'X', status: 'running', sendId: 500 }])
    useProject.getState().settleSpawnCard({ childChatId: 42 }, 'done')
    expect(useProject.getState().chats[5].spawnCards[0].status).toBe('done')
  })

  it('НЕСУЩЕЕ: run-finalized оборвавшегося прогона (по sendId) → «оборвался», не застряла', () => {
    seedParent(5, [{ childChatId: 42, title: 'X', status: 'running', sendId: 500 }])
    useProject.getState().settleSpawnCard({ sendId: 500 }, 'terminated')
    expect(useProject.getState().chats[5].spawnCards[0].status).toBe('terminated')
  })

  it('КОНТРОЛЬ: без сигнала финализации карточка ОСТАЁТСЯ «выполняется» (доказывает, что unstick делает именно сигнал)', () => {
    seedParent(5, [{ childChatId: 42, title: 'X', status: 'running', sendId: 500 }])
    // Ни одного settleSpawnCard — карточка не должна сама себя перевести.
    expect(useProject.getState().chats[5].spawnCards[0].status).toBe('running')
  })

  it('первый терминал побеждает: run-finalized ПОСЛЕ done не переклеивает «готово» в «оборвался»', () => {
    seedParent(5, [{ childChatId: 42, title: 'X', status: 'done', sendId: 500 }])
    useProject.getState().settleSpawnCard({ sendId: 500 }, 'terminated')
    expect(useProject.getState().chats[5].spawnCards[0].status).toBe('done')
  })

  it('карточка обновляется в bundle РОДИТЕЛЯ, даже когда активен другой чат', () => {
    // Родитель — чат 5, но пользователь смотрит чат 9 (ушёл в другой чат).
    seedParent(5, [{ childChatId: 42, title: 'X', status: 'running', sendId: 500 }], /* activeId */ 9)
    useProject.getState().settleSpawnCard({ childChatId: 42 }, 'done')
    expect(useProject.getState().chats[5].spawnCards[0].status).toBe('done')
  })
})

describe('pushSpawnCard — upsert по childChatId', () => {
  it('повторный push того же ребёнка обновляет карточку на месте, а не плодит вторую', () => {
    seedParent(5, [])
    useProject.getState().pushSpawnCard(5, { childChatId: 42, title: 'X', status: 'running' })
    useProject.getState().pushSpawnCard(5, { childChatId: 42, title: 'X', status: 'running', sendId: 500 })
    const cards = useProject.getState().chats[5].spawnCards
    expect(cards).toHaveLength(1)
    expect(cards[0].sendId).toBe(500)
  })
})
