// @vitest-environment jsdom
//
// P3 кусок 2 (13.08). ДЕФЕКТ: страница просит «Нажмите на иконку поиска», а иконки
// НЕТ в снимке — ни одно звено её цепочки не попадает в селектор интерактивных
// элементов (`a[href],button,input,…,[onclick]`). Агент не мог нажать то, о чём
// его просят, и честно упёрся (живая приёмка Павла 10.08, сценарий Хабра).
//
// ПОЧЕМУ ЭТА ФИКСТУРА, А НЕ ПРИДУМАННАЯ. Соседний пин `browser-iconic-controls`
// описывает форму Хабра как `<button type=submit><svg>` — такой кнопки на Хабре
// НЕТ. Разметка ниже снята с живой страницы 13.08.2026
// (`habr.com/ru/search/?q=ai агенты&target_type=posts&order=relevance`,
// `form.search`.outerHTML) и сокращена только по длине: submit-инпут действительно
// `hidden`, кликабельна ровно `span.tm-svg-icon__wrapper`. §3.1: тест, чья фикстура
// не совпадает с продовой формой, не защищает ничего и не сообщает об этом.
//
// ЧТО ИЗМЕРЕНО ЖИВЬЁМ (числа, не рассуждения):
//  · синтетический `span.click()` по этой обёртке: 539 → 17102 символа, заглушка
//    исчезает, приходят настоящие заголовки статей, навигации нет;
//  · наш `Enter` уходит в `requestSubmit()`, Хабр событие submit НЕ отменяет
//    (submitSeen=true, defaultPrevented=false) → полная навигация → та же заглушка.
// Значит единственная рабочая дверь — клик по иконке, и она должна быть в снимке.
import { describe, it, expect, beforeEach } from 'vitest'
import { vskSnapshot, vskFind, vskResolveNumbered } from '../../shared/browser-snapshot'

beforeEach(() => { document.body.innerHTML = '' })

/** Правило, дающее обёртке иконки cursor:pointer (на Хабре — из класса, не инлайном). */
const HABR_CSS = `<style>
  .tm-svg-icon__wrapper { cursor: pointer }
  .tm-header-user-menu__item { cursor: pointer }
</style>`

/** Форма поиска Хабра — как она есть в проде (снято 13.08.2026). */
const HABR_SEARCH_FORM = `
  <form action="/ru/search/" class="search" method="GET">
    <div class="tm-input-text-decorated tm-input-text-decorated_has-label-after input" name="q" placeholder="Поиск">
      <input class="input tm-input-text-decorated__input" name="q" placeholder="Поиск" value="ai агенты">
      <div class="tm-input-text-decorated__label tm-input-text-decorated__label_after">
        <span class="tm-svg-icon__wrapper icon">
          <svg class="tm-svg-img tm-svg-icon" height="16" width="16"><title>Поиск</title><use href="#input-search"></use></svg>
        </span>
      </div>
    </div>
    <input name="target_type" type="hidden" value="posts">
    <input hidden type="submit">
  </form>`

