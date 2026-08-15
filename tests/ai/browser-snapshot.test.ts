// @vitest-environment jsdom
//
// VSK-BROWSER-B1 этап 1: ядро структурного снимка с нумерацией + клик по номеру.
// Прогоняется в jsdom — тот же исходник, что инжектится в страницу (§3.1).
import { describe, it, expect, beforeEach } from 'vitest'
import { vskSnapshot, vskResolveNumbered, vskFill, vskMatchTarget, vskFind, vskCapSnapshot, VSK_SNAPSHOT_TOP_N, VSK_GEN_ATTR, VSK_EL_ATTR } from '../../shared/browser-snapshot'

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

// VSK-BROWSER-B2: browser_find — ОСНОВНОЙ способ адресации (замер 02.08: экономит
// 91–99% против полного снимка). Ищет по снятому снимку, отдаёт совпадения с ИХ
// номерами — годными для клика/ввода через ТОТ ЖЕ vskResolveNumbered (второго нет).
describe('vskFind — поиск элементов по запросу (основной путь адресации)', () => {
  it('находит по видимой подписи → совпадение с номером, годным для клика (тот же резолвер)', () => {
    document.body.innerHTML = `
      <a href="/x">Открыть</a>
      <button>Сохранить черновик</button>
      <button>Отправить</button>`
    const snap = vskSnapshot('g1')
    const r = vskFind(snap, 'сохранить', 10)
    expect(r.count).toBe(1)
    expect(r.matches[0].name).toBe('Сохранить черновик')
    // Номер совпадения адресуется тем же резолвером — без второго резолвера (требование).
    const resolved = vskResolveNumbered(r.matches[0].n)
    expect(resolved.ok).toBe(true)
    expect((resolved as { ok: true; el: Element }).el.textContent).toBe('Сохранить черновик')
  })

  it('находит по роли (link) — несколько совпадений', () => {
    document.body.innerHTML = `<a href="/a">A</a><a href="/b">B</a><button>C</button>`
    const snap = vskSnapshot('g1')
    const r = vskFind(snap, 'link', 10)
    expect(r.count).toBe(2)
    expect(r.matches.every(m => m.role === 'link')).toBe(true)
  })

  it('ничего не нашлось → честный пустой результат с подсказкой сделать снимок (не молчание)', () => {
    document.body.innerHTML = `<button>Сохранить</button>`
    const snap = vskSnapshot('g1')
    const r = vskFind(snap, 'оплатить', 10)
    expect(r.count).toBe(0)
    expect(r.matches).toEqual([])
    expect(r.hint).toContain('browser_snapshot')
  })

  it('пустой запрос → 0 совпадений + подсказка, не бросок', () => {
    document.body.innerHTML = `<button>Сохранить</button>`
    const snap = vskSnapshot('g1')
    const r = vskFind(snap, '   ', 10)
    expect(r.count).toBe(0)
    expect(r.hint).toBeTruthy()
  })

  it('совпадений больше лимита → truncated + отдаём ровно limit, totalHits честный', () => {
    document.body.innerHTML = Array.from({ length: 8 }, (_, i) => `<button>Пункт ${i}</button>`).join('')
    const snap = vskSnapshot('g1')
    const r = vskFind(snap, 'пункт', 3)
    expect(r.count).toBe(3)
    expect(r.totalHits).toBe(8)
    expect(r.truncated).toBe(true)
  })

  it('ранжирование: навигационная ссылка ВЫШЕ поля-фильтра, хотя в DOM ниже', () => {
    // Классический промах: query совпадает и с полем поиска, и с пунктом навигации.
    // Модели почти всегда нужен переход, а не фильтр — ссылка обязана быть первой.
    document.body.innerHTML = `
      <input type="text" placeholder="Поиск по каталогу">
      <a href="/catalog">Каталог</a>`
    const snap = vskSnapshot('g1')
    const r = vskFind(snap, 'каталог', 10)
    expect(r.count).toBe(2)
    expect(r.matches[0].role).toBe('link')
    expect(r.matches[0].name).toBe('Каталог')
    expect(r.matches[1].role).toBe('textbox')
  })

  it('ранжирование: точное совпадение имени выше частичного (стабильно к DOM-порядку)', () => {
    document.body.innerHTML = `<button>Сохранить как черновик</button><button>Сохранить</button>`
    const snap = vskSnapshot('g1')
    const r = vskFind(snap, 'сохранить', 10)
    expect(r.matches[0].name).toBe('Сохранить')             // точное — первым
    expect(r.matches[1].name).toBe('Сохранить как черновик')
  })

  it('ранжирование стабильно: равный вес → сохраняется порядок DOM', () => {
    document.body.innerHTML = `<a href="/a">Раздел A</a><a href="/b">Раздел B</a><a href="/c">Раздел C</a>`
    const snap = vskSnapshot('g1')
    const r = vskFind(snap, 'раздел', 10)
    expect(r.matches.map(m => m.name)).toEqual(['Раздел A', 'Раздел B', 'Раздел C'])
  })
})

