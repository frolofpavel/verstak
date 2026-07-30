// SEC-CMD-07 · правила пользователя по браузеру работают, а вердикт confirm
// действительно останавливает.
//
// ЧТО ВЫЯСНИЛОСЬ ПРИ ПРОРАБОТКЕ ГЕЙТА НАВИГАЦИИ. Прежде чем спорить, какой
// словарь опасных URL завести, оказалось, что в браузере не работает сам
// МЕХАНИЗМ, поверх которого любой словарь должен стоять. Два живых дефекта, оба
// проверены по коду:
//
// 1. `extractArgText` (permission-rules.ts) не знает браузерных инструментов и
//    возвращает для них пустую строку. Значит правило с паттерном —
//    `deny: ["browser_navigate(*logout*)"]` — не матчится НИКОГДА. Пользователь
//    пишет запрет, файл читается, правило компилируется, и оно молча ничего не
//    делает. Причём `deny` объявлен в шапке модуля абсолютным («бьёт даже
//    bypass»), то есть ложным оказывается самое сильное обещание системы. Тот же
//    класс, что SEC-CMD-05: гейт судит не то значение, которое исполняется, —
//    только здесь он не судит ВООБЩЕ НИЧЕГО.
//
// 2. `browser.ts` после SEC-CMD-06 обрабатывает единственный вердикт — `block`.
//    Вердикт `confirm` (его даёт ask-правило, а завтра даст классификатор URL)
//    молча проваливается в исполнение. То есть любой будущий классификатор,
//    добавленный в `classifyResponsibleAction`, был бы ложно-зелёным: вердикт
//    верный, навигация всё равно происходит. Ровно то, что чинили сегодня в
//    bash_allowlist, где вердикт был верен, а хендлер его перебивал.
//
// ПОЧЕМУ ЭТО ВПЕРЁД СЛОВАРЯ. Словарь без этих двух починок не может работать в
// принципе. А с ними у человека появляется РЕГУЛЯТОР: он пишет свои правила по
// URL и селектору сам, не дожидаясь, пока мы угадаем список опасных слов за
// него. Наш словарь — отдельное решение с отдельной ценой, и его границы
// придётся объявлять; правило пользователя границ не требует.
import { describe, it, expect, vi } from 'vitest'
import { browserHandler } from '../../electron/ipc/tool-handlers/browser'
import { compilePermissionConfig, extractArgText, resolveDecision } from '../../electron/ai/permission-rules'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { AgentMode } from '../../electron/ai/mode-policy'
import type { ToolCall } from '../../electron/ai/types'

/**
 * Контекст со шпионом вместо webview. Сигнал оборван намеренно: если гейт решит
 * спросить человека, ожидание завершается отказом, и виден ФАКТ невыполнения, а
 * не висящий хендлер.
 */
function ctxFor(agentMode: AgentMode, rules?: ReturnType<typeof compilePermissionConfig>) {
  const exec = vi.fn(async () => ({ ok: true, url: 'https://example.com' }))
  const aborted = new AbortController()
  aborted.abort()
  const ctx = {
    projectPath: 'C:/proj',
    sendId: 1,
    runId: 'run-1',
    agentMode,
    signal: aborted.signal,
    pendingCommands: new Map(),
    scopedKey: (s: number, c: string) => `${s}::${c}`,
    sender: { send: vi.fn(), exec },
    pendingAttachments: [],
    permissionRules: rules,
    recordJournal: () => {},
    recordRunEvent: () => {},
  } as unknown as ToolContext
  return { ctx, exec }
}

const nav = (url: string): ToolCall => ({ id: 'n1', name: 'browser_navigate', args: { url } })
const click = (selector: string): ToolCall => ({ id: 'c1', name: 'browser_click', args: { selector } })

