/**
 * VSK-BROWSER-B1 этап 1: структурное видение страницы с ПРОНУМЕРОВАННЫМИ элементами
 * и клик по номеру. Живёт в shared/ — импортируется ОБОИМИ слоями: renderer
 * (BrowserView инжектит функции в webview через executeJavaScript(`(${fn})(...)`)) и
 * тесты (jsdom прогоняет ТОТ ЖЕ исходник — иначе пин стерёг бы копию, а не
 * инжектируемый код; CLAUDE.md §3.1).
 *
 * ТРЕБОВАНИЕ №1 (постановщик): номера ПРОТУХАЮТ после навигации. Реализовано без
 * отдельного реестра: снимок ставит поколение на <html data-vsk-gen> и метит
 * элементы data-vsk-el="<gen>:<n>". Навигация грузит новый документ → атрибутов нет
 * → клик по номеру возвращает ЧЕСТНУЮ ошибку «сделай новый снимок», а не кликает
 * наугад. Новый снимок меняет поколение → номера прежнего снимка перестают
 * находиться. Ошибка направлена в сторону молчания, не ложного действия.
 *
 * САМОДОСТАТОЧНОСТЬ: vskSnapshot/vskResolveNumbered используют ТОЛЬКО DOM-глобали и
 * СТРОКОВЫЕ ЛИТЕРАЛЫ имён атрибутов (не модульные константы) — иначе .toString() увёз
 * бы в страницу ссылку на неопределённый символ. Экспортируемые константы —
 * зеркало литералов, для кода на стороне Node (тесты/хендлер).
 */

export const VSK_GEN_ATTR = 'data-vsk-gen'
export const VSK_EL_ATTR = 'data-vsk-el'

/** Один пронумерованный элемент снимка (сериализуемо — DOM-ссылок наружу нет). */
export interface SnapshotElement {
  n: number
  tag: string
  /** Грубая роль: link/button/textbox/checkbox/... — по тегу/типу/role. */
  role: string
  /** Видимая подпись (текст/значение/aria-label/placeholder), обрезана. */
  name: string
}

export interface PageSnapshot {
  gen: string
  count: number
  elements: SnapshotElement[]
  /** B1: рекурсия по shadow DOM/iframe упёрлась в бюджет (глубина/узлы/элементы) —
   *  часть страницы НЕ вошла в снимок. След обязателен: молчаливый потолок
   *  неотличим от «покрыли всё» (§3.1, урок про фолбэки). Отсутствует на страницах,
   *  где бюджеты не тронуты, — снимок обычной страницы байт-в-байт прежний. */
  truncatedByBudget?: boolean
}

/**
 * Снять снимок: пометить интерактивные видимые элементы номерами, вернуть список.
 * Исполняется в странице. `gen` передаётся снаружи (в тестах — фикс, в проде — нонс
 * вызывающего), чтобы функция оставалась детерминированной и самодостаточной.
 */
