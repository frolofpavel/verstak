// extractor.mjs — безопасный сборщик снимка активной вкладки (privacy-first).
//
// Контракт VSK-EXT-A1-R1 (privacy hardening):
//   • capturePageSnapshot(options) — единственный экспорт; функция self-contained:
//     её передают в chrome.scripting.executeScript({ func }), поэтому внутри НЕ
//     должно быть ссылок на внешние константы/хелперы из module scope. Любой
//     хелпер — вложенная функция, объявленная в теле capturePageSnapshot.
//   • Никаких outerHTML/innerHTML, значений форм, скрытых узлов, contenteditable
//     черновиков пользователя. Только видимый текст текущего frame'а.
//   • Единый privacy-фильтр используется для text, tables (caption/th/td) и
//     selection — никакой логики «в одном месте фильтруем, в другом нет».
//   • Privacy-first: если предок editable/hidden/form, потомок тоже не читается,
//     даже если у потомка стоит contenteditable="false".
//
// Лимиты (применяются во время обхода, не после построения гигантских строк):
//   • URL — ≤ 2048 символов (после очистки credentials/query/hash).
//   • title — ≤ 500.
//   • selection — ≤ 5000.
//   • text — ≤ 50000.
//   • tables — ≤ 5 шт., ≤ 50 строк, ≤ 20 ячеек в строке, ≤ 500 символов на ячейку.
//   • общий текст всех таблиц — ≤ 40000 символов.
//   • node budget — ≤ 50000 DOM-узлов.
//   • итоговый JSON-сериалайз snapshot — ≤ 120000 символов.

/**
 * DOM click by opaque elementRef stamped during capturePageSnapshot.
 * Self-contained for chrome.scripting.executeScript({ func }).
 * Returns { ok, finalUrl?, error? }. Stale observationVersion → reject.
 */
