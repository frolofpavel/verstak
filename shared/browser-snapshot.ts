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