export function vskSnapshot(gen: string): PageSnapshot {
  const INTERACTIVE = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[onclick],[contenteditable=true],summary'
  const CLAMP = 120

  function isHidden(el: Element): boolean {
    let node: Element | null = el
    while (node && node.nodeType === 1) {
      const h = node as HTMLElement
      if (h.hasAttribute('hidden')) return true
      if (h.getAttribute('aria-hidden') === 'true') return true
      const st = h.style
      if (st && (st.display === 'none' || st.visibility === 'hidden')) return true
      try {
        const view = el.ownerDocument.defaultView || globalThis
        const cs = view.getComputedStyle ? view.getComputedStyle(h) : null
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return true
      } catch { /* нет getComputedStyle — полагаемся на атрибуты/inline */ }
      node = node.parentElement
    }
    return false
  }

  // Д5: подпись элемента. Порядок прежний, но добавлены два источника, которыми
  // реально подписывают ИКОНКИ: aria-labelledby (текст лежит в другом узле) и
  // <svg><title> (единственная подпись у svg-кнопки). Без них кнопка-лупа имела
  // пустое имя, то есть в снимке была и адресоваться ею было нечем.
  function nameOf(el: Element): string {
    const h = el as HTMLElement
    let labelled = ''
    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const parts: string[] = []
      for (const id of by.split(/\s+/)) {
        const node = id ? el.ownerDocument.getElementById(id) : null
        if (node) parts.push((node as HTMLElement).innerText || node.textContent || '')
      }
      labelled = parts.join(' ')
    }
    const svgTitle = el.querySelector ? el.querySelector('svg title') : null
    const raw = (el.getAttribute('aria-label')
      || labelled
      || (el as HTMLInputElement).value
      || h.innerText
      || el.textContent
      || el.getAttribute('placeholder')
      || el.getAttribute('title')
      || el.getAttribute('alt')
      || (svgTitle ? svgTitle.textContent : '')
      || '').replace(/\s+/g, ' ').trim()
    return raw.length > CLAMP ? raw.slice(0, CLAMP) + '…' : raw
  }

  // Д5: отправляет ли этот элемент форму. Отдельная роль нужна ровно тем
  // элементам, у которых НЕТ подписи: опознать их можно только по назначению.
  // Кнопка с текстом остаётся обычной кнопкой — иначе адресация по тексту, ради
  // которой find и существует, поехала бы у всех форм разом.
  function submitsForm(el: Element): boolean {
    const tag = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') || '').toLowerCase()
    if (tag === 'input') return type === 'submit' || type === 'image'
    if (tag !== 'button') return false
    if (type && type !== 'submit') return false
    // Кнопка без type внутри формы по стандарту HTML тоже submit.
    return Boolean((el as HTMLButtonElement).form || (el.closest ? el.closest('form') : null))
  }

  function roleOf(el: Element): string {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button' || tag === 'summary') {
      return (tag === 'button' && !nameOf(el) && submitsForm(el)) ? 'submit' : 'button'
    }
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase()
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      if (t === 'submit' || t === 'image') return nameOf(el) ? 'button' : 'submit'
      if (t === 'button') return 'button'
      return 'textbox'
    }
    if (el.getAttribute('contenteditable') === 'true') return 'textbox'
    return 'button'
  }

  // B1 (10.08): снимок заходит в shadow DOM и same-origin iframe — иначе Битрикс24
  // и Я.Директ (веб-компоненты, фреймы) для инструментов пустые. Рекурсия жёстко
  // ограничена: снимок дорог ровно там, где shadow/iframe обильны, а потолок без
  // следа неотличим от «покрыли всё» — поэтому при ЛЮБОМ срезе ставится
  // truncatedByBudget. Cross-origin iframe недоступен по построению (contentDocument
  // бросает/null) — пропускается честно, без падения. Числа — границы безопасности,
  // не тюнинг: глубина вложенности реальных страниц ≤3, элементов и узлов — с
  // запасом над замером B2 (M.Video-каталог: 1091 интерактивный элемент).
  // P3 (13.08): КЛИКАБЕЛЬНОЕ БЕЗ СЕМАНТИКИ. Живая приёмка Хабра уперлась в то, что
  // страница просит «Нажмите на иконку поиска», а иконки в снимке нет: она —
  // `span.tm-svg-icon__wrapper > svg`, и НИ ОДНО звено её цепочки не подходит под
  // INTERACTIVE (не ссылка, не кнопка, роли нет, обработчик повешен Vue через
  // addEventListener — значит и `[onclick]` мимо). Замерено на живой странице:
  // синтетический click по этой обёртке даёт 539 → 17102 символа и настоящие
  // заголовки. То есть дверь была одна, и она не была видна.
  //
  // Признак берём тот же, по которому клик опознаёт ЧЕЛОВЕК, — курсор-указатель.
  // Это не эвристика «на всякий случай»: страница сама объявляет им кликабельность.
  //
  // ГРАНИЦЫ СНЯТЫ ЗАМЕРОМ, А НЕ НА ГЛАЗ. Первая редакция брала ЛЮБОЙ pointer-элемент
  // и на ленте Хабра дала 310 лишних номеров при +70 мс на снимок (Википедия +92 мс,
  // каталог М.Видео +130 мс) — снимок распухал, настоящие контролы выдавливались из
  // top-N. Сужение до ИКОНОЧНОГО контрола (маленькая обёртка вокруг img/svg — ровно
  // тот класс, на котором споткнулась приёмка) дало 21 цель и +7 мс на той же ленте,
  // Википедия +38 мс, М.Видео +23 мс. Дешёвые проверки идут ДО getComputedStyle,
  // поэтому вместе с шумом упала и цена.
  //
  // Остальные ограничения — против распухания (cursor НАСЛЕДУЕТСЯ, без них одна
  // иконка дала бы номер каждому своему предку):
  //   · только ВНЕШНИЙ элемент pointer-поддерева (у родителя курсор другой);
  //   · внутри нет настоящего контрола — тогда адресуемым остаётся он, а не обёртка;
  //   · без подписи не берём: безымянный номер модели нечем назвать в find.
  const MAX_DEPTH = 6
  const MAX_ELEMENTS = 2000
  const MAX_SCAN = 20000
  const MAX_POINTER = 300
  const XHTML = 'http://www.w3.org/1999/xhtml'
  const SKIP_TAGS = ['html', 'body', 'head', 'script', 'style', 'noscript']
  let pointerCount = 0

  function cursorOf(el: Element): string {
    try {
      const view = el.ownerDocument.defaultView || globalThis
      const cs = view.getComputedStyle ? view.getComputedStyle(el as HTMLElement) : null
      return cs ? cs.cursor : ''
    } catch { return '' }
  }

  /** Кликабелен по курсору, но не имеет семантики — иначе бы уже попал в INTERACTIVE. */
  function isPointerTarget(el: Element): boolean {
    if (el.namespaceURI !== XHTML) return false            // svg/path/use — внутренности иконки
    const tag = el.tagName ? el.tagName.toLowerCase() : ''
    if (SKIP_TAGS.indexOf(tag) !== -1) return false
    if (el.matches(INTERACTIVE)) return false              // уже пронумерован как контрол
    // Иконочная обёртка: одна-две вложенности вокруг картинки. Проверки дешёвые и
    // стоят ПЕРЕД getComputedStyle — он и есть дорогая часть обхода (замер выше).
    const kids = el.children ? el.children.length : 0
    if (kids === 0 || kids > 2) return false
    if (!el.querySelector('img,svg')) return false
    if (cursorOf(el) !== 'pointer') return false
    const parent = el.parentElement
    if (parent && cursorOf(parent) === 'pointer') return false  // не внешний в поддереве
    if (el.querySelector(INTERACTIVE)) return false        // внутри есть настоящий контрол
    return !isHidden(el)
  }

  const root = document.documentElement
  root.setAttribute('data-vsk-gen', gen)
  const elements: SnapshotElement[] = []
  let n = 0
  let scanned = 0
  let budgetHit = false
  const visit = (scope: Document | ShadowRoot, depth: number): void => {
    for (const el of Array.from(scope.querySelectorAll(INTERACTIVE))) {
      if (n >= MAX_ELEMENTS) { budgetHit = true; break }
      if (isHidden(el)) continue
      n++
      el.setAttribute('data-vsk-el', gen + ':' + n)
      const role = roleOf(el)
      // Д5: у элемента без подписи имя в снимке было ПУСТЫМ — элемент есть, а
      // сказать о нём модели нечего. Подпись синтетическая и честная: она называет
      // назначение, а не выдумывает текст, которого на странице нет.
      const name = nameOf(el) || (role === 'submit' ? '(кнопка отправки формы)' : '')
      elements.push({ n, tag: el.tagName.toLowerCase(), role, name })
    }
    // Вход в под-деревья: shadow-хосты и фреймы этого scope, в порядке DOM.
    for (const host of Array.from(scope.querySelectorAll('*'))) {
      scanned++
      if (scanned > MAX_SCAN) { budgetHit = true; return }
      // Второй класс адресуемого — кликабельное без семантики (см. выше). Идёт в тот
      // же обход, отдельного прохода по документу нет: цена снимка не удваивается.
      if (n < MAX_ELEMENTS && isPointerTarget(host)) {
        const pname = nameOf(host)
        if (pname) {
          if (pointerCount >= MAX_POINTER) budgetHit = true
          else {
            pointerCount++
            n++
            host.setAttribute('data-vsk-el', gen + ':' + n)
            elements.push({ n, tag: host.tagName.toLowerCase(), role: 'button', name: pname })
          }
        }
      }
      const sr = (host as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot
      if (sr) {
        if (depth >= MAX_DEPTH) budgetHit = true
        else visit(sr, depth + 1)
      }
      const tag = host.tagName ? host.tagName.toLowerCase() : ''
      if (tag === 'iframe' || tag === 'frame') {
        try {
          const doc = (host as HTMLIFrameElement).contentDocument
          if (doc) {
            if (depth >= MAX_DEPTH) budgetHit = true
            else visit(doc, depth + 1)
          }
        } catch { /* cross-origin — недоступен, честно пропускаем */ }
      }
    }
  }
  visit(document, 0)
  const snap: PageSnapshot = { gen, count: n, elements }
  if (budgetHit) snap.truncatedByBudget = true
  return snap
}

