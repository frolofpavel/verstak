// @vitest-environment jsdom
//
// B1 (пакет 2.5.0, 10.08): снимок заходит в shadow DOM и same-origin iframe.
//
// ДЕФЕКТ. В browser-snapshot не было ни одного упоминания shadowRoot/iframe:
// страницы на веб-компонентах (Битрикс24) и с фреймами (Я.Директ) отдавали
// снимок БЕЗ своих настоящих элементов управления — кнопка есть на экране,
// а для инструментов её не существует.
//
// ЗАКРЕПЛЕНО. (1) кнопка внутри shadowRoot нумеруется, находится через find и
// резолвится тем же vskResolveNumbered; (2) кнопка внутри iframe — так же;
// (3) КОНТРОЛЬ: обычная страница без shadow/iframe даёт байт-в-байт тот же
// снимок, что и до правки (анти-регрессия); (4) рекурсия ограничена и потолок
// оставляет след truncatedByBudget — молчаливый потолок неотличим от «покрыли всё».
import { describe, it, expect, beforeEach } from 'vitest'
import { vskSnapshot, vskResolveNumbered, vskFind, VSK_GEN_ATTR } from '../../shared/browser-snapshot'

beforeEach(() => {
  document.documentElement.removeAttribute(VSK_GEN_ATTR)
  document.body.innerHTML = ''
})

describe('B1: shadow DOM в снимке', () => {
  it('кнопка внутри shadowRoot нумеруется, находится find и резолвится по номеру', () => {
    document.body.innerHTML = `<button>Обычная</button><div id="host"></div>`
    const shadow = document.getElementById('host')!.attachShadow({ mode: 'open' })
    shadow.innerHTML = `<button>Внутри тени</button>`

    const snap = vskSnapshot('g1')
    expect(snap.count).toBe(2)
    expect(snap.elements.map(e => e.name)).toEqual(['Обычная', 'Внутри тени'])

    const found = vskFind(snap, 'внутри тени', 10)
    expect(found.count).toBe(1)
    const r = vskResolveNumbered(found.matches[0].n)
    expect(r.ok, 'снимок видит кнопку в тени, а клик по номеру её не находит — фича декоративна').toBe(true)
    expect((r as { ok: true; el: Element }).el.textContent).toBe('Внутри тени')
  })

  it('вложенный shadow (тень в тени) тоже в снимке', () => {
    document.body.innerHTML = `<div id="h1"></div>`
    const s1 = document.getElementById('h1')!.attachShadow({ mode: 'open' })
    s1.innerHTML = `<div id="h2"></div>`
    const s2 = (s1.getElementById('h2') as HTMLElement).attachShadow({ mode: 'open' })
    s2.innerHTML = `<button>Глубокая</button>`
    const snap = vskSnapshot('g1')
    expect(snap.elements.map(e => e.name)).toContain('Глубокая')
    expect(snap.truncatedByBudget).toBeUndefined()
  })
})

describe('B1: iframe в снимке', () => {
  it('кнопка внутри same-origin iframe нумеруется и резолвится по номеру', () => {
    document.body.innerHTML = `<button>Снаружи</button><iframe id="fr"></iframe>`
    const fr = document.getElementById('fr') as HTMLIFrameElement
    fr.contentDocument!.body.innerHTML = `<button>Во фрейме</button>`

    const snap = vskSnapshot('g1')
    expect(snap.elements.map(e => e.name)).toEqual(['Снаружи', 'Во фрейме'])

    const found = vskFind(snap, 'во фрейме', 10)
    expect(found.count).toBe(1)
    const r = vskResolveNumbered(found.matches[0].n)
    expect(r.ok).toBe(true)
    expect((r as { ok: true; el: Element }).el.textContent).toBe('Во фрейме')
  })
})

describe('B1: контроль анти-регрессии — обычная страница', () => {
  // Байт-в-байт снимок обычной страницы, каким его отдавала реализация ДО B1:
  // ни новых полей, ни изменения порядка. Литерал — форма старого выхода.
  it('страница без shadow/iframe даёт байт-в-байт прежний снимок', () => {
    document.body.innerHTML = `<a href="/x">Открыть</a><button>Сохранить</button><input type="text" aria-label="Имя">`
    const json = JSON.stringify(vskSnapshot('gb'))
    expect(json).toBe(
      '{"gen":"gb","count":3,"elements":['
      + '{"n":1,"tag":"a","role":"link","name":"Открыть"},'
      + '{"n":2,"tag":"button","role":"button","name":"Сохранить"},'
      + '{"n":3,"tag":"input","role":"textbox","name":"Имя"}]}'
    )
  })
})

describe('B1: бюджет рекурсии оставляет след', () => {
  it('тень глубже лимита → элемент не в снимке, но truncatedByBudget=true (не молчание)', () => {
    // Цепочка из 7 вложенных shadow root — глубже MAX_DEPTH (6).
    document.body.innerHTML = `<button>Мелкая</button><div id="h0"></div>`
    let host: HTMLElement = document.getElementById('h0')!
    let shadow = host.attachShadow({ mode: 'open' })
    for (let i = 1; i < 7; i++) {
      shadow.innerHTML = `<div id="h${i}"></div>`
      host = shadow.getElementById(`h${i}`) as HTMLElement
      shadow = host.attachShadow({ mode: 'open' })
    }
    shadow.innerHTML = `<button>Слишком глубокая</button>`

    const snap = vskSnapshot('g1')
    expect(snap.elements.map(e => e.name)).toContain('Мелкая')
    expect(snap.elements.map(e => e.name)).not.toContain('Слишком глубокая')
    expect(snap.truncatedByBudget, 'потолок сработал молча — срез неотличим от «покрыли всё»').toBe(true)
  })
})