describe('SEC-CMD-07 · правило пользователя по URL действительно судит URL', () => {
  it('аргумент навигации виден правилам — иначе паттерн не матчится никогда', () => {
    expect(extractArgText('browser_navigate', { url: 'https://x.io/logout' }), 'правила слепы к URL')
      .toBe('https://x.io/logout')
  })

  it('аргумент клика виден правилам — селектор это его цель', () => {
    expect(extractArgText('browser_click', { selector: 'Оплатить' })).toBe('Оплатить')
  })

  // ОБЪЯВЛЕННАЯ ГРАНИЦА, а не сюрприз: в правилах `*` не переходит через `/`
  // (compileArgMatcher → globToRegExp: `*` = `[^/]*`, `**` = `.*`). Семантика
  // общая с правилами по путям и здесь НЕ меняется — менять её значило бы
  // трогать поведение всех существующих правил ради удобства записи. Поэтому
  // для URL нужны двойные звёздочки, и это зафиксировано пином ниже, чтобы
  // следующий не искал причину молчания правила часами.
  it('граница записи: одинарная звёздочка не переходит через слэш URL', () => {
    const narrow = compilePermissionConfig({ deny: ['browser_navigate(*logout*)'] })
    const wide = compilePermissionConfig({ deny: ['browser_navigate(**logout**)'] })
    const url = 'https://app.example.com/logout'

    expect(resolveDecision('browser_navigate', { url }, 'auto', undefined, narrow).decision,
      'семантика glob изменилась — перепиши границу целиком, а не подгоняй пин').toBe('auto-accept')
    expect(resolveDecision('browser_navigate', { url }, 'auto', undefined, wide).decision).toBe('block')
  })

  // ОБЯЗАТЕЛЬНЫЙ: deny объявлен абсолютным, значит обязан работать и здесь.
  it('deny-правило по URL блокирует навигацию', async () => {
    const rules = compilePermissionConfig({ deny: ['browser_navigate(**logout**)'] })
    const { ctx, exec } = ctxFor('auto', rules)

    const res = await browserHandler.handle(nav('https://app.example.com/logout'), ctx)

    expect(exec, 'deny-правило пользователя проигнорировано — навигация выполнена').not.toHaveBeenCalled()
    expect(res.error).toBeTruthy()
  })

  it('deny-правило по селектору блокирует клик', async () => {
    const rules = compilePermissionConfig({ deny: ['browser_click(*Оплатить*)'] })
    const { ctx, exec } = ctxFor('auto', rules)

    await browserHandler.handle(click('Оплатить сейчас'), ctx)

    expect(exec).not.toHaveBeenCalled()
  })
})

describe('SEC-CMD-07 · вердикт confirm в браузере действительно останавливает', () => {
  // ОБЯЗАТЕЛЬНЫЙ: до фикса хендлер знал только block, и confirm проваливался
  // в исполнение — любой будущий классификатор URL был бы ложно-зелёным.
  it('ask-правило: навигация НЕ выполняется без подтверждения человека', async () => {
    const rules = compilePermissionConfig({ ask: ['browser_navigate(**/unsubscribe**)'] })
    const { ctx, exec } = ctxFor('auto', rules)

    const res = await browserHandler.handle(nav('https://mail.example.com/unsubscribe?token=abc'), ctx)

    expect(exec, 'confirm проигнорирован — навигация выполнена без спроса').not.toHaveBeenCalled()
    expect(res.error).toBeTruthy()
  })

  it('на отказ человека уходит честный результат, а не тишина', async () => {
    const rules = compilePermissionConfig({ ask: ['browser_navigate'] })
    const { ctx } = ctxFor('auto', rules)

    await browserHandler.handle(nav('https://example.com/'), ctx)

    // Модалка показана и отказ зафиксирован — иначе человек не узнает, что
    // вызов был, а модель не поймёт, почему он не сработал.
    const events = (ctx.sender.send as unknown as { mock: { calls: Array<[string, { event: { type: string } }]> } }).mock.calls
      .map(c => c[1].event.type)
    expect(events).toContain('pending-command')
    expect(events).toContain('command-result')
  })

  it('вердикт confirm вообще достижим для навигации — проверка на самом гейте', () => {
    const rules = compilePermissionConfig({ ask: ['browser_navigate(**/logout**)'] })
    const { decision, confirmCause } = resolveDecision('browser_navigate', { url: 'https://x.io/logout' }, 'auto', undefined, rules)

    expect(decision).toBe('confirm')
    expect(confirmCause).toBe('ask-rule')
  })
})

describe('SEC-CMD-07 · контроль: обычная работа браузера не изменилась', () => {
  it('без правил навигация идёт молча в auto', async () => {
    const { ctx, exec } = ctxFor('auto')
    const res = await browserHandler.handle(nav('https://www.google.com/search?q=конкуренты'), ctx)
    expect(exec, 'обычная навигация стала спрашивать — сломан основной сценарий').toHaveBeenCalled()
    expect(res.error).toBeFalsy()
  })

  it('без правил навигация идёт молча и в plan — это чтение', async () => {
    const { ctx, exec } = ctxFor('plan')
    const res = await browserHandler.handle(nav('https://competitor.ru/pricing'), ctx)
    expect(exec, 'исследовательский сценарий сломан: navigate заблокирован в plan').toHaveBeenCalled()
    expect(res.error).toBeFalsy()
  })

  it('allow-правило по URL по-прежнему пропускает молча', async () => {
    const rules = compilePermissionConfig({ allow: ['browser_navigate(*)'] })
    const { ctx, exec } = ctxFor('auto', rules)
    await browserHandler.handle(nav('https://example.com/any'), ctx)
    expect(exec).toHaveBeenCalled()
  })

  it('запрет клика в plan (SEC-CMD-06) не сломан', async () => {
    const { ctx, exec } = ctxFor('plan')
    const res = await browserHandler.handle(click('Оплатить'), ctx)
    expect(exec).not.toHaveBeenCalled()
    expect(res.error).toBeTruthy()
  })
})
