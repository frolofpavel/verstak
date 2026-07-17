import { describe, it, expect } from 'vitest'
import { findRunForChat, isRunOfChat } from '../../src/lib/own-run'
import type { SendOwner } from '../../src/store/projectStore'

/**
 * Дефект №2 карты Chat.tsx (§3.2), срез 2.0.11: дополнение контекста уходило в ЧУЖОЙ прогон.
 *
 * Причина была не в сложности, а в лишней сущности: «текущий прогон» держали в ОДНОМ ref на
 * все чаты, хотя стор уже знал владельца каждого прогона. Один слот не дублировал реестр —
 * он ему противоречил. Здесь закреплено правило «спроси реестр».
 */

const chat = (chatId: number, isHelp = false): SendOwner =>
  ({ kind: 'chat', chatId, projectPath: '/p', ...(isHelp ? { isHelp: true } : {}) } as SendOwner)
const review = (reviewChatId: number, parentChatId: number): SendOwner =>
  ({ kind: 'review', reviewChatId, parentChatId } as SendOwner)

describe('чей это прогон (дефект №2: дополнение уходило в чужой чат)', () => {
  it('прогонов нет → null', () => {
    expect(findRunForChat({}, 7)).toBeNull()
  })

  it('чат не выбран → null (нечему принадлежать)', () => {
    expect(findRunForChat({ 101: chat(7) }, null)).toBeNull()
  })

  it('свой прогон находится', () => {
    expect(findRunForChat({ 101: chat(7) }, 7)).toBe(101)
  })

  // ВОТ ОН, ДЕФЕКТ. Раньше «текущим» был последний записанный в ref — то есть прогон чата 8.
  // Дополнение из чата 7 уезжало к агенту чата 8, который делает совсем другое.
  it('ДВА живых прогона в разных чатах → каждый чат получает СВОЙ, а не последний', () => {
    const owners = { 101: chat(7), 102: chat(8) }
    expect(findRunForChat(owners, 7)).toBe(101) // ← раньше сюда попадал бы 102
    expect(findRunForChat(owners, 8)).toBe(102)
  })

  it('чужой прогон не выдаётся за свой', () => {
    expect(findRunForChat({ 102: chat(8) }, 7)).toBeNull()
  })

  it('ревью-прогон не считается прогоном чата (у него своя лента)', () => {
    expect(findRunForChat({ 200: review(9, 7) }, 7)).toBeNull()
  })

  it('справка и проектный чат не смешиваются', () => {
    const owners = { 300: chat(7, true), 301: chat(7) }
    expect(findRunForChat(owners, 7)).toBe(301)                    // обычный чат
    expect(findRunForChat(owners, 7, { help: true })).toBe(300)    // справка
  })

  it('несколько прогонов одного чата → берём СВЕЖИЙ (sendId монотонно растёт)', () => {
    expect(findRunForChat({ 101: chat(7), 105: chat(7) }, 7)).toBe(105)
  })
})

describe('isRunOfChat — страж перед отправкой в прогон', () => {
  it('свой → true', () => {
    expect(isRunOfChat({ 101: chat(7) }, 101, 7)).toBe(true)
  })

  it('ЧУЖОЙ → false (ровно эта проверка не давала бы дополнению уехать)', () => {
    expect(isRunOfChat({ 101: chat(7), 102: chat(8) }, 102, 7)).toBe(false)
  })

  it('неизвестный sendId → false', () => {
    expect(isRunOfChat({ 101: chat(7) }, 999, 7)).toBe(false)
  })

  it('null-аргументы → false, а не падение', () => {
    expect(isRunOfChat({ 101: chat(7) }, null, 7)).toBe(false)
    expect(isRunOfChat({ 101: chat(7) }, 101, null)).toBe(false)
  })
})