export function performClickByRef(elementRef, observationVersion) {
  const ref = String(elementRef || '').trim()
  const version = String(observationVersion == null ? '' : observationVersion)
  if (!ref) return { ok: false, error: 'elementRef empty' }
  // Reject raw CSS/JS payloads (model must not send selectors).
  if (/[{};<>]|document\.|querySelector|eval\(/i.test(ref)) {
    return { ok: false, error: 'raw CSS/JS forbidden' }
  }
  const doc = typeof document !== 'undefined' ? document : null
  if (!doc || !doc.documentElement) {
    return { ok: false, error: 'no document' }
  }
  const pageVer = doc.documentElement.getAttribute('data-verstak-obs') || ''
  if (!pageVer || pageVer !== version) {
    return {
      ok: false,
      error: 'stale observationVersion (page reloaded or re-observed) — re-observe before click',
    }
  }
  let el = null
  try {
    el = doc.querySelector('[data-verstak-ref="' + cssEscapeAttr(ref) + '"]')
  } catch {
    el = null
  }
  if (!el) {
    return { ok: false, error: 'elementRef not found on page (stale map or wrong tab)' }
  }
  const elVer = el.getAttribute('data-verstak-obs') || ''
  if (elVer && elVer !== version) {
    return { ok: false, error: 'elementRef observationVersion mismatch' }
  }
  try {
    if (typeof el.click === 'function') el.click()
    else {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
  let finalUrl = ''
  try {
    finalUrl = location && location.href ? String(location.href).slice(0, 2048) : ''
  } catch {
    finalUrl = ''
  }
  return { ok: true, finalUrl }

  function cssEscapeAttr(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  }
}

export function performScrollByRef(elementRef, delta) {
  try {
    const dx = Number(delta?.x || 0)
    const dy = Number(delta?.y || 0)
    if (elementRef) {
      const doc = typeof document !== 'undefined' ? document : null
      if (!doc) return { ok: false, error: 'no document' }
      const el = doc.querySelector('[data-verstak-ref="' + String(elementRef).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]')
      if (!el) return { ok: false, error: 'elementRef not found' }
      if (typeof el.scrollBy === 'function' && (dx !== 0 || dy !== 0)) {
        el.scrollBy(dx, dy)
      } else if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    } else {
      if (typeof window !== 'undefined' && typeof window.scrollBy === 'function') {
        window.scrollBy(dx, dy)
      }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

export function performFocusByRef(elementRef, observationVersion) {
  try {
    const ref = String(elementRef || '').trim()
    const doc = typeof document !== 'undefined' ? document : null
    if (!doc) return { ok: false, error: 'no document' }
    const el = doc.querySelector('[data-verstak-ref="' + ref.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]')
    if (!el) return { ok: false, error: 'elementRef not found' }
    if (typeof el.focus === 'function') el.focus()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

export function performSelectByRef(elementRef, observationVersion, value) {
  try {
    const ref = String(elementRef || '').trim()
    const doc = typeof document !== 'undefined' ? document : null
    if (!doc) return { ok: false, error: 'no document' }
    const el = doc.querySelector('[data-verstak-ref="' + ref.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]')
    if (!el) return { ok: false, error: 'elementRef not found' }
    const val = String(value || '')
    if ('value' in el) {
      el.value = val
      el.dispatchEvent(new Event('change', { bubbles: true }))
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return { ok: true }
    }
    return { ok: false, error: 'element is not a select/input' }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

export function performWaitFor(condition) {
  try {
    const doc = typeof document !== 'undefined' ? document : null
    if (!doc) return { ok: false, reason: 'no document' }
    if (condition && condition.elementRef) {
      const ref = String(condition.elementRef).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const el = doc.querySelector('[data-verstak-ref="' + ref + '"]')
      if (el) return { ok: true }
      return { ok: false, reason: 'elementRef not found' }
    }
    if (condition && condition.text) {
      const text = String(condition.text).trim()
      const pageText = doc.body ? (doc.body.innerText || '') : ''
      if (pageText.includes(text)) return { ok: true }
      return { ok: false, reason: 'text not found' }
    }
    if (condition && condition.url) {
      const targetUrl = String(condition.url).trim()
      const currentUrl = typeof location !== 'undefined' ? (location.href || '') : ''
      if (currentUrl.includes(targetUrl)) return { ok: true }
      return { ok: false, reason: 'url match not found' }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

export function performTypeText(elementRef, observationVersion, text, clearFirst, submitEnter) {
  try {
    const ref = String(elementRef || '').trim()
    const doc = typeof document !== 'undefined' ? document : null
    if (!doc) return { ok: false, error: 'no document' }
    const el = doc.querySelector('[data-verstak-ref="' + ref.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]')
    if (!el) return { ok: false, error: 'elementRef not found' }
    const val = String(text || '')
    if ('value' in el) {
      if (clearFirst) el.value = ''
      el.value = (el.value || '') + val
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      if (submitEnter) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
        if (el.form && typeof el.form.requestSubmit === 'function') {
          el.form.requestSubmit()
        }
      }
      return { ok: true }
    }
    return { ok: false, error: 'element is not an input/textarea' }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

export function performClearField(elementRef, observationVersion) {
  try {
    const ref = String(elementRef || '').trim()
    const doc = typeof document !== 'undefined' ? document : null
    if (!doc) return { ok: false, error: 'no document' }
    const el = doc.querySelector('[data-verstak-ref="' + ref.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]')
    if (!el) return { ok: false, error: 'elementRef not found' }
    if ('value' in el) {
      el.value = ''
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true }
    }
    return { ok: false, error: 'element is not an input/textarea' }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

export function performToggle(elementRef, observationVersion) {
  try {
    const ref = String(elementRef || '').trim()
    const doc = typeof document !== 'undefined' ? document : null
    if (!doc) return { ok: false, error: 'no document' }
    const el = doc.querySelector('[data-verstak-ref="' + ref.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]')
    if (!el) return { ok: false, error: 'elementRef not found' }
    if ('checked' in el) {
      el.checked = !el.checked
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true }
    }
    if (typeof el.click === 'function') {
      el.click()
      return { ok: true }
    }
    return { ok: false, error: 'element cannot be toggled' }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

export function performPressKey(elementRef, observationVersion, key) {
  try {
    const ref = String(elementRef || '').trim()
    const k = String(key || 'Enter')
    const doc = typeof document !== 'undefined' ? document : null
    if (!doc) return { ok: false, error: 'no document' }
    const el = doc.querySelector('[data-verstak-ref="' + ref.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]')
    const target = el || doc.activeElement || doc.body
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, bubbles: true }))
    target.dispatchEvent(new KeyboardEvent('keyup', { key: k, code: k, bubbles: true }))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

export function capturePageSnapshot(options) {
  // ── Лимиты (внутри функции — self-contained). ─────────────────────────────
  const LIMITS = {
    url: 2048,
    title: 500,
    selection: 5000,
    text: 50000,
    table: {
      maxTables: 5,
      maxRows: 50,
      maxCellsPerRow: 20,
      maxCellChars: 500,
      maxTotalTableChars: 40000,
      maxCaptionChars: 200,
    },
    nodeBudget: 50000,
    // Глубина обхода: getComputedStyle в jsdom рекурсивен по предкам → при
    // экстремальной вложенности переполняет стек. В реальных страницах глубина
    // редко превышает 100; 2000 — щедрый потолок, защищающий от зловредных DOM.
    maxDepth: 2000,
    jsonHardCap: 120000,
  }

  const opts = (typeof options === 'object' && options) || {}
  const textLimit = clampInt(opts.textLimit, 1, LIMITS.text)
  const selectionLimit = clampInt(opts.selectionLimit, 1, LIMITS.selection)
  const titleLimit = clampInt(opts.titleLimit, 1, LIMITS.title)
  const urlLimit = clampInt(opts.urlLimit, 1, LIMITS.url)
  // Опция nodeBudgetLimit позволяет ужесточить node budget (для тестов).
  const nodeBudgetLimit = clampInt(opts.nodeBudgetLimit, 1, LIMITS.nodeBudget)

  const omissions = []
  const truncated = { text: false, selection: false, tables: false }

  // Глобальный счётчик посещённых узлов — общий для всех обходов (text + tables),
  // чтобы общий node budget соблюдался честно.
  let nodeBudgetUsed = 0
  let nodeBudgetExceeded = false

  const doc = (typeof document !== 'undefined') ? document : null
  const win = (typeof window !== 'undefined') ? window : null

  // ── Очистка URL (без credentials/query/hash) + hard cap. ───────────────────
  let safeUrl = ''
  try {
    if (typeof location !== 'undefined' && location && location.href) {
      const u = new URL(location.href)
      // username/password удаляем через явную сборку — new URL сохраняет их в .href.
      safeUrl = u.protocol + '//' + u.host + u.pathname
    }
  } catch {
    safeUrl = ''
  }
  if (safeUrl.length > urlLimit) {
    safeUrl = safeUrl.slice(0, urlLimit)
  }

  // ── Title с cap. ───────────────────────────────────────────────────────────
  let rawTitle = ''
  try {
    rawTitle = doc && doc.title ? String(doc.title) : ''
  } catch {
    rawTitle = ''
  }
  const title = clip(rawTitle, titleLimit)

  // ── Безопасное selection. ──────────────────────────────────────────────────
  // Нельзя просто взять window.getSelection().toString(): selection может
  // пересекать contenteditable/form/hidden. Проверяем диапазон поэлементно.
  let selection = ''
  try {
    selection = collectSafeSelection(win, selectionLimit)
  } catch (err) {
    omissions.push('selection-failed: ' + safeMsg(err))
    selection = ''
  }

  // ── Видимый текст документа. ──────────────────────────────────────────────
  let text = ''
  if (doc && doc.body) {
    try {
      text = collectVisibleText(doc.body, textLimit)
    } catch (err) {
      omissions.push('text-extract-failed: ' + safeMsg(err))
      text = ''
    }
  }

  // ── Таблицы. ──────────────────────────────────────────────────────────────
  let tables = []
  if (doc) {
    try {
      tables = collectTables(doc, LIMITS.table)
    } catch (err) {
      tables = []
      omissions.push('tables-extract-failed: ' + safeMsg(err))
    }
  }

  // ── Interactive controls map (EXT-C1 click). Opaque elementRef, no CSS/JS. ─
  // Stable refs: role:label:nth — same structure → same ref across re-observe.
  // Stamp data-verstak-obs + data-verstak-ref for click resolution.
  let controls = []
  let observationVersion = Date.now()
  if (doc) {
    try {
      const collected = collectControls(doc, observationVersion, 40)
      controls = collected.controls
      observationVersion = collected.observationVersion
    } catch (err) {
      controls = []
      omissions.push('controls-extract-failed: ' + safeMsg(err))
    }
  }

  if (nodeBudgetExceeded) {
    // Контракт R2 BLOCK 5: marker показывает фактический nodeBudgetLimit
    // (ужесточённое значение из options), а не всегда дефолт 50000.
    omissions.push('node-budget-exceeded: limit=' + nodeBudgetLimit + ' (capture stopped early)')
  }

  const snapshot = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    source: {
      kind: 'chrome-active-tab',
      url: safeUrl,
      title,
    },
    selection,
    text,
    tables,
    controls,
    observationVersion,
    omissions,
    truncated,
  }

  // ── Финальный hard cap на сериализованный JSON. ────────────────────────────
  // Если вдруг (из-за рассинхрона лимитов) итог больше допустимого, обрезаем
  // самое тяжёлое — text — пока не уложимся. Это страховка, не основной механизм.
  enforceJsonHardCap(snapshot, LIMITS.jsonHardCap, omissions, truncated)

  return snapshot

  // ───────────────────────────────────────────────────────────────────────────
  // Вложенные хелперы (живут в замыкании функции, не в module scope).
  // ───────────────────────────────────────────────────────────────────────────

  function clampInt(value, min, max) {
    const n = Math.floor(Number(value))
    if (!Number.isFinite(n)) return max
    if (n < min) return min
    if (n > max) return max
    return n
  }

  function clip(str, max) {
    const s = String(str == null ? '' : str)
    if (s.length <= max) return s
    return s.slice(0, max)
  }

  function safeMsg(err) {
    if (!err) return 'unknown'
    if (typeof err === 'object' && typeof err.message === 'string') return err.message
    return String(err)
  }

  function collapseWhitespace(s) {
    return String(s == null ? '' : s)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  /**
   * Limited interactive map for click (buttons + links only).
   * Stamps data-verstak-obs / data-verstak-ref on elements for click resolution.
   */
  function collectControls(document, version, maxControls) {
    const root = document.documentElement
    if (root) {
      try { root.setAttribute('data-verstak-obs', String(version)) } catch { /* ignore */ }
    }
    const candidates = []
    try {
      const nodes = document.querySelectorAll(
        'button, a[href], [role="button"], input[type="button"], input[type="submit"], input[type="reset"]',
      )
      for (let i = 0; i < nodes.length; i++) {
        candidates.push(nodes[i])
      }
    } catch {
      return { controls: [], observationVersion: version }
    }

    const byKey = Object.create(null)
    const controls = []
    for (let i = 0; i < candidates.length && controls.length < maxControls; i++) {
      const el = candidates[i]
      if (!el || el.nodeType !== 1) continue
      // Skip invisible / aria-hidden. Also skip password-like / type=hidden inputs.
      try {
        if (hasTrueAttribute(el, 'hidden')) continue
        if (getAriaHidden(el) === 'true') continue
        if (isCssHidden(el)) continue
        const t = String(el.getAttribute && el.getAttribute('type') || '').toLowerCase()
        if (t === 'password' || t === 'hidden') continue
        // Ancestor with hidden/aria-hidden — do not surface secrets from collapsed UI.
        let p = el.parentElement
        let skip = false
        while (p && p !== document.documentElement) {
          if (hasTrueAttribute(p, 'hidden') || getAriaHidden(p) === 'true' || isCssHidden(p)) {
            skip = true
            break
          }
          p = p.parentElement
        }
        if (skip) continue
      } catch { continue }

      const tag = String(el.tagName || '').toLowerCase()
      let role = 'button'
      if (tag === 'a') role = 'link'
      else if (tag === 'input') role = 'button'
      else {
        try {
          const r = el.getAttribute && el.getAttribute('role')
          if (r === 'button') role = 'button'
          else if (r === 'link') role = 'link'
        } catch { /* keep default */ }
      }

      let label = ''
      try {
        label = collapseWhitespace(
          el.getAttribute('aria-label')
          || el.getAttribute('title')
          || el.getAttribute('value')
          || (el.innerText || el.textContent || ''),
        )
      } catch {
        label = ''
      }
      label = clip(label, 80)
      if (!label) label = role

      const safeLabel = label
        .replace(/[^\w\u0400-\u04FF \-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40) || 'unnamed'
      const key = role + ':' + safeLabel
      const nth = byKey[key] || 0
      byKey[key] = nth + 1
      const elementRef = role + ':' + safeLabel + ':' + nth

      try {
        el.setAttribute('data-verstak-ref', elementRef)
        el.setAttribute('data-verstak-obs', String(version))
      } catch { /* ignore */ }

      let state = ''
      try {
        if (el.disabled) state = 'disabled'
        else if (el.getAttribute('aria-disabled') === 'true') state = 'disabled'
      } catch { /* ignore */ }

      controls.push({
        elementRef,
        role,
        label,
        state: state || undefined,
        observationVersion: version,
      })
    }
    return { controls, observationVersion: version }
  }

  // ── Единый privacy-фильтр (BLOCK 1). ───────────────────────────────────────
  // Возвращает true, если элемент (или его поддерево) нельзя читать.
  function isPrivate(el) {
    if (!el || el.nodeType !== 1) return false
    const tag = el.tagName
    // Скрытое содержание разметки.
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return true
    // Формы и контролы — значения пользователя/пароли/черновики.
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION' || tag === 'BUTTON') return true
    if (tag === 'FORM') return true
    // contenteditable — черновики пользователя. Проверяем isContentEditable
    // (если доступен) плюс надёжный fallback по атрибуту для jsdom.
    if (isEditable(el)) return true
    // hidden / aria-hidden (без зависимости от регистра).
    if (hasTrueAttribute(el, 'hidden')) return true
    if (getAriaHidden(el) === 'true') return true
    // Inline + computed display:none / visibility:hidden / content-visibility:hidden.
    if (isCssHidden(el)) return true
    return false
  }

  function isEditable(el) {
    // contenteditable может быть "", "true", "plaintext-only" — всё это значит
    // «узел редактируется» (пустая строка трактуется как true по HTML-спеке).
    try {
      // Нативный признак — самый надёжный, но в jsdom может быть стабом.
      if (typeof el.isContentEditable === 'boolean' && el.isContentEditable) return true
    } catch { /* ignore */ }
    try {
      const raw = el.getAttribute && el.getAttribute('contenteditable')
      if (raw === null) return false
      const v = String(raw).toLowerCase().trim()
      // "" / "true" / "plaintext-only" — редактируется. "false" — нет.
      if (v === '' || v === 'true' || v === 'plaintext-only') return true
    } catch { /* ignore */ }
    return false
  }

  function hasTrueAttribute(el, name) {
    try {
      // Булевый атрибут: присутствие = true, даже если значение пустое.
      if (el.hasAttribute && el.hasAttribute(name)) return true
    } catch { /* ignore */ }
    return false
  }

  function getAriaHidden(el) {
    try {
      const raw = el.getAttribute && el.getAttribute('aria-hidden')
      if (raw === null) return null
      return String(raw).toLowerCase().trim()
    } catch {
      return null
    }
  }

  function isCssHidden(el) {
    // Сначала дешёвый inline-стиль — покрывает основную массу.
    try {
      const raw = el.getAttribute && el.getAttribute('style')
      if (raw) {
        const lower = raw.toLowerCase()
        if (/(^|[;{\s])display\s*:\s*none/.test(lower)) return true
        if (/(^|[;{\s])visibility\s*:\s*hidden/.test(lower)) return true
        if (/(^|[;{\s])content-visibility\s*:\s*hidden/.test(lower)) return true
      }
    } catch { /* ignore */ }
    // Computed-style для CSS-классов. Дорогой, но необходимый для приватности:
    // иначе CSS-класс с display:none утечёт.
    try {
      const view = el.ownerDocument && el.ownerDocument.defaultView
      if (view && typeof view.getComputedStyle === 'function') {
        const cs = view.getComputedStyle(el, null)
        if (cs) {
          const display = cs.getPropertyValue('display')
          const visibility = cs.getPropertyValue('visibility')
          const contentVisibility = cs.getPropertyValue('content-visibility')
          if (display === 'none') return true
          if (visibility === 'hidden') return true
          if (contentVisibility === 'hidden') return true
        }
      }
    } catch { /* ignore */ }
    return false
  }

  // ── Проверка предков до корня (включая сам root). ─────────────────────────
  // Privacy-first: если любой предок (включая корень body) приватный — узел
  // тоже приватный. Контракт: нельзя оставлять `node !== top && shouldSkip(node)`.
  function hasPrivateAncestor(node, top) {
    let cur = node
    while (cur && cur !== null) {
      if (cur.nodeType === 1 && isPrivate(cur)) return true
      if (cur === top) break
      cur = cur.parentNode
    }
    return false
  }

  // ── Node budget. ──────────────────────────────────────────────────────────
  function budgetTick() {
    nodeBudgetUsed++
    if (nodeBudgetUsed > nodeBudgetLimit) {
      nodeBudgetExceeded = true
      return false // stop
    }
    return true // continue
  }

  // ── Итеративный сбор видимого текста (BLOCK 3 — без рекурсии). ────────────
  function collectVisibleText(root, limit) {
    if (!root) return ''
    const chunks = []
    let totalLen = 0
    // Стек: { node, priv, depth }. depth — текущая глубина от root.
    const stack = []
    stack.push({ node: root, priv: isPrivate(root), depth: 0 })

    while (stack.length > 0) {
      if (!budgetTick()) {
        truncated.text = true
        // Глобальный node-budget marker создастся в основном теле после обхода.
        // Локальный text-stopped без слова node-budget, чтобы тест на точный
        // marker не цеплял этот (контракт R2 BLOCK 5).
        omissions.push('text-stopped: global-node-budget')
        break
      }
      const frame = stack.pop()
      const node = frame.node
      if (!node) continue
      if (frame.priv) continue
      if (frame.depth > LIMITS.maxDepth) {
        // Защита от зловредной глубины — не падаем, просто не спускаемся глубже.
        if (!truncated.text) {
          truncated.text = true
          omissions.push('text-stopped: max-depth-exceeded')
        }
        continue
      }

      const nt = node.nodeType
      if (nt === 3) {
        const v = node.nodeValue
        if (v) {
          if (totalLen + v.length > limit) {
            const remain = limit - totalLen
            if (remain > 0) chunks.push(v.slice(0, remain))
            truncated.text = true
            break
          }
          chunks.push(v)
          totalLen += v.length
        }
        continue
      }
      // Проталкиваем детей в обратном порядке для сохранения визуального порядка.
      const cs = node.childNodes
      if (!cs) continue
      const len = cs.length
      for (let i = len - 1; i >= 0; i--) {
        const child = cs[i]
        const childPriv = frame.priv || (child.nodeType === 1 && isPrivate(child))
        stack.push({ node: child, priv: childPriv, depth: frame.depth + 1 })
      }
    }
    return collapseWhitespace(chunks.join('\n'))
  }

  // ── Безопасное selection (BLOCK 2 R2 — live DOM, без cloneContents). ──────
  // Контракт R2: полностью убрать range.cloneContents() и textContent на клоне.
  // Selection проверяется по исходному живому DOM, где сохранён computed CSS
  // и ancestor chain.
  function collectSafeSelection(winObj, limit) {
    if (!winObj || typeof winObj.getSelection !== 'function') return ''
    const sel = winObj.getSelection()
    if (!sel || sel.rangeCount === 0) return ''
    const body = doc && doc.body ? doc.body : null

    const safeChunks = []
    let totalLen = 0
    let dropped = false

    for (let i = 0; i < sel.rangeCount; i++) {
      let range
      try { range = sel.getRangeAt(i) } catch {
        dropped = true
        continue
      }
      if (!range || range.collapsed) continue

      // Собираем видимый текст range'а по живым узлам. Если range пересекает
      // хотя бы один private-узел — отбрасываем весь range (fail-closed).
      const collected = collectLiveRangeText(range, body, limit - totalLen)
      if (collected === null) {
        // Range пересёк private-узел или node budget превышен — fail-closed.
        dropped = true
        continue
      }
      if (collected.budgetExceeded) {
        if (collected.text) {
          safeChunks.push(collected.text)
          totalLen += collected.text.length
        }
        truncated.selection = true
        omissions.push('selection-stopped: global-node-budget')
        break
      }
      if (collected.text) {
        safeChunks.push(collected.text)
        totalLen += collected.text.length
        if (totalLen >= limit) {
          truncated.selection = true
          break
        }
      }
    }

    if (dropped && safeChunks.length === 0) {
      omissions.push('selection-dropped: source considered private (editable/form/hidden)')
    }
    return collapseWhitespace(safeChunks.join('\n'))
  }

  // Итеративный обход ЖИВОГО поддерева внутри range. Возвращает:
  //   { text, budgetExceeded } — успешно собрано (text может быть пустой)
  //   null — range пересёк private-узел → весь range отбрасывается
  function collectLiveRangeText(range, body, remainLimit) {
    const start = range.startContainer
    const end = range.endContainer
    const root = range.commonAncestorContainer
    if (!root) return { text: '', budgetExceeded: false }

    // Любой узел range, оказавшийся приватным по предку → весь range отбрасывается.
    // Проверяем commonAncestorContainer и start/end явно (быстрая первичная проверка).
    if (root && hasPrivateAncestor(root, body)) return null
    if (start && hasPrivateAncestor(start, body)) return null
    if (end && hasPrivateAncestor(end, body)) return null

    const chunks = []
    let totalLen = 0
    let budgetExceeded = false

    // Итеративный обход поддерева root. Для каждого узла используем
    // range.intersectsNode (если доступен) — иначе проверяем через границы.
    const stack = [root]
    let guard = 0
    while (stack.length > 0) {
      if (!budgetTick()) {
        budgetExceeded = true
        break
      }
      if (++guard > LIMITS.nodeBudget * 2) {
        budgetExceeded = true
        break
      }
      const node = stack.pop()
      if (!node) continue

      // Проверяем, пересекает ли range этот узел. intersectsNode не во всех средах
      // реализован; откат — ручная проверка через compareBoundaryPoints.
      let intersects
      try {
        intersects = typeof range.intersectsNode === 'function'
          ? range.intersectsNode(node)
          : manualIntersects(range, node)
      } catch {
        // Любая ошибка Range → fail-closed: весь range отбрасывается.
        return null
      }
      if (!intersects) continue

      // Живая приватность: если сам узел или его предок приватный → весь range fail.
      if (node.nodeType === 1 && isPrivate(node)) return null
      if (hasPrivateAncestor(node, body)) return null

      if (node.nodeType === 3) {
        // TEXT_NODE — берём только пересечённую часть через startOffset/endOffset.
        const piece = sliceTextNodeByRange(node, range)
        if (piece) {
          if (totalLen + piece.length > remainLimit) {
            const remain = remainLimit - totalLen
            if (remain > 0) chunks.push(piece.slice(0, remain))
            totalLen = remainLimit
            break
          }
          chunks.push(piece)
          totalLen += piece.length
        }
        continue
      }

      // Проталкиваем детей в обратном порядке (сохраняем DOM-порядок).
      const cs = node.childNodes
      if (!cs) continue
      for (let i = cs.length - 1; i >= 0; i--) stack.push(cs[i])
    }

    return { text: chunks.join(''), budgetExceeded }
  }

  function manualIntersects(range, node) {
    // Откат для сред без range.intersectsNode. Узел пересекает range, если
    // его позиция не строго до start и не строго после end.
    try {
      const nodeRange = node.ownerDocument.createRange()
      nodeRange.selectNode(node)
      const startCompare = range.compareBoundaryPoints(Range.START_TO_START, nodeRange)
      const endCompare = range.compareBoundaryPoints(Range.END_TO_END, nodeRange)
      // start <= node.end AND end >= node.start → intersects.
      return startCompare <= 0 && endCompare >= 0
    } catch {
      return false
    }
  }

  function sliceTextNodeByRange(textNode, range) {
    // Возвращает часть textNode.nodeValue, реально входящую в range.
    try {
      const len = textNode.nodeValue ? textNode.nodeValue.length : 0
      if (len === 0) return ''
      let startOff = 0
      let endOff = len
      if (range.startContainer === textNode) {
        startOff = Math.max(0, Math.min(range.startOffset, len))
      }
      if (range.endContainer === textNode) {
        endOff = Math.max(0, Math.min(range.endOffset, len))
      }
      if (endOff < startOff) {
        const tmp = startOff; startOff = endOff; endOff = tmp
      }
      if (startOff >= endOff) return ''
      // Если textNode строго внутри range — берём целиком.
      if (range.startContainer !== textNode && range.endContainer !== textNode) {
        return textNode.nodeValue || ''
      }
      return (textNode.nodeValue || '').slice(startOff, endOff)
    } catch {
      return ''
    }
  }

  // ── Таблицы (BLOCK 1+3 R2 — private ancestor guard + реальный global budget). ─
  function collectTables(docNode, limits) {
    const result = []
    let list
    try {
      list = docNode.getElementsByTagName('table')
    } catch {
      return result
    }
    const total = list ? list.length : 0
    const body = docNode && docNode.body ? docNode.body : null
    let safeSeen = 0
    let privateSkipped = 0
    let tableCharsUsed = 0
    let budgetExhausted = false

    for (let i = 0; i < total && safeSeen < limits.maxTables; i++) {
      const tbl = list[i]

      // BLOCK 1: private-ancestor guard — таблица целиком под скрытым/форменным
      // предком не читается и НЕ потребляет maxTables/budget.
      if (hasPrivateAncestor(tbl, body)) {
        privateSkipped++
        continue
      }

      // BLOCK 3: проверяем оставшийся глобальный budget ПЕРЕД чтением.
      if (tableCharsUsed >= limits.maxTotalTableChars) {
        if (!budgetExhausted) {
          budgetExhausted = true
          truncated.tables = true
          omissions.push('tables-stopped: total-table-chars-limit=' + limits.maxTotalTableChars + ' reached')
        }
        break
      }

      const remaining = limits.maxTotalTableChars - tableCharsUsed
      let t
      try {
        t = extractOneTable(tbl, limits, remaining)
      } catch (err) {
        omissions.push('table-' + i + '-failed: ' + safeMsg(err))
        // Сбойную таблицу считаем взятой, чтобы не зацикливаться.
        safeSeen++
        continue
      }

      // Реальный учёт потреблённого бюджета по фактическим длинам.
      let tLen = t.caption ? t.caption.length : 0
      for (const row of t.rows) {
        for (const cell of row) tLen += cell.length
      }
      // Страховка: если extractOneTable почему-то вернул больше remaining —
      // обрезаем самую тяжёлую строку (fail-safe, не должно срабатывать).
      if (tLen > remaining) {
        truncateTableInPlace(t, remaining)
        tLen = 0
        if (t.caption) tLen += t.caption.length
        for (const row of t.rows) for (const cell of row) tLen += cell.length
        if (!truncated.tables) {
          truncated.tables = true
          omissions.push('tables-truncated: in-place safety cap')
        }
      }
      tableCharsUsed += tLen
      result.push(t)
      safeSeen++
    }

    if (privateSkipped > 0) {
      omissions.push('tables-skipped-private: count=' + privateSkipped)
    }
    if (total > safeSeen + privateSkipped && safeSeen === limits.maxTables) {
      // Источник содержит больше безопасных таблиц, чем мы взяли.
      omissions.push('tables-truncated: safe-kept=' + safeSeen + ' (maxTables=' + limits.maxTables + ')')
      truncated.tables = true
    }
    return result
  }

  function truncateTableInPlace(t, maxChars) {
    // Аварийная страховка: режем ячейки пока суммарная длина не уложится в maxChars.
    let used = t.caption ? t.caption.length : 0
    if (used > maxChars) {
      t.caption = t.caption.slice(0, Math.max(0, maxChars))
      used = t.caption.length
    }
    for (let r = 0; r < t.rows.length; r++) {
      for (let c = 0; c < t.rows[r].length; c++) {
        if (used >= maxChars) {
          t.rows[r][c] = ''
          continue
        }
        const remain = maxChars - used
        if (t.rows[r][c].length > remain) {
          t.rows[r][c] = t.rows[r][c].slice(0, remain)
        }
        used += t.rows[r][c].length
      }
    }
  }

  function extractOneTable(tableEl, limits, remainingGlobal) {
    // Caption и th проходят через единый safe-фильтр, как и td.
    // remainingGlobal — остаток ОБЩЕГО table budget (на все таблицы).
    const captionCap = Math.max(0, Math.min(limits.maxCaptionChars, remainingGlobal))
    const caption = captionCap > 0
      ? readFilteredCellText(findCaptionEl(tableEl), captionCap)
      : ''

    const rowsOut = []
    let rowEls
    try {
      rowEls = tableEl.rows
    } catch {
      rowEls = null
    }
    const rowCount = rowEls ? rowEls.length : 0
    if (rowCount > limits.maxRows) {
      omissions.push('table-rows-truncated: rows=' + rowCount + ' kept=' + limits.maxRows)
      truncated.tables = true
    }
    const takeRows = Math.min(rowCount, limits.maxRows)
    let rowBudgetUsed = caption.length  // уже потреблено caption в рамках remainingGlobal
    for (let r = 0; r < takeRows; r++) {
      // Глобальный budget — не даём превысить remainingGlobal (по границе, без +1).
      if (rowBudgetUsed >= remainingGlobal) {
        if (!truncated.tables) {
          truncated.tables = true
          omissions.push('tables-stopped: total-table-chars-limit reached mid-table')
        }
        break
      }
      const rowRemain = remainingGlobal - rowBudgetUsed
      try {
        const cells = rowEls[r].cells
        const cellCount = cells ? cells.length : 0
        if (cellCount > limits.maxCellsPerRow) {
          omissions.push('table-cells-truncated: row=' + r + ' cells=' + cellCount + ' kept=' + limits.maxCellsPerRow)
          truncated.tables = true
        }
        const takeCells = Math.min(cellCount, limits.maxCellsPerRow)
        const rowArr = []
        let rowLen = 0
        for (let c = 0; c < takeCells; c++) {
          // Per-cell cap — минимум из лимита ячейки и остатка бюджета строки.
          const cellCap = Math.max(0, Math.min(limits.maxCellChars, rowRemain - rowLen))
          if (cellCap <= 0) {
            if (!truncated.tables) {
              truncated.tables = true
              omissions.push('tables-stopped: total-table-chars-limit reached mid-row')
            }
            break
          }
          const cellText = readFilteredCellText(cells[c], cellCap)
          rowArr.push(cellText)
          rowLen += cellText.length
        }
        rowsOut.push(rowArr)
        rowBudgetUsed += rowLen
      } catch (err) {
        omissions.push('table-row-' + r + '-failed: ' + safeMsg(err))
        rowsOut.push([])
      }
    }
    return { caption, rows: rowsOut }
  }

  function findCaptionEl(tableEl) {
    try {
      // <caption> предпочтительнее; если нет — первый <th> как псевдо-заголовок.
      const cap = tableEl.querySelector('caption')
      if (cap) return cap
      const th = tableEl.querySelector('th')
      if (th) return th
    } catch { /* ignore */ }
    return null
  }

  // ЕДИНЫЙ фильтр ячейки/caption/th: обходим поддерево и собираем только
  // видимый текст, отсекая приватные поддеревья. Никакого raw textContent.
  function readFilteredCellText(el, maxChars) {
    if (!el) return ''
    // Сам контейнер приватный — вся ячейка пустая.
    if (isPrivate(el)) return ''

    let total = 0
    const chunks = []
    const stack = []
    // Дети с предком-приватным флагом.
    const cs = el.childNodes
    if (cs) {
      for (let i = cs.length - 1; i >= 0; i--) {
        const child = cs[i]
        const childPriv = child.nodeType === 1 && isPrivate(child)
        stack.push({ node: child, priv: childPriv })
      }
    }
    while (stack.length > 0) {
      if (!budgetTick()) {
        truncated.tables = true
        omissions.push('tables-stopped: global-node-budget')
        break
      }
      const frame = stack.pop()
      if (!frame || !frame.node || frame.priv) continue
      const node = frame.node
      const nt = node.nodeType
      if (nt === 3) {
        const v = node.nodeValue
        if (!v) continue
        if (total + v.length > maxChars) {
          const remain = maxChars - total
          if (remain > 0) chunks.push(v.slice(0, remain))
          truncated.tables = true
          break
        }
        chunks.push(v)
        total += v.length
        continue
      }
      if (nt !== 1) continue
      // Проверка children на приватность (предок уже прошёл — но ребёнок может
      // оказаться приватным: form внутри ячейки, contenteditable и т.д.).
      const ccs = node.childNodes
      if (!ccs) continue
      for (let i = ccs.length - 1; i >= 0; i--) {
        const child = ccs[i]
        const childPriv = frame.priv || (child.nodeType === 1 && isPrivate(child))
        stack.push({ node: child, priv: childPriv })
      }
    }
    const text = collapseWhitespace(chunks.join(' '))
    if (text.length > maxChars) {
      // collapseWhitespace может ужать, но для надёжности — повторный cap.
      return text.slice(0, maxChars)
    }
    return text
  }

  // ── Финальный hard cap на сериализованный JSON (BLOCK 4 R2). ────────────────
  // Гарантия: JSON.stringify(snapshot).length ≤ cap при любых входных данных.
  // Учитывает escape-amplification: каждый " или \ в исходных строках удваивается
  // в JSON, поэтому фактическая длина JSON может быть вдвое больше суммарной длины
  // полей. Подход: после каждого изменения заново измеряем JSON.length, режем
  // самое тяжёлое поле, доходим до гарантированно безопасной длины.
  function enforceJsonHardCap(snap, cap, omissionsArr, truncatedFlag) {
    const safetyMargin = 4096 // запас на оверхед JSON-структуры, ключей и т.п.
    const target = Math.max(1024, cap - safetyMargin)
    let prevLen = -1

    // Фаза 1: циклически уменьшаем, пока JSON не уложится в target. Каждый
    // проход строго уменьшает payload (минимум на 1 символ).
    for (let pass = 0; pass < 200; pass++) {
      let len
      try {
        len = JSON.stringify(snap).length
      } catch {
        // Несериализуемый snapshot — откат к минимальному безопасному.
        return buildMinimalSnapshot(snap, cap, omissionsArr, truncatedFlag)
      }
      if (len <= cap) return
      // Достижим ли target за разумное число шагов? Защита от зацикливания: если
      // длина перестала уменьшаться — сразу к minimal snapshot.
      if (len === prevLen) {
        return buildMinimalSnapshot(snap, cap, omissionsArr, truncatedFlag)
      }
      prevLen = len

      // Выбираем самое тяжёлое поле и режем его.
      const textLen = typeof snap.text === 'string' ? snap.text.length : 0
      const selLen = typeof snap.selection === 'string' ? snap.selection.length : 0
      const tablesLen = measureTablesChars(snap.tables)
      const omLen = measureOmissionsChars(snap.omissions)

      // Режем самое тяжёлое. Каждый раз уменьшаем вдвое, не менее чем на 1.
      if (textLen >= selLen && textLen >= tablesLen && textLen >= omLen && textLen > 0) {
        snap.text = halveString(snap.text)
        truncatedFlag.text = true
      } else if (tablesLen >= selLen && tablesLen >= omLen && tablesLen > 0) {
        shrinkTablesByHalf(snap)
        truncatedFlag.tables = true
      } else if (selLen >= omLen && selLen > 0) {
        snap.selection = halveString(snap.selection)
        truncatedFlag.selection = true
      } else if (omLen > 0) {
        // Omissions — служебные маркеры, режем последние.
        snap.omissions = halveOmissions(snap.omissions)
      } else {
        // Резать больше нечего, но длина всё ещё > cap → minimal snapshot.
        return buildMinimalSnapshot(snap, cap, omissionsArr, truncatedFlag)
      }
    }

    // Если за 200 проходов не уложились — minimal snapshot.
    return buildMinimalSnapshot(snap, cap, omissionsArr, truncatedFlag)
  }

  function halveString(s) {
    if (typeof s !== 'string' || s.length === 0) return ''
    const half = Math.floor(s.length / 2)
    return s.slice(0, Math.max(0, half))
  }

  function measureTablesChars(tables) {
    if (!Array.isArray(tables)) return 0
    let total = 0
    for (const t of tables) {
      if (!t) continue
      if (typeof t.caption === 'string') total += t.caption.length
      if (Array.isArray(t.rows)) {
        for (const row of t.rows) {
          if (Array.isArray(row)) {
            for (const cell of row) {
              if (typeof cell === 'string') total += cell.length
            }
          }
        }
      }
    }
    return total
  }

  function measureOmissionsChars(omissions) {
    if (!Array.isArray(omissions)) return 0
    let total = 0
    for (const o of omissions) {
      if (typeof o === 'string') total += o.length
    }
    return total
  }

  function shrinkTablesByHalf(snap) {
    if (!Array.isArray(snap.tables) || snap.tables.length === 0) return
    // Сначала выкидываем целые таблицы с конца, пока их не станет вполовину.
    const halfCount = Math.max(1, Math.floor(snap.tables.length / 2))
    if (snap.tables.length > halfCount) {
      snap.tables.length = halfCount
      return
    }
    // Если таблица одна — режем её ячейки наполовину.
    const t = snap.tables[0]
    if (!t) return
    if (Array.isArray(t.rows) && t.rows.length > 0) {
      const halfRows = Math.max(1, Math.floor(t.rows.length / 2))
      if (t.rows.length > halfRows) {
        t.rows.length = halfRows
        return
      }
      // Режем ячейки последней строки.
      const lastRow = t.rows[t.rows.length - 1]
      if (Array.isArray(lastRow) && lastRow.length > 0) {
        const halfCells = Math.max(1, Math.floor(lastRow.length / 2))
        if (lastRow.length > halfCells) {
          lastRow.length = halfCells
          return
        }
        const lastCell = lastRow[lastRow.length - 1]
        if (typeof lastCell === 'string' && lastCell.length > 0) {
          lastRow[lastRow.length - 1] = lastCell.slice(0, Math.floor(lastCell.length / 2))
        }
      }
    }
  }

  function halveOmissions(omissions) {
    if (!Array.isArray(omissions) || omissions.length === 0) return []
    const half = Math.max(1, Math.floor(omissions.length / 2))
    return omissions.slice(0, half)
  }

  function buildMinimalSnapshot(snap, cap, omissionsArr, truncatedFlag) {
    // Финальный аварийный откат: минимальный snapshot, гарантированно ≤ cap.
    // Сохраняем schemaVersion, capturedAt и source, всё остальное — пустое.
    snap.text = ''
    snap.selection = ''
    snap.tables = []
    // Оставляем минимум omissions — cap-marker + один старый, если был.
    const kept = []
    if (Array.isArray(snap.omissions)) {
      for (const o of snap.omissions) {
        if (typeof o === 'string' && o.length < 200) kept.push(o)
        if (kept.length >= 2) break
      }
    }
    kept.push('json-hard-cap: minimal snapshot (payload exceeded ' + cap + ')')
    snap.omissions = kept
    truncatedFlag.text = true
    truncatedFlag.selection = true
    truncatedFlag.tables = true

    // Финальная проверка: если и minimal snapshot почему-то > cap, режем title.
    let len
    try { len = JSON.stringify(snap).length } catch { len = cap + 1 }
    if (len > cap && snap.source && typeof snap.source.title === 'string') {
      snap.source.title = ''
    }
    // Если URL экстремально длинный — обрежем и его.
    try { len = JSON.stringify(snap).length } catch { len = cap + 1 }
    if (len > cap && snap.source && typeof snap.source.url === 'string') {
      snap.source.url = snap.source.url.slice(0, Math.max(0, snap.source.url.length - (len - cap) - 100))
    }
  }
}

// Версия API (для sidepanel и тестов). Не используется внутри executeScript.
export const EXTRACTOR_VERSION = 1
