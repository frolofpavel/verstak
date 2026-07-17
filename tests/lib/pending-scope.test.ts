import { describe, it, expect } from 'vitest'
import { activeScopeKey, ownerScopeKey, helpScopeKey, projectScopeKey, normalizeProjectPath } from '../../src/lib/pending-scope'
import type { SendOwner } from '../../src/store/projectStore'

/**
 * Дефект №1 карты Chat.tsx (§3.1), срез 2.0.11: очередь СПРАВКИ не отправлялась.
 *
 * Ключ scope строился в двух местах по одной формуле, но из РАЗНЫХ источников: живой — из
 * реактивного helpChatId, а в роутере событий — из замыкания первого рендера, где helpChatId
 * навсегда null. Формулы совпадали, значения — нет: `help:5` против `help:global`.
 * Последствие: очистка чистила несуществующий scope, флаш уходил в ветку «чужой scope» и
 * возвращал элемент в очередь. Спасал только страховочный эффект.
 *
 * Здесь формула ОДНА и данные приходят аргументами — устаревать нечему.
 */

const chat = (chatId: number, projectPath = 'C:/Proj/App'): SendOwner =>
  ({ kind: 'chat', chatId, projectPath } as SendOwner)
const help = (chatId: number): SendOwner =>
  ({ kind: 'chat', chatId, isHelp: true } as SendOwner)
const review = (): SendOwner => ({ kind: 'review', reviewChatId: 9, parentChatId: 7 } as SendOwner)

describe('ключ scope композера — одна формула, свежие данные (дефект №1)', () => {
  // ЯДРО ДЕФЕКТА: справка открылась ПОСЛЕ маунта, поэтому в замыкании роутера helpChatId
  // остался null. Живой ключ говорил help:5, ключ роутера — help:global. Очередь залипала.
  it('справка: живой ключ и ключ владельца СОВПАДАЮТ при одном и том же helpChatId', () => {
    const live = activeScopeKey({ isHelpChat: true, helpChatId: 5, activePath: null, activeChatId: null })
    const owner = ownerScopeKey(help(5), 5)
    expect(live).toBe('help:5')
    expect(owner).toBe('help:5')
    expect(owner).toBe(live) // ← ровно это расходилось: help:5 против help:global
  })

  it('справка ещё не открыта (helpChatId null) → обе стороны честно дают help:global', () => {
    expect(activeScopeKey({ isHelpChat: true, helpChatId: null, activePath: null, activeChatId: null })).toBe('help:global')
    expect(ownerScopeKey(help(0), null)).toBe('help:global')
  })

  // Регресс-страж: если кто-то снова начнёт брать helpChatId из устаревшего источника,
  // ключи разойдутся — и этот тест покажет ровно ту пару значений, что ломала очередь.
  it('РЕГРЕСС: устаревший helpChatId (null) против живого (5) → ключи РАСХОДЯТСЯ', () => {
    const live = activeScopeKey({ isHelpChat: true, helpChatId: 5, activePath: null, activeChatId: null })
    const staleClosure = ownerScopeKey(help(5), null) // так вело себя замыкание первого рендера
    expect(staleClosure).toBe('help:global')
    expect(staleClosure).not.toBe(live) // очередь справки уходила «в чужой scope» и залипала
  })

  it('проектный чат: живой ключ и ключ владельца совпадают', () => {
    const live = activeScopeKey({ isHelpChat: false, helpChatId: null, activePath: 'C:/Proj/App', activeChatId: 7 })
    expect(ownerScopeKey(chat(7), null)).toBe(live)
  })

  it('путь нормализуется одинаково с обеих сторон (Windows-слэши, хвост, регистр)', () => {
    const live = activeScopeKey({ isHelpChat: false, helpChatId: null, activePath: 'C:\\Proj\\App\\', activeChatId: 7 })
    const owner = ownerScopeKey(chat(7, 'c:/proj/app'), null)
    expect(owner).toBe(live) // иначе один и тот же чат имел бы два разных scope
  })

  it('чат без проекта или без id → scope нет (некуда класть очередь)', () => {
    expect(ownerScopeKey({ kind: 'chat', chatId: null } as never, null)).toBeNull()
    expect(ownerScopeKey({ kind: 'chat', projectPath: '/p' } as never, null)).toBeNull()
    expect(activeScopeKey({ isHelpChat: false, helpChatId: null, activePath: null, activeChatId: null })).toBe('none')
  })

  it('ревью-прогон не имеет scope композера', () => {
    expect(ownerScopeKey(review(), 5)).toBeNull()
    expect(ownerScopeKey(null, 5)).toBeNull()
  })

  it('справка и проектный чат с одинаковым id не сталкиваются', () => {
    expect(ownerScopeKey(help(7), 7)).not.toBe(ownerScopeKey(chat(7), 7))
  })
})

describe('строители ключей', () => {
  it('helpScopeKey', () => {
    expect(helpScopeKey(5)).toBe('help:5')
    expect(helpScopeKey(null)).toBe('help:global')
  })
  it('projectScopeKey', () => {
    expect(projectScopeKey('C:\\A\\B\\', 3)).toBe('project:c:/a/b:3')
  })
  it('normalizeProjectPath', () => {
    expect(normalizeProjectPath('C:\\Users\\Pavel\\Proj\\')).toBe('c:/users/pavel/proj')
  })
})
