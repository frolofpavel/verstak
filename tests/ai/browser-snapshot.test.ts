// @vitest-environment jsdom
//
// VSK-BROWSER-B1 этап 1: ядро структурного снимка с нумерацией + клик по номеру.
// Прогоняется в jsdom — тот же исходник, что инжектится в страницу (§3.1).
import { describe, it, expect, beforeEach } from 'vitest'
import { vskSnapshot, vskResolveNumbered, vskFill, vskMatchTarget, VSK_GEN_ATTR, VSK_EL_ATTR } from '../../shared/browser-snapshot'

beforeEach(() => {
  document.documentElement.removeAttribute(VSK_GEN_ATTR)
  document.body.innerHTML = ''
})

describe('vskSnapshot — нумерация интерактивных элементов', () => {
  it('нумерует ссылки/кнопки/поля, отдаёт роль и подпись, метит data-vsk-el', () => {
    document.body.innerHTML = `
      <a href="/x">Открыть</a>
      <button>Сохранить</button>
      <input type="text" aria-label="Имя">
      <p>просто текст</p>
    `
    const snap = vskSnapshot('g1')
    expect(snap.count).toBe(3)
    expect(snap.elements.map(e => e.n)).toEqual([1, 2, 3])
    expect(snap.elements[0]).toMatchObject({ tag: 'a', role: 'link', name: 'Открыть' })
    expect(snap.elements[1]).toMatchObject({ tag: 'button', role: 'button', name: 'Сохранить' })
    expect(snap.elements[2]).toMatchObject({ tag: 'input', role: 'textbox', name: 'Имя' })
    expect(document.querySelector('a')?.getAttribute(VSK_EL_ATTR)).toBe('g1:1')
    expect(document.documentElement.getAttribute(VSK_GEN_ATTR)).toBe('g1')
  })

  it('скрытые элементы (hidden / display:none / aria-hidden) не нумеруются', () => {
    document.body.innerHTML = `
      <button>Видимая</button>
      <button hidden>Скрытая hidden</button>
      <button style="display:none">Скрытая display</button>
      <button aria-hidden="true">Скрытая aria</button>
      <div style="display:none"><button>Внутри скрытого</button></div>
    `
    const snap = vskSnapshot('g1')
    expect(snap.count).toBe(1)
    expect(snap.elements[0].name).toBe('Видимая')
  })
})

describe('vskResolveNumbered — разрешение номера + ПРОТУХАНИЕ (требование №1)', () => {
  it('валидный номер текущего снимка → элемент', () => {
    document.body.innerHTML = `<button>Один</button><button>Два</button>`
    vskSnapshot('g1')
    const r = vskResolveNumbered(2)
    expect(r.ok).toBe(true)
    expect((r as { ok: true; el: Element }).el.textContent).toBe('Два')
  })

  // КЛЮЧЕВОЙ ПИН: навигация (новый документ без поколения) → клик по номеру честно
  // отказывает, а НЕ кликает наугад. Ошибка в сторону молчания, не ложного действия.
  it('после «навигации» (сброс data-vsk-gen) номер протухает → честная ошибка', () => {
    document.body.innerHTML = `<button>Кнопка</button>`
    vskSnapshot('g1')
    expect(vskResolveNumbered(1).ok).toBe(true)
    // Навигация: новый документ. Эмулируем сбросом поколения + перерисовкой тела.
    document.documentElement.removeAttribute(VSK_GEN_ATTR)
    document.body.innerHTML = `<button>Другая страница</button>`
    const r = vskResolveNumbered(1)
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: string }).error).toContain('Нет активного снимка')
  })

  it('новый снимок меняет поколение → номер из прежнего снимка не находится', () => {
    document.body.innerHTML = `<button>A</button><button>B</button>`
    vskSnapshot('g1')
    // Прежний снимок дал номера под g1. Новый снимок с иным поколением:
    document.body.innerHTML = `<button>C</button>`  // страница изменилась
    vskSnapshot('g2')
    // Клиент помнит «№2» из g1 — под g2 такого нет (в g2 только №1).
    const r = vskResolveNumbered(2)
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: string }).error).toContain('№2')
  })

  it('элемент исчез из DOM при том же поколении → номер не находится (не старый ref)', () => {
    document.body.innerHTML = `<button id="a">A</button><button id="b">B</button>`
    vskSnapshot('g1')
    document.getElementById('b')!.remove()   // элемент №2 удалён, поколение то же
    const r = vskResolveNumbered(2)
    expect(r.ok).toBe(false)
  })

  it('нет снимка вовсе → честная ошибка, не бросок', () => {
    document.body.innerHTML = `<button>X</button>`
    const r = vskResolveNumbered(1)
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: string }).error).toContain('Нет активного снимка')
  })
})

