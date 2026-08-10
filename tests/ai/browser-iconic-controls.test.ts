// @vitest-environment jsdom
//
// Д5 (приёмка браузера 10.08): снимок не отдаёт кнопку без текстовой подписи.
// Слова агента: «иконка-лупа … в снапшотах не отдаётся как отдельный кликабельный
// элемент» — адресоваться было нечем, при том что browser_find объявлен ОСНОВНЫМ
// путём адресации. Вместе с известным ограничением browser_read_page (только
// innerText) это давало: модель не может опознать управляющий элемент, у которого
// нет текстовой подписи.
//
// Приёмка постановки: кнопка отправки формы без текста (svg-иконка) находится
// через find. Прогоняется в jsdom — тот же исходник, что инжектится в страницу.
import { describe, it, expect, beforeEach } from 'vitest'
import { vskSnapshot, vskFind } from '../../shared/browser-snapshot'

beforeEach(() => { document.body.innerHTML = '' })

/** Форма поиска Хабра в том виде, в каком она сломала приёмку: submit — svg-иконка. */
const HABR_SEARCH_FORM = `
  <form action="/ru/search/">
    <input type="text" name="q" placeholder="Поиск">
    <button type="submit"><svg viewBox="0 0 24 24"><path d="M10 2a8 8 0"/></svg></button>
  </form>`

describe('Д5: управляющий элемент без текстовой подписи', () => {
  it('кнопка отправки с svg-иконкой ПОПАДАЕТ в снимок и различима по роли', () => {
    document.body.innerHTML = HABR_SEARCH_FORM
    const snap = vskSnapshot('g1')

    const submit = snap.elements.find(e => e.tag === 'button')
    expect(submit, 'submit-кнопка не попала в снимок').toBeTruthy()
    // Роль отличает её от обычной кнопки: у неё нет подписи, и единственное, чем
    // модель может её опознать, — назначение.
    expect(submit!.role).toBe('submit')
  })

  it('ПРИЁМКА: кнопка находится через find по естественному запросу', () => {
    document.body.innerHTML = HABR_SEARCH_FORM
    const snap = vskSnapshot('g1')

    // Модель ищет тем словом, которым думает о задаче, — не «submit» и не «button».
    for (const query of ['отправить', 'поиск', 'найти', 'submit', 'искать']) {
      const r = vskFind(snap, query, 10)
      const found = r.matches.find(m => m.role === 'submit')
      expect(found, `«${query}» не находит кнопку отправки формы`).toBeTruthy()
    }
  })

  it('у кнопки без подписи есть понятное имя вместо пустого места', () => {
    // Пустое имя в снимке модель прочитать не может: элемент есть, а сказать о
    // нём нечего. Подпись синтетическая и честная — она называет назначение.
    document.body.innerHTML = HABR_SEARCH_FORM
    const snap = vskSnapshot('g1')

    const submit = snap.elements.find(e => e.role === 'submit')!
    expect(submit.name.length).toBeGreaterThan(0)
    expect(submit.name).toMatch(/отправ/i)
  })

  it('подпись из <svg><title> и aria-labelledby читается как обычная', () => {
    // Два распространённых способа подписать иконку, которых nameOf не знал.
    document.body.innerHTML = `
      <span id="lbl">Открыть корзину</span>
      <button aria-labelledby="lbl"><svg></svg></button>
      <button><svg><title>Показать фильтры</title></svg></button>`
    const snap = vskSnapshot('g1')

    expect(snap.elements[0].name).toBe('Открыть корзину')
    expect(snap.elements[1].name).toBe('Показать фильтры')
  })

  it('КОНТРОЛЬ: у кнопки с текстом подпись и роль прежние — синтетика не подменяет', () => {
    // Иначе «починка» переписала бы имена всех кнопок и сломала адресацию по
    // тексту, ради которой find и существует.
    document.body.innerHTML = `<form><button type="submit">Отправить заявку</button></form>`
    const snap = vskSnapshot('g1')

    expect(snap.elements[0].name).toBe('Отправить заявку')
    expect(snap.elements[0].role, 'кнопка с подписью остаётся обычной кнопкой').toBe('button')
  })

  it('КОНТРОЛЬ: роль submit не выдаётся кнопке вне формы', () => {
    // Кнопка-иконка вне формы (меню, «закрыть») ничего не отправляет, и называть
    // её кнопкой отправки — врать модели ровно так же, как молчать о ней.
    document.body.innerHTML = `<button><svg></svg></button>`
    const snap = vskSnapshot('g1')

    expect(snap.elements[0].role).toBe('button')
  })

  it('КОНТРОЛЬ: поиск по подписи не начал находить лишнее', () => {
    // Синонимы роли не должны сделать find всеядным: запрос «оплатить» на форме
    // поиска обязан вернуть пусто с подсказкой, как и раньше.
    document.body.innerHTML = HABR_SEARCH_FORM
    const snap = vskSnapshot('g1')

    const r = vskFind(snap, 'оплатить', 10)
    expect(r.count).toBe(0)
    expect(r.hint).toContain('browser_snapshot')
  })
})