/** Результат разрешения номера в элемент текущего снимка. */
export type NumberedResolve =
  | { ok: true; el: Element }
  | { ok: false; error: string }

/**
 * Найти элемент по номеру ТЕКУЩЕГО снимка. Нет поколения (навигация была) или номер
 * не помечен (элемент исчез / снимок сменился) → честная ошибка, НЕ угадывание.
 * Исполняется в странице; клик/ввод делает вызывающий над el.
 */
export function vskResolveNumbered(n: number): NumberedResolve {
  const gen = document.documentElement.getAttribute('data-vsk-gen')
  if (!gen) {
    return { ok: false, error: 'Нет активного снимка страницы (после навигации номера сброшены) — сделай browser_snapshot заново.' }
  }
  // B1: номер мог быть выдан элементу внутри shadow DOM / iframe — ищем той же
  // ограниченной рекурсией, что и снимок (те же потолки, иначе снимок находит,
  // а клик «не находит», и фича декоративна).
  const SEL = '[data-vsk-el="' + gen + ':' + n + '"]'
  const MAX_DEPTH = 6
  const MAX_SCAN = 20000
  let scanned = 0
  const search = (scope: Document | ShadowRoot, depth: number): Element | null => {
    const hit = scope.querySelector(SEL)
    if (hit) return hit
    if (depth >= MAX_DEPTH) return null
    for (const host of Array.from(scope.querySelectorAll('*'))) {
      scanned++
      if (scanned > MAX_SCAN) return null
      const sr = (host as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot
      if (sr) {
        const r = search(sr, depth + 1)
        if (r) return r
      }
      const tag = host.tagName ? host.tagName.toLowerCase() : ''
      if (tag === 'iframe' || tag === 'frame') {
        try {
          const doc = (host as HTMLIFrameElement).contentDocument
          if (doc) {
            const r = search(doc, depth + 1)
            if (r) return r
          }
        } catch { /* cross-origin — недоступен */ }
      }
    }
    return null
  }
  const el = search(document, 0)
  if (!el) {
    return { ok: false, error: 'Элемент №' + n + ' не найден в текущем снимке (страница изменилась или номер устарел) — сделай browser_snapshot заново.' }
  }
  return { ok: true, el }
}

/** Результат ввода текста в элемент. */
export type FillResult = { ok: true } | { ok: false; error: string }

/**
 * Ввести текст в элемент (input/textarea/contenteditable) с событиями input/change,
 * чтобы фреймворки страницы увидели ввод. Не текстовое поле → честная ошибка.
 * Исполняется в странице над элементом от vskResolveNumbered (клик/ввод по номеру).
 * Самодостаточна (DOM + Event глобальны) — инжектится .toString().
 */
export function vskFill(el: Element, text: string): FillResult {
  const tag = el.tagName ? el.tagName.toLowerCase() : ''
  const h = el as HTMLElement
  if (tag === 'input' || tag === 'textarea') {
    if (typeof h.focus === 'function') h.focus()
    ;(el as HTMLInputElement).value = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true }
  }
  if (el.getAttribute('contenteditable') === 'true') {
    if (typeof h.focus === 'function') h.focus()
    h.textContent = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return { ok: true }
  }
  return { ok: false, error: 'Элемент не текстовое поле (input/textarea/contenteditable) — ввод невозможен. Проверь номер снимком.' }
}

