import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Срез 2.0.11-D: правка сообщения строго через Fork (store-проводка).
 *
 * Инварианты карточки, которые здесь и проверяются:
 *  1. Оригинал byte-for-byte неизменен — правка идёт в ветку, source не трогаем.
 *  2. Черновик не теряется — отредактированный текст кладётся в composerDraft ветки и НЕ
 *     отправляется автоматически (сбой отправки не рушит правку).
 *  3. Активный стрим оригинала не трогается — правим ПРОШЛОЕ сообщение; sendOwner
 *     оригинала остаётся жив (в отличие от forkChat, editViaFork не запрещён при стриме).
 */

const forkSpy = vi.fn(async (_sourceId: number, _opts?: { uptoMessageId?: number }) => ({
  id: 100, projectPath: '/p', title: 'ветка', providerId: 'claude', model: 'm',
  createdAt: 1, lastMessageAt: 1, kind: 'main' as const, parentChatId: 7,
  subscriptionAccountId: null, subscriptionMode: 'auto' as const,
}))
const listSpy = vi.fn(async () => [] as unknown[])

const windowStub = {
  api: {
    chats: { listWindow: vi.fn(async () => ({ messages: [], totalCount: 0, hasMoreBefore: false })), append: vi.fn(async () => {}) },
    chatSessions: { fork: forkSpy, list: listSpy },
    agentRuns: { list: vi.fn(async () => []) },
  },
}
vi.stubGlobal('window', windowStub)

const { useProject } = await import('../../src/store/projectStore')
const { projectChatDraftKey } = await import('../../src/lib/composer-drafts')
import type { ChatMessage } from '../../src/types/api'

const m = (dbId: number, role: 'user' | 'assistant', content: string): ChatMessage => ({ role, content, dbId })
const HISTORY: ChatMessage[] = [
  m(1, 'user', 'первый вопрос'),
  m(2, 'assistant', 'первый ответ'),
  m(3, 'user', 'второй вопрос'),
]

beforeEach(() => {
  vi.stubGlobal('window', windowStub)
  forkSpy.mockClear()
  listSpy.mockClear()
  useProject.setState({
    path: '/p', activeChatId: 7, messages: HISTORY, isStreaming: false,
    sendOwners: {}, chatSnapshots: {}, chatSessions: [], composerDrafts: {},
  }, false)
})
afterEach(() => { vi.clearAllMocks() })

describe('editViaFork — правка через ветку', () => {
  it('форкает до ПРЕДЫДУЩЕГО сообщения (редактируемое не входит в ветку)', async () => {
    await useProject.getState().editViaFork(7, 3)
    expect(forkSpy).toHaveBeenCalledTimes(1)
    expect(forkSpy.mock.calls[0][0]).toBe(7)
    expect(forkSpy.mock.calls[0][1]).toEqual({ uptoMessageId: 2 })
  })

  // Инвариант 2: отредактированный текст ждёт в композере ветки, а не улетает сам.
  it('кладёт текст редактируемого сообщения черновиком в ветку (НЕ отправляет)', async () => {
    await useProject.getState().editViaFork(7, 3)
    const draft = useProject.getState().composerDrafts[projectChatDraftKey('/p', 100)]
    expect(draft?.text).toBe('второй вопрос')
    // append (отправка) НЕ вызван — только черновик.
    expect(windowStub.api.chats.append).not.toHaveBeenCalled()
  })

  // Правка первого сообщения = ветка начинается с чистого листа. uptoMessageId 0 →
  // SELECT id <= 0 → пусто. undefined форкнул бы ВСЮ историю (баг, тест его поймал).
  it('правка ПЕРВОГО сообщения → форк до 0 (ветка пустая, НЕ вся история)', async () => {
    await useProject.getState().editViaFork(7, 1)
    expect(forkSpy.mock.calls[0][1]).toEqual({ uptoMessageId: 0 })
  })

  it('правка ответа ассистента → не форкаем', async () => {
    const r = await useProject.getState().editViaFork(7, 2)
    expect(r).toBeNull()
    expect(forkSpy).not.toHaveBeenCalled()
  })

  it('несуществующее сообщение → не форкаем', async () => {
    expect(await useProject.getState().editViaFork(7, 999)).toBeNull()
    expect(forkSpy).not.toHaveBeenCalled()
  })

  // Инвариант 3: правим ПРОШЛОЕ сообщение — стрим оригинала обязан пережить форк.
  it('активный стрим оригинала не трогается (sendOwner жив после форка)', async () => {
    useProject.setState({
      isStreaming: true,
      sendOwners: { 55: { kind: 'chat', chatId: 7, projectPath: '/p' } },
    }, false)

    await useProject.getState().editViaFork(7, 3)

    // Прогон оригинала (sendId 55) остался — форк его не прервал.
    expect(useProject.getState().sendOwners[55]).toBeDefined()
    expect(forkSpy).toHaveBeenCalled() // и форк при этом прошёл (не запрещён при стриме)
  })

  it('нет проекта → null, форк не вызван', async () => {
    useProject.setState({ path: null }, false)
    expect(await useProject.getState().editViaFork(7, 3)).toBeNull()
    expect(forkSpy).not.toHaveBeenCalled()
  })

  // Ре-ревью D #1: двойной клик по «править» БЕЗ гарда плодил две ветки (одна осиротевшая
  // с черновиком). Оригинал цел, но мусор. Reentrancy-гард: второй вызов, пока первый не
  // завершился, отклоняется.
  it('двойной клик → ровно ОДИН форк (reentrancy-гард)', async () => {
    const p1 = useProject.getState().editViaFork(7, 3)
    const p2 = useProject.getState().editViaFork(7, 3) // «второй клик» до завершения первого
    const [r1, r2] = await Promise.all([p1, p2])

    expect(forkSpy).toHaveBeenCalledTimes(1) // ветка одна, не две
    // Один из вызовов сделал ветку, другой отклонён (null).
    expect([r1, r2].filter(Boolean)).toHaveLength(1)
  })

  it('после завершения форка следующая правка снова проходит (гард снят)', async () => {
    await useProject.getState().editViaFork(7, 3)
    forkSpy.mockClear()
    await useProject.getState().editViaFork(7, 3)
    expect(forkSpy).toHaveBeenCalledTimes(1) // не залип
  })
})
