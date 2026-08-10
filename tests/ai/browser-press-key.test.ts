// @vitest-environment jsdom
//
// Д3 (приёмка браузера 10.08): нечем отправить форму. Браузерных инструментов
// было десять, нажатия клавиши среди них не было вовсе — `browser_type_by_number`
// только вводит текст. Агент перебрал обходы и назвал дыру сам: «browser_type не
// отправляет Enter», «у меня нет инструмента нажатия клавиш напрямую».
//
// ГРАНИЦА (прямой non-goal родительской постановки — «не сорок мелких
// browser-команд»): это отправка формы, а НЕ эмуляция произвольной клавиатуры.
// Поэтому список клавиш закрытый, и пин ниже сторожит именно закрытость.
//
// Прогоняется в jsdom — тот же исходник, что инжектится в страницу (§3.1).
import { describe, it, expect, beforeEach } from 'vitest'
import { vskPressKey, VSK_PRESS_KEYS, VSK_GEN_ATTR } from '../../shared/browser-snapshot'
import { TOOL_DEFS } from '../../electron/ai/tools'
import { decide, MUTATING_BROWSER_TOOLS } from '../../electron/ai/mode-policy'

beforeEach(() => {
  document.documentElement.removeAttribute(VSK_GEN_ATTR)
  document.body.innerHTML = ''
})

describe('vskPressKey — нажатие клавиши по элементу', () => {
  it('Enter в поле формы отправляет форму (сценарий Хабра)', () => {
    document.body.innerHTML = `
      <form id="f"><input id="q" type="text"><button type="submit"></button></form>
    `
    const form = document.getElementById('f') as HTMLFormElement
    let submitted = false
    form.addEventListener('submit', e => { e.preventDefault(); submitted = true })

    const r = vskPressKey(document.getElementById('q')!, 'Enter')

    expect(r.ok).toBe(true)
    expect(submitted, 'Enter в поле не отправил форму — дыра Д3 не закрыта').toBe(true)
  })

  it('страница видит настоящие клавиатурные события с верным key/keyCode', () => {
    document.body.innerHTML = `<input id="q">`
    const el = document.getElementById('q')!
    const seen: Array<{ type: string; key: string; keyCode: number }> = []
    for (const type of ['keydown', 'keyup']) {
      el.addEventListener(type, e => {
        const ke = e as KeyboardEvent
        seen.push({ type: ke.type, key: ke.key, keyCode: ke.keyCode })
      })
    }

    vskPressKey(el, 'Enter')

    // Страницы на JS-фреймворках слушают keydown и читают key/keyCode: без них
    // «нажатие» было бы невидимым для обработчика и пин был бы ложно-зелёным.
    expect(seen.map(s => s.type)).toEqual(['keydown', 'keyup'])
    expect(seen[0].key).toBe('Enter')
    expect(seen[0].keyCode).toBe(13)
  })

  it('страница может ОТМЕНИТЬ отправку через preventDefault на keydown', () => {
    // Контроль над предыдущим: форма отправляется не безусловно, а как в браузере —
    // обработчик страницы остаётся главным. Иначе инструмент врал бы про «нажатие».
    document.body.innerHTML = `<form id="f"><input id="q"></form>`
    const form = document.getElementById('f') as HTMLFormElement
    let submitted = false
    form.addEventListener('submit', e => { e.preventDefault(); submitted = true })
    document.getElementById('q')!.addEventListener('keydown', e => e.preventDefault())

    vskPressKey(document.getElementById('q')!, 'Enter')

    expect(submitted, 'preventDefault страницы проигнорирован — это не нажатие, а подделка').toBe(false)
  })

  it('Escape и Tab доходят до страницы как события, форму не отправляют', () => {
    document.body.innerHTML = `<form id="f"><input id="q"></form>`
    const form = document.getElementById('f') as HTMLFormElement
    let submitted = false
    form.addEventListener('submit', e => { e.preventDefault(); submitted = true })
    const keys: string[] = []
    document.getElementById('q')!.addEventListener('keydown', e => keys.push((e as KeyboardEvent).key))

    expect(vskPressKey(document.getElementById('q')!, 'Escape').ok).toBe(true)
    expect(vskPressKey(document.getElementById('q')!, 'Tab').ok).toBe(true)

    expect(keys).toEqual(['Escape', 'Tab'])
    expect(submitted, 'Escape/Tab отправили форму — это уже не граница «отправка формы»').toBe(false)
  })

  it('ГРАНИЦА: произвольная клавиша отвергается честной ошибкой, а не жмётся', () => {
    // Non-goal постановки: эмуляция клавиатуры. Список закрытый — «a», «F5»,
    // «Ctrl+S» не проходят, и модель узнаёт почему.
    document.body.innerHTML = `<input id="q">`
    const el = document.getElementById('q')!
    for (const bad of ['a', 'F5', 'Control', 'ArrowDown', '']) {
      const r = vskPressKey(el, bad)
      expect(r.ok, `клавиша «${bad}» проехала мимо границы`).toBe(false)
      expect((r as { ok: false; error: string }).error).toContain('Enter')
    }
  })

  it('список клавиш — СПИСОК, и каждая его клавиша реально нажимается', () => {
    // Тот же приём, что у MUTATING_BROWSER_TOOLS: перечень, а не литералы в
    // условии, — иначе следующая разрешённая клавиша молча не заработает.
    document.body.innerHTML = `<input id="q">`
    const el = document.getElementById('q')!
    expect(VSK_PRESS_KEYS.length).toBeGreaterThan(0)
    for (const key of VSK_PRESS_KEYS) {
      expect(vskPressKey(el, key).ok, `${key} объявлена разрешённой, но не нажимается`).toBe(true)
    }
  })
})

describe('Д3: инструмент browser_press_key заведён и отгейчен', () => {
  it('инструмент объявлен модели с закрытым перечнем клавиш', () => {
    const def = TOOL_DEFS.find(t => t.name === 'browser_press_key')
    expect(def, 'browser_press_key не объявлен — модели нечем отправить форму').toBeTruthy()
    const props = def!.parameters.properties as Record<string, { enum?: string[] }>
    // enum в схеме, а не только проверка в рантайме: модель обязана видеть границу
    // до вызова, иначе она будет тратить ходы на отвергнутые клавиши.
    expect(props.key?.enum).toEqual([...VSK_PRESS_KEYS])
    expect(def!.parameters.required).toContain('key')
  })

  it('нажатие — МУТАЦИЯ чужой системы: в категории mode-policy и блокируется в plan', () => {
    // Enter отправляет форму залогиненной страницы — тот же класс, что клик.
    expect(MUTATING_BROWSER_TOOLS.includes('browser_press_key')).toBe(true)
    expect(decide('browser_press_key', 'plan')).toBe('block')
    expect(decide('browser_press_key', 'auto'), 'порог остальных режимов не ужесточаем').toBe('auto-accept')
  })
})