// Д3 (приёмка 10.08): отправка формы. Список ЗАКРЫТЫЙ и это граница, а не
// осторожность: постановка прямо запрещает эмуляцию произвольной клавиатуры
// («не сорок мелких browser-команд»). Enter отправляет, Tab уводит фокус на
// следующее поле, Escape закрывает подсказку/оверлей — ровно то, чего не хватало,
// чтобы дойти до выдачи через UI-форму.
export const VSK_PRESS_KEYS = ['Enter', 'Tab', 'Escape'] as const
export type VskPressKey = typeof VSK_PRESS_KEYS[number]

/** Результат нажатия клавиши. */
export type PressKeyResult = { ok: true; submitted: boolean } | { ok: false; error: string }

/**
 * Нажать разрешённую клавишу по элементу: keydown → (для Enter) отправка формы →
 * keyup. Отправка идёт ТОЛЬКО если страница не отменила keydown — иначе это была
 * бы подделка нажатия, а не нажатие: обработчик страницы остаётся главным.
 *
 * Исполняется в странице над элементом от vskResolveNumbered (как vskFill).
 * Самодостаточна (DOM + KeyboardEvent глобальны) — инжектится .toString(),
 * поэтому список клавиш и коды здесь ЛИТЕРАЛЫ, а экспортируемая константа выше —
 * их зеркало для кода на стороне Node (схема инструмента, тесты).
 */
