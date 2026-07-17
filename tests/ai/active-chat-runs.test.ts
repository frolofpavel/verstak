import { describe, it, expect, beforeEach } from 'vitest'
import { registerChatRun, unregisterChatRun, hasActiveRunForChat } from '../../electron/ai/runner-shared'

/**
 * Срез 2.0.11-B: реестр «в этом чате идёт прогон» — гейт ручной компакции.
 *
 * Почему отдельный реестр: activeAborts в ai.ts ключуется по sendId и на вопрос
 * «занят ли ЧАТ» не отвечает.
 *
 * ГЛАВНЫЙ РИСК — не «не заблокировали», а «не разблокировали»: залипший чат навсегда
 * теряет кнопку сжатия, и починит это только перезапуск. Поэтому снятие проверяется
 * подробнее, чем постановка.
 */

// Модуль-синглтон: чистим состояние между тестами через известные sendId.
beforeEach(() => {
  for (let i = 0; i < 50; i++) unregisterChatRun(i)
})

describe('реестр активных прогонов по чату', () => {
  it('без прогонов чат свободен', () => {
    expect(hasActiveRunForChat(1)).toBe(false)
  })

  it('прогон зарегистрирован → чат занят', () => {
    registerChatRun(1, 42)
    expect(hasActiveRunForChat(42)).toBe(true)
  })

  it('занят ТОЛЬКО свой чат, соседний свободен', () => {
    registerChatRun(1, 42)
    expect(hasActiveRunForChat(43)).toBe(false)
  })

  it('после снятия чат снова свободен', () => {
    registerChatRun(1, 42)
    unregisterChatRun(1)
    expect(hasActiveRunForChat(42)).toBe(false)
  })

  // Фоновые стримы: два прогона в одном чате. Снятие одного не должно объявить
  // чат свободным, пока второй жив.
  it('два прогона в одном чате → чат занят, пока жив хоть один', () => {
    registerChatRun(1, 42)
    registerChatRun(2, 42)
    unregisterChatRun(1)
    expect(hasActiveRunForChat(42)).toBe(true)
    unregisterChatRun(2)
    expect(hasActiveRunForChat(42)).toBe(false)
  })

  // ai:send зовётся и без чата (одноразовые прогоны). Такой прогон не должен
  // «занимать» несуществующий чат.
  it('прогон без чата не занимает ничего', () => {
    registerChatRun(1, undefined)
    registerChatRun(2, null)
    expect(hasActiveRunForChat(0)).toBe(false)
    expect(hasActiveRunForChat(42)).toBe(false)
  })

  it('снятие незарегистрированного прогона не падает', () => {
    expect(() => unregisterChatRun(999)).not.toThrow()
  })

  it('повторная регистрация того же sendId не плодит записи', () => {
    registerChatRun(1, 42)
    registerChatRun(1, 42)
    unregisterChatRun(1)
    expect(hasActiveRunForChat(42)).toBe(false) // одно снятие обязано освободить
  })
})
