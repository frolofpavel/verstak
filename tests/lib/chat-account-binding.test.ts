import { describe, it, expect } from 'vitest'
import {
  chatAccountView, canPinAccounts, accountStateLabel, isPinnable, pinBinding, autoBinding,
  shouldShowAccountBinding,
} from '../../src/lib/chat-account-binding'
// Движок берём из main — сверяем, что UI не разъехался с ним (урок «шва между слоями»).
import { pickChatAccountId } from '../../electron/ai/route-policy'
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
    expect(chatAccountView(bind({ accountId: 99 }), [acc({ id: 1 })], 'claude', [acc({ id: 1 })]))
      .toEqual({ kind: 'unavailable', accountId: 99 })
  })

  // Ре-ревью honesty (HIGH, регрессия 8bdc11e): пин под claude, чат переключён на gemini
  // (у gemini нет подписочных аккаунтов). Аккаунт claude ЖИВ — просто относится к другому
  // провайдеру. Движок (pickChatAccountId) в этом случае даёт 'auto' и спокойно работает;
  // UI обязан сказать то же, а не пугать «аккаунт удалён» и не предлагать снести живой пин.
  it('пин на аккаунт ДРУГОГО провайдера (аккаунт жив) → auto, НЕ «недоступен»', () => {
    const claudeAcc = acc({ id: 1, providerId: 'claude' })
    // ВАЖНО: binding.providerId в проде синтезируется из ТЕКУЩЕГО провайдера чата
    // (chats.ts:101) — поэтому здесь он 'gemini-api', как отдал бы main, а не 'claude'.
    // accounts = список gemini (пусто), но claude-аккаунт существует глобально.
    expect(chatAccountView(bind({ accountId: 1, providerId: 'gemini-api' }), [], 'gemini-api', [claudeAcc]))
      .toEqual({ kind: 'auto' })
  })

  it('пин на аккаунт, которого нет НИГДЕ → «недоступен» (реально удалён)', () => {
    expect(chatAccountView(bind({ accountId: 99, providerId: 'claude' }), [], 'claude', []))
      .toEqual({ kind: 'unavailable', accountId: 99 })
  })

  // Прямая сверка с движком на одних и тех же входах — чтобы UI и main не разъехались.
  it('совпадает с pickChatAccountId движка на кросс-провайдерном пине', () => {
    const claudeAcc = acc({ id: 1, providerId: 'claude' })
    const all = [claudeAcc]
    const lookup = (id: number) => all.find(a => a.id === id)?.providerId ?? null
    const b = { mode: 'pinned' as const, accountId: 1 }
    const engine = pickChatAccountId('gemini-api', b, lookup)
    const ui = chatAccountView(bind({ accountId: 1, providerId: 'gemini-api' }), [], 'gemini-api', all)
    expect(engine.kind).toBe('auto')
    expect(ui.kind).toBe('auto')
  })

  it('закрепление ЧУЖОГО провайдера не течёт на текущий', () => {
    // Чат закреплён на аккаунт codex (id=2), сейчас выбран claude. Реалистичный вход:
    // codex-аккаунта нет среди claude-аккаунтов, но он жив глобально → auto (как движок),
    // а не ложное «закреплено». (Раньше тест держал мёртвый guard на providerId и брал
    // accountId=1, совпадающий с claude-аккаунтом — вход, который main не синтезирует.)
    const claudeAcc = acc({ id: 1, providerId: 'claude' })
    const codexAcc = acc({ id: 2, providerId: 'codex-cli' })
    expect(chatAccountView(bind({ accountId: 2, providerId: 'claude' }), [claudeAcc], 'claude', [claudeAcc, codexAcc]))
      .toEqual({ kind: 'auto' })
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

/**
 * Honesty & unbrick срез (ре-ревью 2.0.11-B, находка #4): чат-кирпич без выхода.
 *
 * Человек закрепил аккаунт за чатом, потом удалил все аккаунты этого провайдера. Движок
 * честно останавливает прогон («аккаунт удалён»), а секция «Аккаунт подписки» в UI
 * показывалась ТОЛЬКО при accounts.length > 0 — то есть исчезала вместе с последним
 * аккаунтом, унося и предупреждение, и единственный способ открепиться («Автоматически»).
 * Чат замолкал навсегда, а починить его из интерфейса было нечем.
 *
 * Правило: если закрепление ВИСИТ, секция обязана быть видна — даже когда закреплять уже
 * не на что. Выход из тупика важнее чистоты меню.
 */
describe('чат-кирпич: открепиться можно всегда (unbrick)', () => {
  const dangling = bind({ accountId: 99 })

  it('аккаунтов не осталось, но закрепление висит → секцию ПОКАЗЫВАЕМ', () => {
    const view = chatAccountView(dangling, [], 'claude')
    expect(view).toEqual({ kind: 'unavailable', accountId: 99 })
    expect(shouldShowAccountBinding([], view)).toBe(true)
  })

  it('аккаунтов нет и закрепления нет → секции нет (шум ни к чему)', () => {
    expect(shouldShowAccountBinding([], { kind: 'auto' })).toBe(false)
  })

  it('аккаунты есть → секция как раньше', () => {
    expect(shouldShowAccountBinding([acc()], { kind: 'auto' })).toBe(true)
    expect(shouldShowAccountBinding([acc()], { kind: 'pinned', accountId: 1, label: 'Личный Max' })).toBe(true)
  })

  it('протухшее закрепление при живых аккаунтах — секция тоже видна', () => {
    expect(shouldShowAccountBinding([acc({ id: 1 })], chatAccountView(dangling, [acc({ id: 1 })], 'claude'))).toBe(true)
  })

  // Открепление = вернуть авто-выбор. Это существующий путь, ему просто негде было
  // показаться. Проверяем, что он собирается корректно и без ссылки на мёртвый аккаунт.
  it('открепление собирается как авто-биндинг (без мёртвого accountId)', () => {
    const b = autoBinding(7, 'claude')
    expect(b.mode).toBe('auto')
    expect(b.chatId).toBe(7)
    expect(b.providerId).toBe('claude')
    expect(b.accountId ?? null).toBeNull()
  })
})