describe('vskCapSnapshot — top-N выдачи, но нумерация в DOM полная', () => {
  it('элементов больше N → truncated, shown=N, но элемент за пределами N ВСЁ РАВНО кликается', () => {
    document.body.innerHTML = Array.from({ length: 200 }, (_, i) => `<button>Кнопка ${i}</button>`).join('')
    const snap = vskSnapshot('g1')     // нумерует ВСЕ 200
    const capped = vskCapSnapshot(snap, VSK_SNAPSHOT_TOP_N)
    expect(snap.count).toBe(200)
    expect(capped.count).toBe(200)     // всего честно
    expect(capped.shown).toBe(VSK_SNAPSHOT_TOP_N)     // отдали top-N
    expect(capped.truncated).toBe(true)
    expect(capped.elements.length).toBe(VSK_SNAPSHOT_TOP_N)
    // Ключевое: элемент №180 не в выдаче, но в DOM пронумерован → резолвится (find/клик достанут).
    const r = vskResolveNumbered(180)
    expect(r.ok).toBe(true)
    expect((r as { ok: true; el: Element }).el.textContent).toBe('Кнопка 179')
  })

  // P3 кусок 2 (15.08): понижение порога со 150 до 50 опирается на утверждение
  // «цель за пределами карты не потеряна — её находит find». Утверждение обязано
  // быть проверяемым, иначе обоснование порога держится на словах: замер показал
  // реальные цели на рангах 135 и 152 (переключатель темы и результаты MDN).
  it('find видит цель ЗА пределами top-N — обрезается выдача снимка, не поиск', () => {
    document.body.innerHTML = Array.from({ length: 200 }, (_, i) =>
      `<button>${i === 179 ? 'Переключить тему' : `Кнопка ${i}`}</button>`).join('')
    const snap = vskSnapshot('g1')
    const capped = vskCapSnapshot(snap, VSK_SNAPSHOT_TOP_N)
    // В карте цели нет — она за порогом.
    expect(capped.elements.some(e => e.name === 'Переключить тему')).toBe(false)
    // Но find её находит, и по её номеру элемент резолвится (значит клик дойдёт).
    const r = vskFind(snap, 'переключить тему', 30)
    expect(r.matches.length).toBe(1)
    expect(r.matches[0].n).toBe(180)
    expect(r.matches[0].n).toBeGreaterThan(VSK_SNAPSHOT_TOP_N)
    expect(vskResolveNumbered(r.matches[0].n).ok).toBe(true)
  })

  it('элементов ≤ N → truncated=false, показаны все', () => {
    document.body.innerHTML = `<button>A</button><button>B</button>`
    const snap = vskSnapshot('g1')
    const capped = vskCapSnapshot(snap, VSK_SNAPSHOT_TOP_N)
    expect(capped.truncated).toBe(false)
    expect(capped.shown).toBe(2)
  })
})