export function vskPressKey(el: Element, key: string): PressKeyResult {
  const ALLOWED: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27 }
  const code = ALLOWED[key]
  if (!code) {
    return { ok: false, error: 'Клавиша не поддерживается. Доступны только Enter, Tab и Escape — инструмент существует для отправки формы и перехода по полям, а не для произвольной клавиатуры.' }
  }
  const h = el as HTMLElement
  if (typeof h.focus === 'function') h.focus()
  const init = { key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true }
  const down = new KeyboardEvent('keydown', init)
  const notPrevented = el.dispatchEvent(down)
  let submitted = false
  if (key === 'Enter' && notPrevented) {
    // Реальный браузер отправляет форму по Enter из текстового поля. jsdom этого
    // не делает сам, поэтому воспроизводим тот же исход явно — иначе инструмент
    // «нажал», а форма стоит на месте, ровно как в дефекте.
    const form = (el as HTMLInputElement).form
      || (typeof el.closest === 'function' ? el.closest('form') : null)
    if (form) {
      const f = form as HTMLFormElement
      if (typeof f.requestSubmit === 'function') f.requestSubmit()
      else f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      submitted = true
    }
  }
  el.dispatchEvent(new KeyboardEvent('keyup', init))
  return { ok: true, submitted }
}

/**
 * Есть ли на странице цель ожидания: CSS-селектор ИЛИ видимый текст. Чистая проверка
 * ОДНОГО момента — опрос во времени делает вызывающий (BrowserView), с честным
 * таймаутом. Слепых пауз не заводим. Исполняется в странице; самодостаточна.
 */
