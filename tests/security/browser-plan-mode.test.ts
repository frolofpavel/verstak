// SEC-CMD-06 · режим «Планирование» не кликает в браузере.
//
// ЧТО БЫЛО СЛОМАНО. `browser_click` — единственное действие браузера, меняющее
// ЧУЖУЮ систему (`el.click()` внутри залогиненной страницы), и оно исполнялось
// во всех пяти режимах, включая `plan`, где запрещено даже читать файл на
// запись. Гейта не было ни одного: `tool-handlers/browser.ts` не звал ни
// `resolveDecision`, ни `decide`.
//
// ЛОВУШКА, ИЗ-ЗА КОТОРОЙ НАИВНАЯ ВРЕЗКА НЕ СРАБОТАЛА БЫ. Просто позвать
// `resolveDecision('browser_click', …)` мало: `mode-policy.decide` перехватывает
// незнакомое имя строкой `if (!isEdit && !isCommand) return 'auto-accept'` РАНЬШЕ
// switch по режиму — то есть до `case 'plan'` дело не доходит вовсе. Поэтому
// правятся ОБЕ точки: категория в `decide()` и разбор аргументов в
// `classifyResponsibleAction`. Гейт, который выглядит поставленным и не
// срабатывает, хуже отсутствующего — этот класс мы ловили сегодня дважды
// (SEC-CMD-04, SEC-CMD-05).
//
// КАТЕГОРИЯ — СПИСКОМ, А НЕ ЛИТЕРАЛОМ, и это важнее самого запрета. Литерал
// `toolName === 'browser_click'` закрывает вчерашнюю дыру и оставляет
// завтрашнюю: следующий `browser_type` или `browser_select` проедет мимо ровно
// так же, как проехал клик. Пин ниже сторожит именно расширяемость.
//
// ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО: вопроса в режимах `ask`/`auto`. Порог трения
// выбирает Павел по фактическим цифрам, которые появятся благодаря
// наблюдаемости (`b13e9e1`), а не по нашим оценкам — они разошлись в полтора
// раза. Здесь только бесспорное: в режиме «только чтение» не кликаем.
import { describe, it, expect, vi } from 'vitest'
import { browserHandler } from '../../electron/ipc/tool-handlers/browser'
import { decide, MUTATING_BROWSER_TOOLS } from '../../electron/ai/mode-policy'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { AgentMode } from '../../electron/ai/mode-policy'
import type { ToolCall } from '../../electron/ai/types'

/** Контекст со шпионом вместо webview: предмет проверки — дошёл ли вызов до страницы. */
function ctxFor(agentMode: AgentMode) {
  const exec = vi.fn(async () => ({ ok: true, url: 'https://example.com' }))
  const ctx = {
    projectPath: 'C:/proj',
    sendId: 1,
    runId: 'run-1',
    agentMode,
    sender: { send: vi.fn(), exec },
    pendingAttachments: [],
    pendingCommands: new Map(),
    scopedKey: (s: number, c: string) => `${s}::${c}`,
    recordJournal: () => {},
    recordRunEvent: () => {},
  } as unknown as ToolContext
  return { ctx, exec }
}

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: 'b1', name, args })

