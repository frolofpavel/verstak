// SEC-CMD-08 · попап из webview проходит те же правила, что обычная навигация.
//
// ДВЕРЬ, КОТОРУЮ ЭТО ЗАКРЫВАЕТ. Страница может открыть новое окно
// (`target=_blank`, `window.open`). Глухой запрет ломал бы обычные ссылки,
// поэтому main перенаправлял http(s)-попап в тот же webview — молча, без единой
// проверки. Рядом с гейтованной навигацией (SEC-CMD-07) стояла негейтованная
// дверь, и цепочка «клик по ссылке с target=_blank → новое окно → любой URL»
// проходима: клик вне режима `plan` не гейтован.
//
// ЕДИНЫЙ ИСТОЧНИК: судит тот же `applyPermissionRules` и под тем же именем
// инструмента `browser_navigate`, что и обычная навигация. Значит правило
// пользователя закрывает ОБЕ двери сразу, а не ту, про которую он думал.
//
// ЧЕСТНАЯ ГРАНИЦА, ВЫНУЖДЕННАЯ УСТРОЙСТВОМ ELECTRON, и она запинена, а не
// спрятана: `setWindowOpenHandler` СИНХРОНЕН — вернуть вердикт надо немедленно,
// `await` в этой точке не существует. Поэтому режим агента здесь не применяется
// (попап — событие страницы, а не вызов инструмента: нет ни прогона, ни sendId),
// а `ask`-правило означает ОТКАЗ, а не вопрос. Тихо грузить в этом случае
// нельзя: человек написал «спрашивай меня», и молчаливая загрузка была бы
// прямым нарушением его же правила.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { decidePopupNavigation, POPUP_TOOL_NAME } from '../../electron/ai/popup-policy'
import { compilePermissionConfig } from '../../electron/ai/permission-rules'

const ROOT = join(__dirname, '..', '..')

describe('SEC-CMD-08 · правила судят попап так же, как навигацию', () => {
  // ОБЯЗАТЕЛЬНЫЙ: то же правило, что закрывает навигацию, закрывает и попап.
  it('deny-правило по URL не пускает попап', () => {
    const rules = compilePermissionConfig({ deny: ['browser_navigate(**logout**)'] })

    const v = decidePopupNavigation('https://app.example.com/logout', rules)

    expect(v.allow, 'попап обошёл deny-правило пользователя').toBe(false)
    expect(String(v.reason)).toMatch(/deny/)
  })

  it('судит под тем же именем, что обычная навигация — одно правило на обе двери', () => {
    expect(POPUP_TOOL_NAME).toBe('browser_navigate')
  })

  // Граница объявлена: спросить синхронно нельзя, поэтому ask = отказ.
  it('ask-правило даёт ОТКАЗ, а не тихую загрузку, и объясняет почему', () => {
    const rules = compilePermissionConfig({ ask: ['browser_navigate(**/unsubscribe**)'] })

    const v = decidePopupNavigation('https://mail.example.com/unsubscribe?token=x', rules)

    expect(v.allow, 'правило «спрашивай меня» превратилось в молчаливую загрузку').toBe(false)
    expect(String(v.reason), 'человеку не сказано, где адрес всё же можно открыть').toMatch(/навигац/i)
  })

  it('не-http(s) схема не грузится никогда — у неё нет легитимного применения в попапе', () => {
    for (const url of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,<h1>x']) {
      expect(decidePopupNavigation(url, undefined).allow, `${url} загружен в webview`).toBe(false)
    }
  })

  // КОНТРОЛЬ, без которого «починкой» был бы запрет попапов целиком: обычная
  // ссылка в новом окне обязана открываться, иначе сломаются живые сайты.
  it('контроль: обычный попап без правил открывается', () => {
    expect(decidePopupNavigation('https://example.com/pricing', undefined).allow).toBe(true)
    expect(decidePopupNavigation('https://www.google.com/search?q=x', compilePermissionConfig({})).allow).toBe(true)
  })

  it('контроль: allow-правило пропускает молча', () => {
    const rules = compilePermissionConfig({ allow: ['browser_navigate(**)'] })
    expect(decidePopupNavigation('https://example.com/any', rules).allow).toBe(true)
  })
})

// Пин на ИСТОЧНИК, а не только на функцию. Правильная функция, которую никто не
// зовёт, — ровно тот класс ложной закрытости, что ловили сегодня трижды. В
// main.ts тесты не заходят (Electron), поэтому проверяем текстом — приём в
// проекте уже используется (provider-model-drift, cli-parity-contract).
describe('SEC-CMD-08 · main.ts реально зовёт эту проверку, а не хранит её рядом', () => {
  const main = readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf8')

  it('обработчик попапа обращается к decidePopupNavigation', () => {
    expect(main, 'функция есть, а дверь по-прежнему грузит сама').toContain('decidePopupNavigation')
  })

  it('в обработчике не осталось безусловной загрузки по одной лишь схеме', () => {
    // Локатор (Б1, 11.08): якорь — ветка webview, а не первое вхождение
    // setWindowOpenHandler: у главного окна появился СВОЙ обработчик попапов
    // (main-window-navigation), он стоит раньше по файлу и loadURL не зовёт
    // по построению. Утверждения пина не менялись.
    const webviewBranch = main.indexOf("getType() === 'webview'")
    const start = main.indexOf('setWindowOpenHandler', webviewBranch)
    const handler = main.slice(start, start + 600)
    expect(handler, 'обработчик не найден — пин потерял предмет').toContain('loadURL')
    expect(
      /if\s*\(\s*\/\^https\?:\\\/\\\/\/i\.test\(url\)\s*\)\s*\{\s*void contents\.loadURL\(url\)\s*\}/.test(handler),
      'вернулась прежняя проверка «схема http(s) → грузим», минуя правила'
    ).toBe(false)
  })
})
