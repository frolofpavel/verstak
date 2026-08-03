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

  function roleOf(el: Element): string {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase()
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      if (t === 'submit' || t === 'button') return 'button'
      return 'textbox'
    }
    if (el.getAttribute('contenteditable') === 'true') return 'textbox'
    return 'button'
  }

  function nameOf(el: Element): string {
    const h = el as HTMLElement
    const raw = (el.getAttribute('aria-label')
      || (el as HTMLInputElement).value
      || h.innerText
      || el.textContent
      || el.getAttribute('placeholder')
      || el.getAttribute('title')
      || el.getAttribute('alt')
      || '').replace(/\s+/g, ' ').trim()
    return raw.length > CLAMP ? raw.slice(0, CLAMP) + '…' : raw
  }

  const root = document.documentElement
  root.setAttribute('data-vsk-gen', gen)
  const all = Array.from(document.querySelectorAll(INTERACTIVE))
  const elements: SnapshotElement[] = []
  let n = 0
  for (const el of all) {
    if (isHidden(el)) continue
    n++
    el.setAttribute('data-vsk-el', gen + ':' + n)
    elements.push({ n, tag: el.tagName.toLowerCase(), role: roleOf(el), name: nameOf(el) })
  }
  return { gen, count: n, elements }
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
  const el = document.querySelector('[data-vsk-el="' + gen + ':' + n + '"]')
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

// VSK-BROWSER-B2: ПОРОГ top-N полного снимка. Число НЕ с потолка — из замера 03.08
// (scratchpad-бенчмарк, три класса страниц: httpbin-форма 13 эл., alfa «Аккорд» 173,
// M.Video-каталог 1091). Константа снимка ≈ 65 символов на элемент, поэтому:
//   150 элементов ≈ 10k символов ≈ ~2.5k токенов — верхняя граница, ещё дешёвая.
// Полный снимок каталога (1091 эл. → 73k символов ≈ ~18k токенов) слать каждый ход
// разорительно и размывает внимание дешёвой модели. Поэтому МОДЕЛИ отдаём top-N с
// `truncated`, а адресуется через browser_find (основной путь; замер: find экономит
// 91–99% против полного снимка). При этом в СТРАНИЦЕ пронумерованы ВСЕ элементы —
// клик/ввод по номеру и find работают за пределами N, обрезается только выдача.
export const VSK_SNAPSHOT_TOP_N = 150

/** Обрезанный для модели вид снимка: первые topN элементов + честный `truncated`.
 *  DOM-нумерация НЕ трогается (обрезается только возвращаемый список) — поэтому
 *  vskResolveNumbered находит и элемент с номером > topN. Чистая функция. */
export interface CappedSnapshot {
  gen: string
  count: number        // всего интерактивных на странице
  shown: number        // сколько вернули (≤ topN)
  truncated: boolean   // count > topN → есть непоказанные, ищи через browser_find
  elements: SnapshotElement[]
}
export function vskCapSnapshot(snap: PageSnapshot, topN: number): CappedSnapshot {
  const n = Math.max(1, topN | 0)
  const elements = snap.elements.slice(0, n)
  return { gen: snap.gen, count: snap.count, shown: elements.length, truncated: snap.count > n, elements }
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
  const q = String(query || '').trim().toLowerCase()
  const lim = Math.max(1, limit | 0)
  if (!q) {
    return { query: String(query || ''), count: 0, totalHits: 0, total: snap.count, truncated: false, matches: [],
      hint: 'Пустой запрос: укажи, что искать (подпись/роль), или сделай browser_snapshot для полной карты.' }
  }
  const hits = snap.elements.filter(e =>
    (e.name || '').toLowerCase().includes(q) ||
    (e.role || '').toLowerCase().includes(q) ||
    (e.tag || '').toLowerCase().includes(q))
  const matches = hits.slice(0, lim)
  return {
    query: String(query), count: matches.length, totalHits: hits.length, total: snap.count,
    truncated: hits.length > matches.length, matches,
    hint: matches.length === 0
      ? 'Ничего не нашлось по запросу — уточни подпись или сделай browser_snapshot для полной карты страницы.'
      : undefined,
  }
}