describe('SEC-CMD-06 · plan не кликает', () => {
  // ОБЯЗАТЕЛЬНЫЙ ПИН: факт, а не вердикт — вызов не доходит до страницы.
  it('в режиме plan клик НЕ доходит до страницы', async () => {
    const { ctx, exec } = ctxFor('plan')

    const res = await browserHandler.handle(call('browser_click', { selector: 'Оплатить' }), ctx)

    expect(exec, 'клик исполнился в режиме «только чтение»').not.toHaveBeenCalled()
    expect(res.error, 'отказ должен быть назван человеку и модели').toBeTruthy()
  })

  it('отказ объясняет причину режимом, а не молчит', async () => {
    const { ctx } = ctxFor('plan')

    const res = await browserHandler.handle(call('browser_click', { selector: 'Отправить' }), ctx)

    expect(String(res.error)).toMatch(/планирован|plan/i)
  })

  // ЛОВУШКА ЗАКРЫТА В ИСТОЧНИКЕ: decide() должен знать про клик сам, иначе любой
  // следующий вызывающий получит auto-accept и не заметит этого.
  it('mode-policy знает про мутирующий браузерный инструмент', () => {
    expect(decide('browser_click', 'plan')).toBe('block')
    expect(decide('browser_click', 'auto'), 'порог остальных режимов здесь не решается').toBe('auto-accept')
  })

  // РАСШИРЯЕМОСТЬ: категория задаётся списком, и будущий инструмент попадает под
  // запрет по умолчанию, а не по памяти автора правки.
  it('категория — СПИСОК, а не литерал: любой мутирующий браузерный тул блокируется в plan', () => {
    expect(Array.isArray(MUTATING_BROWSER_TOOLS) || MUTATING_BROWSER_TOOLS instanceof Set).toBe(true)
    for (const name of MUTATING_BROWSER_TOOLS) {
      expect(decide(name, 'plan'), `${name} проезжает мимо гейта в режиме plan`).toBe('block')
    }
  })

  // КОНТРОЛЬ, без которого «починкой» был бы запрет браузера целиком: чтение и
  // съёмка в plan обязаны работать — ради них режим и существует.
  it('контроль: read_page, screenshot и navigate в plan работают как раньше', async () => {
    for (const name of ['browser_read_page', 'browser_screenshot', 'browser_navigate']) {
      const { ctx, exec } = ctxFor('plan')
      const res = await browserHandler.handle(call(name, { url: 'https://example.com' }), ctx)
      expect(exec, `${name} перестал работать в plan`).toHaveBeenCalled()
      expect(res.error, `${name} отвергнут`).toBeFalsy()
    }
  })

  // КОНТРОЛЬ: вне plan клик по-прежнему исполняется — трение не добавлено.
  it('контроль: в auto и accept-edits клик исполняется без вопросов', async () => {
    for (const mode of ['auto', 'accept-edits'] as AgentMode[]) {
      const { ctx, exec } = ctxFor(mode)
      const res = await browserHandler.handle(call('browser_click', { selector: 'Обновить' }), ctx)
      expect(exec, `клик перестал работать в режиме ${mode}`).toHaveBeenCalled()
      expect(res.error).toBeFalsy()
    }
  })

  // VSK-BROWSER-B1 этап 1: SEC-CMD-06 на НОВОМ пути. Клик ПО НОМЕРУ — та же мутация
  // чужой системы, и он обязан быть ЗЕЛЁНЫМ (заблокирован в plan) ПОТОМУ, что новый
  // путь под тем же гейтом (категория-список), а не потому, что старый ещё жив.
  it('НОВЫЙ ПУТЬ: browser_click_by_number в plan НЕ доходит до страницы', async () => {
    const { ctx, exec } = ctxFor('plan')
    const res = await browserHandler.handle(call('browser_click_by_number', { n: 2 }), ctx)
    expect(exec, 'клик по номеру исполнился в режиме «только чтение»').not.toHaveBeenCalled()
    expect(res.error, 'отказ назван').toBeTruthy()
    expect(String(res.error)).toMatch(/планирован|plan/i)
    expect(decide('browser_click_by_number', 'plan')).toBe('block')
  })

  // КОНТРОЛЬ НОВОГО ПУТИ: снимок — ЧТЕНИЕ, в plan обязан работать (ради него режим и есть).
  it('НОВЫЙ ПУТЬ: browser_snapshot в plan работает (это чтение, не мутация)', async () => {
    const { ctx, exec } = ctxFor('plan')
    const res = await browserHandler.handle(call('browser_snapshot', {}), ctx)
    expect(exec, 'снимок заблокирован в plan').toHaveBeenCalled()
    expect(res.error, 'снимок отвергнут').toBeFalsy()
  })
})
