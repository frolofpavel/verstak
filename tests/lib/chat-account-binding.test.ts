import { describe, it, expect } from 'vitest'
import {
  chatAccountView, canPinAccounts, accountStateLabel, isPinnable, pinBinding, autoBinding,
} from '../../src/lib/chat-account-binding'
import type { SubscriptionAccountDTO, ChatSubscriptionBindingDTO } from '../../src/types/api'

/**
 * Хвост 2.0.8-D2 (срез 2.0.10): закрепление аккаунта за чатом получает интерфейс.
 *
 * ГЛАВНОЕ ЗДЕСЬ — UI не смеет расходиться с движком. Бэкенд (route-policy.resolveChatAccount)
 * различает auto / pinned / **unavailable** (закреплён на удалённый аккаунт → прогон честно
 * останавливается вопросом). Если UI покажет «закреплено» там, где движок скажет
 * «недоступен» — человек не поймёт, почему чат встал.
 */

const acc = (over: Partial<SubscriptionAccountDTO> = {}): SubscriptionAccountDTO => ({
  id: 1, providerId: 'claude', label: 'Рабочий', authMode: 'token', state: 'ready',
  active: true, lastUsedAt: null, hasCredential: true, ...over,
} as SubscriptionAccountDTO)

const bind = (over: Partial<ChatSubscriptionBindingDTO> = {}): ChatSubscriptionBindingDTO => ({
  chatId: 7, providerId: 'claude', mode: 'pinned', accountId: 1, ...over,
} as ChatSubscriptionBindingDTO)

describe('закрепление аккаунта за чатом — что показываем (хвост D2)', () => {
  it('биндинга нет → авто', () => {
    expect(chatAccountView(null, [acc()], 'claude')).toEqual({ kind: 'auto' })
  })

  it('режим auto → авто (даже если accountId зачем-то лежит)', () => {
    expect(chatAccountView(bind({ mode: 'auto', accountId: 5 }), [acc()], 'claude')).toEqual({ kind: 'auto' })
  })

  it('закреплён за живым аккаунтом → показываем его ярлык', () => {
    expect(chatAccountView(bind(), [acc({ id: 1, label: 'Личный Max' })], 'claude'))
      .toEqual({ kind: 'pinned', accountId: 1, label: 'Личный Max' })
  })

  // ЗЕРКАЛО ДВИЖКА: main-side resolveChatAccount вернёт 'unavailable' и остановит прогон
  // вопросом. UI обязан сказать то же, иначе человек не поймёт, почему чат не отвечает.
  it('закреплён за УДАЛЁННЫМ аккаунтом → «недоступен», а НЕ «закреплено»', () => {
    expect(chatAccountView(bind({ accountId: 99 }), [acc({ id: 1 })], 'claude'))
      .toEqual({ kind: 'unavailable', accountId: 99 })
  })

  it('закрепление ЧУЖОГО провайдера не течёт на текущий', () => {
    // Чат закреплён на аккаунт codex; сейчас выбран claude — бейдж «закреплено» был бы ложью.
    expect(chatAccountView(bind({ providerId: 'codex-cli' }), [acc()], 'claude')).toEqual({ kind: 'auto' })
  })

  it('аккаунтов нет → закреплять нечего (кнопка не показывается)', () => {
    expect(canPinAccounts([])).toBe(false)
    expect(canPinAccounts([acc()])).toBe(true)
  })
})

describe('какие аккаунты можно закрепить', () => {
  it('готовый — можно', () => {
    expect(isPinnable(acc({ state: 'ready' }))).toBe(true)
  })

  it('ОСТЫВАЮЩИЙ — можно: остывание временно, а закрепление про «работай только тут»', () => {
    expect(isPinnable(acc({ state: 'cooling' }))).toBe(true)
  })

  it('без ключа — нельзя: закрепление гарантировало бы стоп прогонов', () => {
    expect(isPinnable(acc({ hasCredential: false }))).toBe(false)
  })

  it('нужен вход / ошибка — нельзя по той же причине', () => {
    expect(isPinnable(acc({ state: 'login-required' }))).toBe(false)
    expect(isPinnable(acc({ state: 'invalid' }))).toBe(false)
  })
})

describe('подписи состояний — по-русски, без жаргона', () => {
  it('переводит все состояния', () => {
    expect(accountStateLabel(acc({ state: 'ready' }))).toBe('готов')
    expect(accountStateLabel(acc({ state: 'cooling' }))).toBe('остывает')
    expect(accountStateLabel(acc({ state: 'login-required' }))).toBe('нужен вход')
    expect(accountStateLabel(acc({ state: 'invalid' }))).toBe('ошибка')
  })

  it('отсутствие ключа важнее статуса (иначе «готов» без ключа врал бы)', () => {
    expect(accountStateLabel(acc({ state: 'ready', hasCredential: false }))).toBe('ключ не найден')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// СТРАЖ ОТ ДРЕЙФА. Renderer и main — разные процессы, общей функции нет, поэтому
// логика неизбежно продублирована. Дубли расходятся молча (2.0.7-C это уже ловил на
// провайдерах). Здесь сверяем ВЕРДИКТЫ на одинаковых входах: если кто-то поменяет
// правило с одной стороны, тест покраснеет, а не пользователь удивится.
// ─────────────────────────────────────────────────────────────────────────────
describe('СТРАЖ: UI не расходится с движком (route-policy.resolveChatAccount)', () => {
  const cases: Array<{ name: string; binding: ChatSubscriptionBindingDTO | null; existing: number[] }> = [
    { name: 'биндинга нет', binding: null, existing: [1] },
    { name: 'auto', binding: bind({ mode: 'auto', accountId: null }), existing: [1] },
    { name: 'pinned, аккаунт жив', binding: bind({ accountId: 1 }), existing: [1] },
    { name: 'pinned, аккаунт удалён', binding: bind({ accountId: 99 }), existing: [1] },
  ]

  it.each(cases)('вердикт совпадает: $name', async ({ binding, existing }) => {
    const { resolveChatAccount } = await import('../../electron/ai/route-policy')
    const engine = resolveChatAccount(binding, (id: number) => existing.includes(id))
    const ui = chatAccountView(binding, existing.map(id => acc({ id })), 'claude')
    // status движка и kind UI — одно и то же множество: auto | pinned | unavailable.
    expect(ui.kind).toBe(engine.status)
  })
})

describe('биндинги для записи', () => {
  it('закрепить', () => {
    expect(pinBinding(7, 'claude', 3)).toEqual({ chatId: 7, providerId: 'claude', mode: 'pinned', accountId: 3 })
  })

  it('открепить — accountId обязан обнулиться, иначе движок счёл бы чат закреплённым', () => {
    expect(autoBinding(7, 'claude')).toEqual({ chatId: 7, providerId: 'claude', mode: 'auto', accountId: null })
  })
})