describe('vskFill — ввод по номеру (browser_type_by_number)', () => {
  it('input/textarea → выставляет value + событие input', () => {
    document.body.innerHTML = `<input id="q"><textarea id="t"></textarea>`
    const input = document.getElementById('q') as HTMLInputElement
    let fired = false
    input.addEventListener('input', () => { fired = true })
    const r = vskFill(input, 'привет')
    expect(r.ok).toBe(true)
    expect(input.value).toBe('привет')
    expect(fired, 'событие input не сработало — фреймворк не увидит ввод').toBe(true)
    const ta = document.getElementById('t') as HTMLTextAreaElement
    vskFill(ta, 'строки')
    expect(ta.value).toBe('строки')
  })

  it('contenteditable → пишет текст', () => {
    document.body.innerHTML = `<div id="c" contenteditable="true"></div>`
    const el = document.getElementById('c')!
    expect(vskFill(el, 'редактируемо').ok).toBe(true)
    expect(el.textContent).toBe('редактируемо')
  })

  it('НЕ текстовое поле (кнопка) → честная ошибка, не молча', () => {
    document.body.innerHTML = `<button id="b">Жми</button>`
    const r = vskFill(document.getElementById('b')!, 'x')
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: string }).error).toContain('не текстовое поле')
  })

  // Клик/ввод по номеру используют ОДИН резолвер: протухший номер → ошибка (не ввод).
  it('ввод по устаревшему номеру не проходит (резолвер тот же)', () => {
    document.body.innerHTML = `<input>`
    vskSnapshot('g1')
    document.documentElement.removeAttribute(VSK_GEN_ATTR)  // навигация
    const r = vskResolveNumbered(1)
    expect(r.ok).toBe(false)  // до vskFill дело не дойдёт — честная ошибка резолвера
  })
})

describe('vskMatchTarget — ожидание элемента (browser_wait_for)', () => {
  it('находит по CSS-селектору', () => {
    document.body.innerHTML = `<div class="loaded">готово</div>`
    expect(vskMatchTarget('.loaded')).toBe(true)
    expect(vskMatchTarget('.missing')).toBe(false)
  })

  it('находит по видимому тексту (когда селектор не подошёл)', () => {
    document.body.innerHTML = `<button>Оформить заказ</button>`
    expect(vskMatchTarget('Оформить заказ')).toBe(true)
    expect(vskMatchTarget('Отменить')).toBe(false)
  })

  it('пустой запрос → false, невалидный селектор не бросает', () => {
    document.body.innerHTML = `<div>текст</div>`
    expect(vskMatchTarget('')).toBe(false)
    expect(vskMatchTarget(':::нелепый:::')).toBe(false)  // не бросок — вернёт false
  })
})

// Домашняя страница стала about:blank (02.08, после 2.4.0): вкладка «Браузер»
// открывается пустой, как browser-панель Claude Code, а не на Google. Пустой DOM —
// штатный вход, а не край: инструменты обязаны реагировать ОСМЫСЛЕННО, а не падать.
describe('about:blank — пустая страница: инструменты не падают, отвечают осмысленно', () => {
  it('снимок пустого тела → count 0, список пуст, поколение помечено (не бросок)', () => {
    document.body.innerHTML = ''  // about:blank: <body> пустой
    const snap = vskSnapshot('g0')
    expect(snap.count).toBe(0)
    expect(snap.elements).toEqual([])
    expect(document.documentElement.getAttribute(VSK_GEN_ATTR)).toBe('g0')
  })

  it('клик/ввод по номеру на пустой странице → честная ошибка «сделай снимок», не действие наугад', () => {
    document.body.innerHTML = ''
    vskSnapshot('g0')                       // снимок есть, но элементов нет
    const r = vskResolveNumbered(1)         // общий резолвер клика И ввода по номеру
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: string }).error).toContain('№1')
  })

  it('ожидание любого элемента на пустой странице → false (не бросок, не зависание)', () => {
    document.body.innerHTML = ''
    expect(vskMatchTarget('button')).toBe(false)
    expect(vskMatchTarget('готово')).toBe(false)
  })

  // browser_navigate уводит с about:blank как обычно: новый документ с контентом →
  // новое поколение → инструменты снова работают в полную силу.
  it('уход с about:blank на страницу с контентом → снимок и номер снова работают', () => {
    document.body.innerHTML = ''
    vskSnapshot('g0')
    expect(vskResolveNumbered(1).ok).toBe(false)  // на blank номеров нет
    // «Навигация»: пришла реальная страница, новое поколение.
    document.body.innerHTML = `<button>Оформить</button>`
    const snap = vskSnapshot('g1')
    expect(snap.count).toBe(1)
    const r = vskResolveNumbered(1)
    expect(r.ok).toBe(true)
    expect((r as { ok: true; el: Element }).el.textContent).toBe('Оформить')
  })
})