describe('P3: кликабельный контрол без семантики (иконка Хабра)', () => {
  it('иконка поиска ПОПАДАЕТ в снимок и подписана «Поиск»', () => {
    document.body.innerHTML = HABR_CSS + HABR_SEARCH_FORM
    const snap = vskSnapshot('g1')

    // Поле ввода в снимке было и раньше — оно не спасало: ввод без отправки бесполезен.
    const field = snap.elements.find(e => e.tag === 'input' && e.role === 'textbox')
    expect(field, 'поле ввода пропало из снимка — это регресс').toBeTruthy()

    const icon = snap.elements.find(e => e.tag !== 'input' && /поиск/i.test(e.name))
    expect(icon, 'иконки поиска нет в снимке — нажать не на что').toBeTruthy()
    expect(icon!.name).toMatch(/поиск/i)
  })

  it('ПРИЁМКА: иконка находится через find по своей подписи', () => {
    // Запрос ровно тот, которым думает модель на этой странице: заглушка говорит
    // «Нажмите на иконку ПОИСКА», подпись иконки — «Поиск».
    //
    // Чего этот пин СОЗНАТЕЛЬНО НЕ утверждает: что find понимает морфологию
    // («найти», «искать» → «Поиск»). Он её не понимает НИ ДЛЯ ОДНОГО элемента —
    // это отдельное свойство поиска по снимку, а не следствие этого дефекта.
    // Утверждать его здесь значило бы чинить не то, на чём споткнулась приёмка.
    document.body.innerHTML = HABR_CSS + HABR_SEARCH_FORM
    const snap = vskSnapshot('g1')

    const r = vskFind(snap, 'поиск', 10)
    const hit = r.matches.find(m => m.tag !== 'input' && /поиск/i.test(m.name))
    expect(hit, '«поиск» не находит иконку поиска').toBeTruthy()
    expect(hit!.role).toBe('button')
  })

  it('номер иконки разрешается в элемент, по которому МОЖНО кликнуть', () => {
    // Живой замер: у SVGElement нет .click() («target.click is not a function»).
    // Номер обязан указывать на HTML-обёртку, иначе клик упадёт в рантайме.
    document.body.innerHTML = HABR_CSS + HABR_SEARCH_FORM
    const snap = vskSnapshot('g1')
    const icon = snap.elements.find(e => e.tag !== 'input' && /поиск/i.test(e.name))!

    const r = vskResolveNumbered(icon.n)
    expect(r.ok, 'номер иконки не разрешается в элемент').toBe(true)
    if (r.ok) {
      expect(typeof (r.el as HTMLElement).click).toBe('function')
      expect(r.el.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
    }
  })
})

describe('P3: контрольные случаи — снимок не должен распухнуть', () => {
  it('обычный div без pointer в снимок НЕ попадает', () => {
    // Зеркальный кейс к первому: без него «иконка нашлась» ничего не измеряет —
    // нумерация всего подряд тоже дала бы зелёный (§3.1, контрольный кейс рядом).
    document.body.innerHTML = `<div id="plain">просто текст</div><p>абзац</p>`
    const snap = vskSnapshot('g2')
    expect(snap.count, 'непокликиваемая разметка попала в снимок').toBe(0)
  })

  it('pointer-контейнер со ссылкой внутри не даёт ВТОРОГО номера', () => {
    // Карточка-плитка (весь блок pointer) и ссылка внутри — это ОДНО действие.
    // Два номера на него означали бы удвоение снимка на любой витрине.
    document.body.innerHTML = `<style>.card{cursor:pointer}</style>
      <div class="card"><a href="/item/1">Товар</a></div>`
    const snap = vskSnapshot('g3')
    expect(snap.count).toBe(1)
    expect(snap.elements[0].tag).toBe('a')
  })

  it('наследованный pointer не нумерует потомков по отдельности', () => {
    // cursor наследуется: у детей pointer-обёртки он тоже pointer. Нумеруется
    // только внешний элемент, иначе одна иконка даёт номер каждому своему предку.
    document.body.innerHTML = `<style>.btn{cursor:pointer}</style>
      <span class="btn"><span class="inner"><svg><title>Отправить</title></svg></span></span>`
    const snap = vskSnapshot('g4')
    expect(snap.count).toBe(1)
    expect(snap.elements[0].name).toMatch(/отправить/i)
  })

  it('скрытый pointer-элемент в снимок не попадает', () => {
    document.body.innerHTML = `<style>.btn{cursor:pointer}</style>
      <span class="btn" style="display:none"><svg><title>Невидимка</title></svg></span>`
    const snap = vskSnapshot('g5')
    expect(snap.count).toBe(0)
  })

  it('ГРАНИЦА ПО ЗАМЕРУ: pointer-элемент с текстом (не иконка) номера не получает', () => {
    // Это сознательная граница, а не недосмотр. Замер на живых страницах: правило
    // «любой pointer-элемент» дало на ленте Хабра 310 лишних номеров и +70 мс на
    // снимок, выдавливая настоящие контролы из top-N. Класс дефекта — контрол,
    // у которого подпись только иконка; текстовые псевдо-кнопки без семантики
    // остаются НЕ покрытыми, и это записано как хвост, а не как «покрыли всё».
    document.body.innerHTML = `<style>.pseudo{cursor:pointer}</style>
      <div class="pseudo"><span>Показать ещё</span></div>`
    const snap = vskSnapshot('g6')
    expect(snap.count).toBe(0)
  })
})
