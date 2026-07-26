// PerChatState 4.4: patch-билдеры переходов чата. Хранилище одно (chats), поэтому
// билдеры проверяются по двум свойствам: состояние чатов не теряется при переходе,
// а поля ВНЕ bundle (артефакты, маркеры файлов, превью, пагинация) не утекают от
// уходящего чата к приходящему — исторически именно это и дрейфовало.
import { describe, it, expect } from 'vitest'
import {
  buildFreshSwitchPatch,
  buildRestoredSwitchPatch,
  buildNewChatPatch,
  buildLeaveHelpRestorePatch,
  buildCloseProjectPatch,
  buildSetProjectPatch,
} from '../../src/store/chat-lifecycle'
import { freshSnapshot, type SessionSnapshot } from '../../src/store/session-snapshot'

const snap = (chatId: number, over: Partial<SessionSnapshot> = {}): SessionSnapshot =>
  ({ ...freshSnapshot(), chatId, ...over })

const NON_BUNDLE = ['openedReviewId', 'touchedFiles', 'artifacts', 'previewArtifactId'] as const

describe('вход в чат без сохранённого состояния', () => {
  const patch = buildFreshSwitchPatch({ activeChatId: 2, chats: { 1: snap(1, { isStreaming: true }) } })

  it('новый активный получает пустой bundle со своим id', () => {
    expect(patch.chats[2].chatId).toBe(2)
    expect(patch.chats[2].messages).toHaveLength(0)
    expect(patch.chats[2].hasUnread).toBe(false)
  })

  it('состояние остальных чатов сохраняется', () => {
    expect(patch.chats[1].isStreaming).toBe(true)
  })

  it('поля вне bundle сброшены — иначе утекут от уходящего чата', () => {
    for (const k of NON_BUNDLE) expect(patch, `не сброшено: ${k}`).toHaveProperty(k)
  })

  it('пагинация истории сброшена', () => {
    expect(patch.chatHasMoreBefore).toBe(false)
    expect(patch.chatTotalCount).toBe(0)
  })
})

describe('вход в чат с сохранённым состоянием', () => {
  const restored = snap(2, { messages: [{ role: 'user', content: 'было' }], checkpointId: 42 })
  const patch = buildRestoredSwitchPatch({ activeChatId: 2, restored, chats: { 1: snap(1), 2: restored } })

  it('состояние чата возвращается целиком, включая per-chat checkpoint', () => {
    expect(patch.chats[2].messages).toHaveLength(1)
    expect(patch.chats[2].checkpointId, 'чужой checkpoint не должен подменить свой').toBe(42)
  })

  it('вошедший чат прочитан', () => {
    expect(patch.chats[2].hasUnread).toBe(false)
  })

  it('поля вне bundle сброшены', () => {
    for (const k of NON_BUNDLE) expect(patch).toHaveProperty(k)
  })
})

describe('создание нового чата', () => {
  const patch = buildNewChatPatch({ activeChatId: 5, chats: { 1: snap(1) }, chatSessions: [] })

  it('новый чат пустой, старые сохранены', () => {
    expect(patch.chats[5].messages).toHaveLength(0)
    expect(patch.chats[1]).toBeDefined()
  })

  it('пагинация сброшена (VSK-FIX-PAGINATION)', () => {
    expect(patch.chatHasMoreBefore).toBe(false)
    expect(patch.chatTotalCount).toBe(0)
  })
})

describe('выход из справки', () => {
  const base = snap(1, { isStreaming: true, streamStartedAt: 1000, messages: [{ role: 'user', content: 'x' }] })

  it('живой стрим сохраняется — иначе теряется идущий ответ', () => {
    const p = buildLeaveHelpRestorePatch({ snap: base, chatId: 1, chats: { 1: base }, inflight: true })
    expect(p.chats[1].isStreaming).toBe(true)
    expect(p.chats[1].streamStartedAt).toBe(1000)
    expect(p.helpMode).toBe(false)
  })

  it('фантомный стрим снимается — иначе залипает баннер «отвечает»', () => {
    const p = buildLeaveHelpRestorePatch({ snap: base, chatId: 1, chats: { 1: base }, inflight: false })
    expect(p.chats[1].isStreaming).toBe(false)
    expect(p.chats[1].streamStartedAt).toBeNull()
    expect(p.chats[1].messages, 'сообщения при этом теряться не должны').toHaveLength(1)
  })
})

describe('закрытие проекта', () => {
  const patch = buildCloseProjectPatch()
  it('состояние чатов очищено полностью', () => {
    expect(patch.chats).toEqual({})
    expect(patch.activeChatId).toBeNull()
    expect(patch.helpMode).toBe(false)
  })
})

describe('смена проекта', () => {
  const target = snap(0, { isStreaming: true })
  const patch = buildSetProjectPatch({
    path: '/b', target, sessions: {}, messages: [{ role: 'user', content: 'из истории' }],
    chatSessions: [], activeChatId: 9,
  })

  it('чаты прошлого проекта не переносятся: id разных проектов пересекаются', () => {
    expect(Object.keys(patch.chats)).toEqual(['9'])
  })

  it('активный чат нового проекта получает загруженную историю', () => {
    expect(patch.chats[9].messages).toHaveLength(1)
    expect(patch.chats[9].chatId).toBe(9)
    expect(patch.chats[9].hasUnread).toBe(false)
  })

  it('без активного чата состояние чатов пустое, а не унаследованное', () => {
    const p = buildSetProjectPatch({
      path: '/b', target, sessions: {}, messages: [], chatSessions: [], activeChatId: null,
    })
    expect(p.chats).toEqual({})
  })
})
