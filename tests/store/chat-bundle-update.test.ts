// PerChatState 4.4: applyBundleUpdate — единственная точка мутации состояния чата.
// До 4.4 функция раскладывала патч по трём хранилищам (top-level / chatSnapshots /
// chats) и главным риском была рассинхронизация. Теперь хранилище одно, и проверять
// надо другое: патч попадает В СВОЙ чат, не задевает соседние и не выдумывает
// непрочитанность активному.
import { describe, it, expect } from 'vitest'
import { applyBundleUpdate, type BundleHostState } from '../../src/store/chat-bundle-update'
import { freshSnapshot, type SessionSnapshot } from '../../src/store/session-snapshot'

const snap = (chatId: number, over: Partial<SessionSnapshot> = {}): SessionSnapshot =>
  ({ ...freshSnapshot(), chatId, ...over })

const host = (over: Partial<BundleHostState> = {}): BundleHostState =>
  ({ activeChatId: 1, chats: { 1: snap(1) }, ...over })

describe('applyBundleUpdate — маршрутизация патча', () => {
  it('патч активного чата ложится в его запись', () => {
    const patch = applyBundleUpdate(host(), 1, () => ({ isStreaming: true }))
    expect(patch.chats![1].isStreaming).toBe(true)
  })

  it('chatId=null означает «текущий активный»', () => {
    const patch = applyBundleUpdate(host(), null, () => ({ isStreaming: true }))
    expect(patch.chats![1].isStreaming).toBe(true)
  })

  it('патч фонового чата не задевает активный', () => {
    const s = host({ chats: { 1: snap(1), 2: snap(2) } })
    const patch = applyBundleUpdate(s, 2, () => ({ isStreaming: true }))
    expect(patch.chats![2].isStreaming).toBe(true)
    expect(patch.chats![1].isStreaming, 'соседний чат обязан остаться нетронутым').toBe(false)
  })

  it('первое событие незнакомого чата заводит ему запись, а не теряется', () => {
    const patch = applyBundleUpdate(host(), 7, () => ({ isStreaming: true }))
    expect(patch.chats![7]).toBeDefined()
    expect(patch.chats![7].chatId, 'запись обязана знать свой id').toBe(7)
  })

  it('активному чату непрочитанность не приписывается — он на экране', () => {
    const patch = applyBundleUpdate(host(), 1, () => ({ hasUnread: true }))
    expect(patch.chats![1].hasUnread).toBe(false)
  })

  it('фоновому чату непрочитанность сохраняется', () => {
    const s = host({ chats: { 1: snap(1), 2: snap(2) } })
    const patch = applyBundleUpdate(s, 2, () => ({ hasUnread: true }))
    expect(patch.chats![2].hasUnread).toBe(true)
  })

  it('пустой патч и null не порождают записи в стор', () => {
    expect(applyBundleUpdate(host(), 1, () => null)).toEqual({})
    expect(applyBundleUpdate(host(), 1, () => ({}))).toEqual({})
  })

  it('без активного чата и без явного id писать некуда', () => {
    const patch = applyBundleUpdate(host({ activeChatId: null }), null, () => ({ isStreaming: true }))
    expect(patch).toEqual({})
  })

  it('updater видит текущее состояние чата, а не пустую заготовку', () => {
    const s = host({ chats: { 1: snap(1, { messages: [{ role: 'user', content: 'было' }] }) } })
    let seen = 0
    applyBundleUpdate(s, 1, b => { seen = b.messages.length; return { isStreaming: true } })
    expect(seen).toBe(1)
  })

  it('исходное состояние не мутируется — патч возвращает новые объекты', () => {
    const s = host()
    const before = s.chats[1]
    applyBundleUpdate(s, 1, () => ({ isStreaming: true }))
    expect(s.chats[1], 'старая запись обязана остаться прежней').toBe(before)
    expect(before.isStreaming).toBe(false)
  })
})