export function vskMatchTarget(query: string): boolean {
  const q = query.trim()
  if (!q) return false
  try {
    if (document.querySelector(q)) return true
  } catch { /* не валидный селектор — пробуем как текст ниже */ }
  const needle = q.toLowerCase()
  const els = document.querySelectorAll('a,button,[role=button],input,label,h1,h2,h3,h4,span,div,p,li,td,th')
  for (const el of Array.from(els)) {
    const t = ((el as HTMLElement).innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
    if (t && t.indexOf(needle) !== -1) return true
  }
  return false
}

// VSK-BROWSER-B2: ПОРОГ top-N полного снимка.
//
// 150 → 50 по замеру P3 куска 2 (15.08, `docs/browser-token-bench-2026-08-15.md`;
// воспроизводится `npm run bench:browser-page`). Прежнее значение назначалось по
// scratchpad-замеру 03.08, который до репозитория не дошёл и потому не проверялся.
//
// ЧЕМ НАЗНАЧЕНО НОВОЕ ЧИСЛО. Решающая величина — не размер снимка сам по себе, а его
// доля в том, что РЕАЛЬНО оплачено по полной цене. У дешёвых провайдеров 79–98%
// входа покрывает prompt-кэш, поэтому полную цену платит только свежий кусок хода —
// то есть сам результат инструмента. Живые прогоны 15.08 (DeepSeek и Gateway·kimi,
// три класса страниц): на тяжёлой странице снимок — 3 333 и 3 347 токенов, это
// 41% и 46% ВСЕХ свежих токенов прогона. Обрезка до 50 оставляет от них ~989.
//
// Цена элемента измерена: 14.4–17.8 токена (шесть живых страниц), поэтому потолок —
// это прямо бюджет карты: 50 эл. ≈ 800 токенов, 150 эл. ≈ 2 400.
//
// ЧЕМ ЗА ЭТО ПЛАТИМ, ЧЕСТНО. Цели встречаются и глубже: из 21 измеренного ранга
// лучшего совпадения 76% лежат в первых 50, но переключатель темы MDN стоит на 135,
// а его же результаты поиска — на 152. Такие цели уходят из КАРТЫ, но не становятся
// недостижимыми: нумерация в СТРАНИЦЕ остаётся полной, browser_find ищет по всему
// снимку и стоит 56–444 токена (медиана 89) — одна такая доплата дешевле, чем
// 1 400–2 400 лишних токенов в каждом снимке. Запас у эталонного случая приёмки
// тонкий и назван намеренно: иконка поиска Хабра — номер 46 из 50.
//
// ПРАВИЛО ВЫБОРА ИНСТРУМЕНТА (тем же замером, токены — медиана по классам):
//   · адресоваться к элементу → browser_find (56–444; не зависит от размера
//     страницы, широкий запрос — исключение: «ноутбук» дал 70 совпадений и 1 168);
//   · нужна карта страницы → browser_snapshot, это top-50 с `truncated` и `count`;
//   · нужно содержимое → browser_read_page, НО с селектором: без него на каталоге
//     17 864 символа ≈ 4 466 токенов, вчетверо дороже снимка и вдесятеро — find.
//     В живых прогонах самым дорогим вызовом оказался именно read_page, а не снимок.
export const VSK_SNAPSHOT_TOP_N = 50

/** Обрезанный для модели вид снимка: первые topN элементов + честный `truncated`.
 *  DOM-нумерация НЕ трогается (обрезается только возвращаемый список) — поэтому
 *  vskResolveNumbered находит и элемент с номером > topN. Чистая функция. */
export interface CappedSnapshot {
  gen: string
  count: number        // всего интерактивных на странице
  shown: number        // сколько вернули (≤ topN)
  truncated: boolean   // count > topN → есть непоказанные, ищи через browser_find
  elements: SnapshotElement[]
  /** B1: след бюджета рекурсии shadow/iframe — прокидывается из PageSnapshot. */
  truncatedByBudget?: boolean
}
export function vskCapSnapshot(snap: PageSnapshot, topN: number): CappedSnapshot {
  const n = Math.max(1, topN | 0)
  const elements = snap.elements.slice(0, n)
  const out: CappedSnapshot = { gen: snap.gen, count: snap.count, shown: elements.length, truncated: snap.count > n, elements }
  if (snap.truncatedByBudget) out.truncatedByBudget = true
  return out
}

/** Результат browser_find: подходящие элементы с их НОМЕРАМИ из снимка (годны для
 *  клика/ввода через тот же vskResolveNumbered). Пустой результат несёт подсказку. */
export interface FindResult {
  query: string
  count: number        // сколько совпадений вернули (≤ limit)
  totalHits: number    // сколько всего совпало (до обрезки limit)
  total: number        // всего интерактивных на странице
  truncated: boolean   // совпадений больше, чем вернули
  matches: SnapshotElement[]
  hint?: string
}
/**
 * ОСНОВНОЙ способ адресации (замер 02.08: экономит 91–99% против полного снимка).
 * Ищет по уже снятому снимку (все элементы пронумерованы) — совпадение по видимой
 * подписи / роли / тегу. Номера совпадений — те же, что в снимке, поэтому
 * browser_click_by_number / browser_type_by_number работают без второго резолвера.
 * Ничего не нашлось → ЧЕСТНЫЙ пустой результат с подсказкой, а не молчание.
 * Чистая функция (принимает результат vskSnapshot) — тестируется в jsdom, а в
 * странице инжектится рядом с vskSnapshot.
 */
export function vskFind(snap: PageSnapshot, query: string, limit: number): FindResult {
  // matchScore инлайнится ВНУТРИ функции: vskFind инжектится в страницу через
  // vskFind.toString() (BrowserView), поэтому обязан быть самодостаточным —
  // модульные хелперы туда не попадут (как roleOf/nameOf живут внутри vskSnapshot).
  // Вес совпадения: качество имени доминирует, навигации/действию — бонус над полем.
  // Д5: у кнопки без подписи совпадать нечему — её ищут по НАЗНАЧЕНИЮ, теми
  // словами, которыми модель думает о задаче («отправить», «поиск», «найти»).
  // Список корней, а не полных слов: русская морфология иначе не сойдётся
  // («отправить» ≠ «отправки»). Инлайнится внутрь функции — vskFind уезжает в
  // страницу через .toString() и обязан быть самодостаточным.
  const roleSynonyms = (role: string): string[] => (
    role === 'submit' ? ['submit', 'отправ', 'поиск', 'искать', 'найти', 'search', 'go', 'лупа', 'кнопка'] : []
  )
  const matchScore = (e: SnapshotElement, needle: string): number => {
    const name = (e.name || '').toLowerCase()
    const role = (e.role || '').toLowerCase()
    const tag = (e.tag || '').toLowerCase()
    let s = 0
    if (name === needle) s = 100
    else if (name.startsWith(needle)) s = 70
    else if (name.includes(needle)) s = 50
    else if (roleSynonyms(role).some(w => w.includes(needle) || needle.includes(w))) s = 45
    else if (role.includes(needle) || tag.includes(needle)) s = 20
    // Роли действия/перехода (клик) выше полей ввода при равном совпадении.
    if (role === 'link' || role === 'button' || role === 'submit' || role === 'tab' || role === 'menuitem') s += 5
    return s
  }
  const q = String(query || '').trim().toLowerCase()
  const lim = Math.max(1, limit | 0)
  if (!q) {
    return { query: String(query || ''), count: 0, totalHits: 0, total: snap.count, truncated: false, matches: [],
      hint: 'Пустой запрос: укажи, что искать (подпись/роль), или сделай browser_snapshot для полной карты.' }
  }
  const hits = snap.elements.filter(e =>
    (e.name || '').toLowerCase().includes(q) ||
    (e.role || '').toLowerCase().includes(q) ||
    (e.tag || '').toLowerCase().includes(q) ||
    roleSynonyms((e.role || '').toLowerCase()).some(w => w.includes(q) || q.includes(w)))
  // Ранжирование: качество совпадения ИМЕНИ доминирует (точное > префикс > вхождение >
  // только роль/тег), плюс небольшой бонус навигационным/действующим ролям. Так пункт
  // навигации (ссылка/кнопка) встаёт ВЫШЕ поля-фильтра при равном совпадении по запросу —
  // модели почти всегда нужен переход, а не заполнение фильтра. Sort стабилен (ES2019):
  // при равном весе порядок DOM сохраняется — старые пины на порядок остаются зелёными.
  const ranked = hits
    .map((e, i) => ({ e, i, s: matchScore(e, q) }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .map(x => x.e)
  const matches = ranked.slice(0, lim)
  // C6: ОДНОИМЁННЫЕ совпадения помечаются явно. Живой случай — Хабр по запросу
  // «поиск»: ссылка шапки (№5) и иконка формы (№46) несут одну подпись, значит и
  // вес у них один (точное совпадение имени + бонус роли), и порядок решает DOM.
  // Модель получает оба, но дешёвая берёт первое и упирается.
  //
  // Порядок здесь НЕ переставляется сознательно. Предпочесть «элемент в форме»
  // нечем: структуры (форма, близость к полю ввода) в снимке нет, а добавление её
  // раздувает ту самую полезную нагрузку, ради экономии которой find и построен
  // (замер 02.08: 91–99% против полного снимка). Пока признака нет — честнее
  // предупредить, чем угадать: молчаливое первое место неотличимо от «нашли ровно
  // одно». Перестановка — отдельная работа с живым замером по классам страниц.
  const dupes: string[] = []
  for (const m of matches) {
    const same = matches.filter(o => o.name && o.name.toLowerCase() === (m.name || '').toLowerCase())
    if (same.length > 1 && same[0].n === m.n) {
      dupes.push(`«${m.name}»: ${same.map(o => `№${o.n} (${o.role})`).join(', ')}`)
    }
  }
  return {
    query: String(query), count: matches.length, totalHits: hits.length, total: snap.count,
    truncated: hits.length > matches.length, matches,
    hint: matches.length === 0
      ? 'Ничего не нашлось по запросу — уточни подпись или сделай browser_snapshot для полной карты страницы.'
      : dupes.length > 0
        ? `Одинаковая подпись у нескольких элементов — ${dupes.join('; ')}. Порядок здесь задан версткой, а не пригодностью: первое место НЕ значит «нужное». Выбирай по роли и назначению; если ошибся — вернись ко второму, а не начинай сначала.`
        : undefined,
  }
}
