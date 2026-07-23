// @vitest-environment jsdom
//
// extractor.test.ts — privacy-first гейт VSK-EXT-A1-R1.
//
// Все тесты ниже — RED-first: они написаны под подтверждённые утечки предыдущей
// версии (contenteditable drafts, raw cell.textContent, рекурсивный stack overflow,
// отсутствие computed-style проверки и т.д.). SECRET-маркеры нигде не должны
// оказаться ни в одном поле снимка.
//
// Импорт .mjs — через file URL; экспортируемая функция должна быть self-contained.

import { describe, it, expect } from 'vitest'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXT_DIR = resolve(HERE, '..', '..', 'browser-extension')
const EXTRACTOR_URL = pathToFileURL(join(EXT_DIR, 'extractor.mjs')).href

interface Table {
  caption: string
  rows: string[][]
}
interface Snapshot {
  schemaVersion: number
  capturedAt: string
  source: { kind: string; url: string; title: string }
  selection: string
  text: string
  tables: Table[]
  controls?: Array<{ elementRef: string; role: string; label: string; observationVersion: number }>
  observationVersion?: number
  omissions: string[]
  truncated: { text: boolean; selection: boolean; tables: boolean }
}

const { capturePageSnapshot } = await import(EXTRACTOR_URL) as {
  capturePageSnapshot: (opts?: Record<string, unknown>) => Snapshot
}

function setLocation(href: string) {
  try { window.history.replaceState({}, '', href) } catch { /* ignore */ }
}

function resetDocument() {
  document.documentElement.innerHTML = ''
  const body = document.createElement('body')
  document.documentElement.appendChild(body)
}

function setBodyHtml(html: string) {
  resetDocument()
  document.body.innerHTML = html
}

// Любой SECRET-маркер не должен встречаться нигде в сериализованном снимке.
function assertNoSecrets(snap: Snapshot, secrets: string[]) {
  const json = JSON.stringify(snap)
  for (const s of secrets) {
    expect(json, `утёк SECRET-маркер "${s}" в snapshot:\n${json}`).not.toContain(s)
  }
}

// Выделить диапазон внутри указанного селектора (внутри element).
function selectInside(element: Element) {
  const sel = window.getSelection()
  sel?.removeAllRanges()
  const range = document.createRange()
  range.selectNodeContents(element)
  sel?.addRange(range)
}

describe('capturePageSnapshot — privacy hardening VSK-EXT-A1-R1', () => {

  // ── Сценарии 1-3: contenteditable во всех вариантах исключается ────────────

  it('1. contenteditable="" исключён из text', () => {
    setBodyHtml(`
      <p>SAFE_VISIBLE_TEXT</p>
      <div contenteditable="">EDITABLE_EMPTY_ATTR_DRAFT</div>
    `)
    const snap = capturePageSnapshot()
    expect(snap.text).toContain('SAFE_VISIBLE_TEXT')
    expect(snap.text).not.toContain('EDITABLE_EMPTY_ATTR_DRAFT')
    assertNoSecrets(snap, ['EDITABLE_EMPTY_ATTR_DRAFT'])
  })

  it('2. body contenteditable исключён из text', () => {
    resetDocument()
    // body нельзя задать innerHTML после назначения contenteditable, делаем через атрибут.
    document.body.setAttribute('contenteditable', 'true')
    document.body.innerHTML = '<p>BODY_EDITOR_DRAFT</p>'
    // Полностью заменить body на editable не выйдет в jsdom — но проверим сценарий,
    // когда корневой body помечен как редактируемый. Safe-маркер через дочерний span.
    document.body.insertAdjacentHTML('beforeend', '<span>SAFE_OUTSIDE</span>')
    const snap = capturePageSnapshot()
    // BODY_EDITOR_DRAFT — внутри редактируемого body, должен уйти.
    // SAFE_OUTSIDE — тоже внутри body, но сам body редактируем → тоже исключается по контракту.
    expect(snap.text).not.toContain('BODY_EDITOR_DRAFT')
    assertNoSecrets(snap, ['BODY_EDITOR_DRAFT'])
  })

  it('3. contenteditable="plaintext-only" исключён из text', () => {
    setBodyHtml(`
      <p>SAFE_PLAIN</p>
      <div contenteditable="plaintext-only">PLAINTEXT_DRAFT</div>
    `)
    const snap = capturePageSnapshot()
    expect(snap.text).toContain('SAFE_PLAIN')
    expect(snap.text).not.toContain('PLAINTEXT_DRAFT')
    assertNoSecrets(snap, ['PLAINTEXT_DRAFT'])
  })

  // ── Сценарии 4-5: безопасное selection ─────────────────────────────────────

  it('4. обычное selection сохраняется', () => {
    setBodyHtml(`<p>SELECT_ME_SAFE</p>`)
    const target = document.querySelector('p')!
    selectInside(target)
    const snap = capturePageSnapshot()
    expect(snap.selection).toContain('SELECT_ME_SAFE')
  })

  it('5. selection внутри contenteditable исключается', () => {
    setBodyHtml(`
      <div contenteditable="true"><p>EDITABLE_SELECTION_SECRET</p></div>
    `)
    const target = document.querySelector('p')!
    selectInside(target)
    const snap = capturePageSnapshot()
    expect(snap.selection).not.toContain('EDITABLE_SELECTION_SECRET')
    assertNoSecrets(snap, ['EDITABLE_SELECTION_SECRET'])
  })

  // ── Сценарий 6: ячейки таблицы — проходит тот же фильтр ─────────────────────

  it('6. ячейка содержит SAFE + формы/скрипт/hidden/CSS-hidden — остаётся только SAFE', () => {
    setBodyHtml(`
      <table>
        <tr>
          <td>
            SAFE_CELL
            <textarea>TEXTAREA_SECRET</textarea>
            <input value="INPUT_SECRET" />
            <select><option>OPTION_SECRET</option></select>
            <button>BUTTON_SECRET</button>
            <div contenteditable="true">CELL_EDITABLE_SECRET</div>
            <script>SCRIPT_SECRET=1</script>
            <style>.x{color:red;STYLE_SECRET}</style>
            <div hidden>HIDDEN_SECRET</div>
            <div aria-hidden="true">ARIA_SECRET</div>
            <div style="display:none">DISPLAY_NONE_SECRET</div>
            <div style="visibility:hidden">VISIBILITY_HIDDEN_SECRET</div>
          </td>
        </tr>
      </table>
    `)
    const snap = capturePageSnapshot()
    expect(snap.tables.length).toBe(1)
    expect(snap.tables[0].rows.length).toBe(1)
    const cell = snap.tables[0].rows[0][0]
    expect(cell).toContain('SAFE_CELL')
    // BUTTON_SECRET may appear only in C1 controls map (visible button label for click),
    // never in text/tables/selection (privacy text path).
    const secretsNoButton = [
      'TEXTAREA_SECRET', 'INPUT_SECRET', 'OPTION_SECRET',
      'CELL_EDITABLE_SECRET', 'SCRIPT_SECRET', 'STYLE_SECRET',
      'HIDDEN_SECRET', 'ARIA_SECRET', 'DISPLAY_NONE_SECRET', 'VISIBILITY_HIDDEN_SECRET',
    ]
    for (const s of [...secretsNoButton, 'BUTTON_SECRET']) {
      expect(cell, `ячейка содержит утечку "${s}"`).not.toContain(s)
    }
    expect(snap.text).not.toContain('BUTTON_SECRET')
    assertNoSecrets(snap, secretsNoButton)
    // Password/form values still forbidden in controls; plain button labels OK for C1.
    const ctrlJson = JSON.stringify(snap.controls || [])
    expect(ctrlJson).not.toContain('INPUT_SECRET')
    expect(ctrlJson).not.toContain('TEXTAREA_SECRET')
  })

  // ── Сценарий 7: caption и th проходят тот же фильтр ────────────────────────

  it('7. caption и th фильтруются так же строго, как td', () => {
    setBodyHtml(`
      <table>
        <caption>
          SAFE_CAPTION
          <input value="CAPTION_INPUT_SECRET" />
          <div contenteditable="true">CAPTION_EDITABLE_SECRET</div>
          <script>CAPTION_SCRIPT_SECRET=1</script>
          <div hidden>CAPTION_HIDDEN_SECRET</div>
        </caption>
        <thead>
          <tr>
            <th>
              SAFE_TH
              <textarea>TH_TEXTAREA_SECRET</textarea>
              <div style="display:none">TH_DISPLAY_NONE_SECRET</div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr><td>SAFE_TD</td></tr>
        </tbody>
      </table>
    `)
    const snap = capturePageSnapshot()
    const cap = snap.tables[0].caption
    // caption и th должны фильтроваться единым механизмом с ячейками.
    expect(cap).toContain('SAFE_CAPTION')
    const th = snap.tables[0].rows[0][0]
    expect(th).toContain('SAFE_TH')
    const secrets = [
      'CAPTION_INPUT_SECRET', 'CAPTION_EDITABLE_SECRET', 'CAPTION_SCRIPT_SECRET',
      'CAPTION_HIDDEN_SECRET', 'TH_TEXTAREA_SECRET', 'TH_DISPLAY_NONE_SECRET',
    ]
    assertNoSecrets(snap, secrets)
  })

  // ── Сценарий 8: CSS-класс display:none распознаётся через computed style ───

  it('8. CSS-класс с display:none распознаётся как скрытый', () => {
    // Инжектим стиль, скрывающий класс .secret-hidden через display:none.
    const style = document.createElement('style')
    style.textContent = '.secret-hidden { display: none; } .secret-vis { visibility: hidden; }'
    document.head.appendChild(style)
    setBodyHtml(`
      <p>SAFE_VISIBLE</p>
      <div class="secret-hidden">CLASS_HIDDEN_SECRET</div>
      <div class="secret-vis">CLASS_VIS_SECRET</div>
    `)
    // Повторно инжектим стиль после setBodyHtml (он очищает head косвенно через innerHTML body).
    const style2 = document.createElement('style')
    style2.textContent = '.secret-hidden { display: none; } .secret-vis { visibility: hidden; }'
    document.head.appendChild(style2)
    const snap = capturePageSnapshot()
    expect(snap.text).toContain('SAFE_VISIBLE')
    expect(snap.text).not.toContain('CLASS_HIDDEN_SECRET')
    expect(snap.text).not.toContain('CLASS_VIS_SECRET')
    assertNoSecrets(snap, ['CLASS_HIDDEN_SECRET', 'CLASS_VIS_SECRET'])
  })

  // ── Сценарий 9: form subtree исключается целиком ───────────────────────────

  it('9. form subtree исключается целиком', () => {
    setBodyHtml(`
      <p>SAFE_OUTSIDE_FORM</p>
      <form>
        <label>SAFE_LABEL_INSIDE_FORM</label>
        <input value="FORM_INPUT_SECRET" />
        <p>FORM_TEXT_SECRET</p>
        <div>FORM_DIV_TEXT</div>
      </form>
    `)
    const snap = capturePageSnapshot()
    expect(snap.text).toContain('SAFE_OUTSIDE_FORM')
    expect(snap.text).not.toContain('FORM_INPUT_SECRET')
    expect(snap.text).not.toContain('FORM_TEXT_SECRET')
    // По контракту форма исключается целиком — значит и текст внутри form/div тоже.
    expect(snap.text).not.toContain('FORM_DIV_TEXT')
    assertNoSecrets(snap, ['FORM_INPUT_SECRET', 'FORM_TEXT_SECRET', 'FORM_DIV_TEXT'])
  })

  // ── Сценарий 10: Deep DOM не вызывает stack overflow в extractor ────────────
  //
  // Внимание: jsdom сам по себе не способен построить DOM с глубиной 20000
  // (его `_descendantAdded` рекурсивен и валит стек до этого предела).
  // Поэтому тест строит максимально достижимую глубину (1000) и проверяет:
  //   (а) сам extractor не падает на этом DOM;
  //   (б) строковое представление функции не содержит рекурсивных вызовов
  //       collectVisibleText/collapseWhitespace внутри себя (static-proof, что
  //       обход итеративный). Это отделяет нашу регрессию от ограничений jsdom.

  it('10. глубокий DOM не вызывает stack overflow в extractor (итеративный обход)', () => {
    resetDocument()
    setLocation('https://example.com/deep')
    // 1000 глубоких узлов — стабильный потолок для jsdom в vitest.
    let cursor: HTMLElement = document.body
    for (let i = 0; i < 1000; i++) {
      const div = document.createElement('div')
      div.textContent = 'd' + i
      cursor.appendChild(div)
      cursor = div
    }
    expect(() => {
      const snap = capturePageSnapshot()
      expect(typeof snap).toBe('object')
      expect(snap.schemaVersion).toBe(1)
    }).not.toThrow()
  }, 60000)

  it('10b. capturePageSnapshot.toString() не содержит рекурсивных вызовов обхода', () => {
    const src = capturePageSnapshot.toString()
    // Итеративный collectVisibleText должен вызывать себя через stack.push/pop,
    // а НЕ через прямую рекурсию вида `walk(child, top)`.
    const fnStart = src.indexOf('function collectVisibleText')
    expect(fnStart, 'collectVisibleText должна быть определена').toBeGreaterThan(-1)
    // Тело функции — от fnStart до следующей function верхнего уровня.
    const after = src.slice(fnStart)
    const bodyEnd = after.indexOf('\n  function ')
    const body = after.slice(0, bodyEnd > 0 ? bodyEnd : after.length)
    // Первый токен — это `function collectVisibleText(` — объявление, не вызов.
    // Прямая рекурсия: имя функции встречается ВНУТРИ тела (после объявления).
    // Убираем строку объявления из анализа.
    const headerEnd = body.indexOf(') {') + ') {'.length
    const bodyOnly = body.slice(headerEnd)
    const recursionHits = (bodyOnly.match(/collectVisibleText\s*\(/g) || []).length
    expect(
      recursionHits,
      'collectVisibleText содержит прямую рекурсию — обход должен быть итеративным'
    ).toBe(0)
  })

  // ── Сценарий 11: node budget создаёт omission marker ───────────────────────
  //
  // Аналогично deep DOM: построение 50000 узлов в jsdom упирается в перфоманс.
  // Используем option-инжект nodeBudgetLimit (меньше значения по умолчанию),
  // чтобы реалистично проверить путь «бюджет превышен → omission marker».

  it('11. node budget превышен → omission marker в omissions', () => {
    resetDocument()
    // ВАЖНО: URL НЕ должен содержать слово "budget" — иначе старый ложный тест
    // матчит это слово в JSON, а не реальный omission marker.
    setLocation('https://example.com/limit-check')
    // 200 узлов + их 200 текстовых = 400 < дефолта, но опция nodeBudgetLimit=50
    // искусственно уронит бюджет после первых 50 узлов.
    for (let i = 0; i < 200; i++) {
      const span = document.createElement('span')
      span.textContent = 'x' + i
      document.body.appendChild(span)
    }
    const snap = capturePageSnapshot({ nodeBudgetLimit: 50 } as Record<string, unknown>)
    // Точный маркер в omissions[], не grep по всему JSON.
    const hasMarker = Array.isArray(snap.omissions) &&
      snap.omissions.some((m) => typeof m === 'string' && m.includes('node-budget-exceeded'))
    expect(
      hasMarker,
      'ожидался omission marker "node-budget-exceeded" в snap.omissions, фактически: ' + JSON.stringify(snap.omissions)
    ).toBe(true)
    // Маркер должен отражать ужесточённое значение из options (50), а не дефолт (50000).
    const marker = snap.omissions.find((m) => typeof m === 'string' && m.includes('node-budget-exceeded'))
    expect(marker, 'маркер должен содержать фактический limit=50').toContain('limit=50')
  })

  // ── Сценарий 12: URL обрезается до 2048 ────────────────────────────────────

  it('12. URL обрезается до 2048 символов', () => {
    resetDocument()
    // jsdom не даёт cross-origin, используем same-origin с длинным pathname.
    const longPath = 'a'.repeat(3000)
    setLocation('http://localhost:3000/' + longPath)
    const snap = capturePageSnapshot()
    expect(snap.source.url.length).toBeLessThanOrEqual(2048)
  })

  // ── Сценарий 13: общий table budget (40000) ────────────────────────────────

  it('13. общий текст таблиц не превышает 40000 символов', () => {
    resetDocument()
    setLocation('https://example.com/tablebudget')
    // 5 таблиц × 50 строк × 20 ячеек × 500 chars теоретически = 2.5M.
    // Делаем реальные ячейки по 500 символов, чтобы проверить cap 40000.
    const cell500 = 'C'.repeat(500)
    for (let ti = 0; ti < 5; ti++) {
      const tbl = document.createElement('table')
      for (let r = 0; r < 50; r++) {
        const tr = document.createElement('tr')
        // Минимум ячеек для укладки в тестовый таймаут.
        for (let c = 0; c < 5; c++) {
          const td = document.createElement('td')
          td.textContent = cell500
          tr.appendChild(td)
        }
        tbl.appendChild(tr)
      }
      document.body.appendChild(tbl)
    }
    const snap = capturePageSnapshot()
    let totalTableChars = 0
    for (const t of snap.tables) {
      for (const row of t.rows) {
        for (const cell of row) totalTableChars += cell.length
      }
      if (t.caption) totalTableChars += t.caption.length
    }
    expect(totalTableChars).toBeLessThanOrEqual(40000)
  }, 120000)

  // ── Сценарий 14: JSON snapshot ≤ 120000 ────────────────────────────────────

  it('14. итоговый JSON snapshot не превышает 120000 символов', () => {
    resetDocument()
    setLocation('https://example.com/jsoncap')
    // Максимально раздутый snapshot: text 50k + таблицы.
    const big = 'A'.repeat(100000)
    const p = document.createElement('p')
    p.textContent = big
    document.body.appendChild(p)
    for (let ti = 0; ti < 5; ti++) {
      const tbl = document.createElement('table')
      for (let r = 0; r < 50; r++) {
        const tr = document.createElement('tr')
        for (let c = 0; c < 5; c++) {
          const td = document.createElement('td')
          td.textContent = 'B'.repeat(500)
          tr.appendChild(td)
        }
        tbl.appendChild(tr)
      }
      document.body.appendChild(tbl)
    }
    const snap = capturePageSnapshot()
    const json = JSON.stringify(snap)
    expect(json.length).toBeLessThanOrEqual(120000)
  }, 120000)

  // ── Сценарий 15: capturePageSnapshot.toString() восстанавливается и выполняется ──

  it('15. capturePageSnapshot.toString() — isolated function (без module scope)', async () => {
    const src = capturePageSnapshot.toString()
    // Функция должна быть self-contained: её можно восстановить из строкового
    // представления и вызвать в чистом контексте. Используем Function для изоляции.
    const restored = new Function('options', 'return (' + src + ')(options)')
    const result = restored({})
    expect(result).toBeDefined()
    expect(result.schemaVersion).toBe(1)
  })

  // ── Сценарий 16: в sidepanel.test.ts (отдельный файл) ──────────────────────

  // ── Сценарий 17: грязный omissions не создаёт [object Object] ──────────────
  // (проверяется в format-prompt.test.ts)

  // ── Сценарий 18: formatter hard cap ≤60000 (проверяется в format-prompt.test.ts) ─

  // ── Дополнительные RED-проверки утёкших ранее патологий ────────────────────

  it('RED-A. selection внутри form исключается', () => {
    setBodyHtml(`
      <form><p>FORM_SELECTION_SECRET</p></form>
    `)
    const target = document.querySelector('p')!
    selectInside(target)
    const snap = capturePageSnapshot()
    expect(snap.selection).not.toContain('FORM_SELECTION_SECRET')
    assertNoSecrets(snap, ['FORM_SELECTION_SECRET'])
  })

  it('RED-B. selection внутри hidden элемента исключается', () => {
    setBodyHtml(`
      <div hidden><p>HIDDEN_SELECTION_SECRET</p></div>
    `)
    const target = document.querySelector('p')!
    selectInside(target)
    const snap = capturePageSnapshot()
    expect(snap.selection).not.toContain('HIDDEN_SELECTION_SECRET')
    assertNoSecrets(snap, ['HIDDEN_SELECTION_SECRET'])
  })

  it('RED-C. contenteditable="false" внутри contenteditable="true" не реабилитирует поддерево', () => {
    // Privacy-first: если предок editable, потомок тоже не читается.
    setBodyHtml(`
      <div contenteditable="true">
        <div contenteditable="false">NESTED_FALSE_STILL_SECRET</div>
      </div>
    `)
    const snap = capturePageSnapshot()
    expect(snap.text).not.toContain('NESTED_FALSE_STILL_SECRET')
    assertNoSecrets(snap, ['NESTED_FALSE_STILL_SECRET'])
  })

  it('RED-D. пустой/частично сломанной страницы capture остаётся валидным', () => {
    resetDocument()
    setLocation('https://example.com/empty')
    const snap = capturePageSnapshot()
    expect(snap.schemaVersion).toBe(1)
    expect(Array.isArray(snap.tables)).toBe(true)
    expect(typeof snap.omissions).toBe('object')
  })

  it('RED-E. title ограничен 500', () => {
    resetDocument()
    setLocation('https://example.com/title')
    document.title = 'Т'.repeat(2000)
    const snap = capturePageSnapshot()
    expect(snap.source.title.length).toBeLessThanOrEqual(500)
  })

  it('RED-F. общий regression probe — SECRET-маркеры не появляются нигде', () => {
    setBodyHtml(`
      <p>SAFE_VISIBLE</p>
      <form>
        <input value="FORM_PROBE_SECRET" />
        <textarea>AREA_PROBE_SECRET</textarea>
      </form>
      <div contenteditable="true">EDIT_PROBE_SECRET</div>
      <div hidden>HIDDEN_PROBE_SECRET</div>
      <div aria-hidden="true">ARIA_PROBE_SECRET</div>
      <div style="display:none">DN_PROBE_SECRET</div>
      <div style="visibility:hidden">VH_PROBE_SECRET</div>
      <script>SCRIPT_PROBE_SECRET=1</script>
      <style>.x{SCRIPT_PROBE_SECRET}</style>
      <table>
        <tr>
          <td>
            CELL_SAFE
            <input value="CELL_INPUT_PROBE_SECRET" />
            <div contenteditable="true">CELL_EDIT_PROBE_SECRET</div>
          </td>
        </tr>
      </table>
    `)
    const snap = capturePageSnapshot()
    const secrets = [
      'FORM_PROBE_SECRET', 'AREA_PROBE_SECRET', 'EDIT_PROBE_SECRET',
      'HIDDEN_PROBE_SECRET', 'ARIA_PROBE_SECRET', 'DN_PROBE_SECRET',
      'VH_PROBE_SECRET', 'SCRIPT_PROBE_SECRET',
      'CELL_INPUT_PROBE_SECRET', 'CELL_EDIT_PROBE_SECRET',
    ]
    assertNoSecrets(snap, secrets)
    // SAFE-маркеры должны остаться.
    expect(snap.text).toContain('SAFE_VISIBLE')
    const json = JSON.stringify(snap)
    expect(json).toContain('CELL_SAFE')
  })

  // ════════════════════════════════════════════════════════════════════════════
  // VSK-EXT-A1-R2 — RED-first: закрытие оставшихся privacy-обходов.
  // Каждый тест ниже должен падать на R1 (до фикса), подтверждая утечку.
  // ════════════════════════════════════════════════════════════════════════════

  // ── R2-1..R2-7: таблица под приватным обёрткой-предком полностью исключается ─

  it('R2-1. таблица под <div hidden> полностью исключена', () => {
    setBodyHtml(`
      <div hidden>
        <table><tr><td>HIDDEN_PARENT_SECRET</td></tr></table>
      </div>
      <p>SAFE_VISIBLE</p>
    `)
    const snap = capturePageSnapshot()
    expect(snap.tables.length).toBe(0)
    assertNoSecrets(snap, ['HIDDEN_PARENT_SECRET'])
  })

  it('R2-2. таблица под aria-hidden="TRUE" (uppercase) исключена', () => {
    setBodyHtml(`
      <div aria-hidden="TRUE">
        <table><tr><td>ARIA_UPPER_PARENT_SECRET</td></tr></table>
      </div>
      <p>SAFE_VISIBLE</p>
    `)
    const snap = capturePageSnapshot()
    expect(snap.tables.length).toBe(0)
    assertNoSecrets(snap, ['ARIA_UPPER_PARENT_SECRET'])
  })

  it('R2-3. таблица под <form> исключена', () => {
    setBodyHtml(`
      <form>
        <table><tr><td>FORM_PARENT_SECRET</td></tr></table>
      </form>
      <p>SAFE_VISIBLE</p>
    `)
    const snap = capturePageSnapshot()
    expect(snap.tables.length).toBe(0)
    assertNoSecrets(snap, ['FORM_PARENT_SECRET'])
  })

  it('R2-4. таблица под contenteditable исключена', () => {
    setBodyHtml(`
      <div contenteditable="true">
        <table><tr><td>EDITABLE_PARENT_SECRET</td></tr></table>
      </div>
      <p>SAFE_VISIBLE</p>
    `)
    const snap = capturePageSnapshot()
    expect(snap.tables.length).toBe(0)
    assertNoSecrets(snap, ['EDITABLE_PARENT_SECRET'])
  })

  it('R2-5. таблица под CSS-классом display:none исключена', () => {
    resetDocument()
    const style = document.createElement('style')
    style.textContent = '.hidden-cls { display: none; }'
    document.head.appendChild(style)
    document.body.innerHTML = `
      <div class="hidden-cls">
        <table><tr><td>CSS_HIDDEN_PARENT_SECRET</td></tr></table>
      </div>
      <p>SAFE_VISIBLE</p>
    `
    const snap = capturePageSnapshot()
    expect(snap.tables.length).toBe(0)
    assertNoSecrets(snap, ['CSS_HIDDEN_PARENT_SECRET'])
  })

  it('R2-6. таблица под visibility:hidden (CSS-классом) исключена', () => {
    resetDocument()
    const style = document.createElement('style')
    style.textContent = '.vis-cls { visibility: hidden; }'
    document.head.appendChild(style)
    document.body.innerHTML = `
      <div class="vis-cls">
        <table><tr><td>VIS_HIDDEN_PARENT_SECRET</td></tr></table>
      </div>
      <p>SAFE_VISIBLE</p>
    `
    const snap = capturePageSnapshot()
    expect(snap.tables.length).toBe(0)
    assertNoSecrets(snap, ['VIS_HIDDEN_PARENT_SECRET'])
  })

  it('R2-7. сама <table hidden> исключена', () => {
    setBodyHtml(`
      <table hidden><tr><td>SELF_HIDDEN_SECRET</td></tr></table>
      <p>SAFE_VISIBLE</p>
    `)
    const snap = capturePageSnapshot()
    expect(snap.tables.length).toBe(0)
    assertNoSecrets(snap, ['SELF_HIDDEN_SECRET'])
  })

  // ── R2-8..R2-9: приватные таблицы не мешают захватить безопасную ────────────

  it('R2-8. пять приватных таблиц перед безопасной не мешают захватить безопасную', () => {
    setBodyHtml(`
      <div hidden><table><tr><td>SECRET_1</td></tr></table></div>
      <div hidden><table><tr><td>SECRET_2</td></tr></table></div>
      <div hidden><table><tr><td>SECRET_3</td></tr></table></div>
      <div hidden><table><tr><td>SECRET_4</td></tr></table></div>
      <div hidden><table><tr><td>SECRET_5</td></tr></table></div>
      <table><tr><td>SAFE_TABLE_CELL</td></tr></table>
    `)
    const snap = capturePageSnapshot()
    // Все приватные таблицы пропущены, безопасная взята — итог ровно 1.
    expect(snap.tables.length).toBe(1)
    expect(snap.tables[0].rows[0][0]).toContain('SAFE_TABLE_CELL')
    assertNoSecrets(snap, ['SECRET_1', 'SECRET_2', 'SECRET_3', 'SECRET_4', 'SECRET_5'])
  })

  it('R2-9. SAFE-таблица вне приватных обёрток сохраняется', () => {
    setBodyHtml(`
      <table>
        <caption>SAFE_CAPTION_R2</caption>
        <tr><td>SAFE_ROW1</td></tr>
        <tr><td>SAFE_ROW2</td></tr>
      </table>
    `)
    const snap = capturePageSnapshot()
    expect(snap.tables.length).toBe(1)
    expect(snap.tables[0].caption).toContain('SAFE_CAPTION_R2')
    expect(snap.tables[0].rows.length).toBe(2)
    expect(snap.tables[0].rows[0][0]).toContain('SAFE_ROW1')
  })

  // ── R2-10..R2-11: реальный общий table budget ───────────────────────────────

  it('R2-10. две таблицы по 25 000 символов вместе дают не более 40 000', () => {
    resetDocument()
    setLocation('https://example.com/r2-budget')
    // Две таблицы, в каждой достаточно ячеек, чтобы суммарно перепрыгнуть 40000.
    // Контракт: общий table budget 40000 — вторая таблица не должна получить
    // свежие 40000 сверху.
    const cellText = 'C'.repeat(500)
    for (let ti = 0; ti < 2; ti++) {
      const tbl = document.createElement('table')
      for (let r = 0; r < 50; r++) {
        const tr = document.createElement('tr')
        const td = document.createElement('td')
        td.textContent = cellText
        tr.appendChild(td)
        tbl.appendChild(tr)
      }
      document.body.appendChild(tbl)
    }
    const snap = capturePageSnapshot()
    let total = 0
    for (const t of snap.tables) {
      if (t.caption) total += t.caption.length
      for (const row of t.rows) for (const cell of row) total += cell.length
    }
    expect(total, 'суммарный table chars должен быть ≤ 40000').toBeLessThanOrEqual(40000)
  })

  it('R2-11. boundary 1 + 40000 не даёт 40001', () => {
    resetDocument()
    setLocation('https://example.com/r2-boundary')
    // Первая ячейка = 1 символ, дальше 80 ячеек по 500 = 40000.
    // Если budget капает строго по границе, суммарно должно быть ровно 40000,
    // а не 40001 (off-by-one).
    const tbl = document.createElement('table')
    let tr = document.createElement('tr')
    const td1 = document.createElement('td')
    td1.textContent = 'X'
    tr.appendChild(td1)
    tbl.appendChild(tr)
    // 80 ячеек по 500 символов в новых строках.
    for (let r = 0; r < 80; r++) {
      const tr2 = document.createElement('tr')
      const td = document.createElement('td')
      td.textContent = 'C'.repeat(500)
      tr2.appendChild(td)
      tbl.appendChild(tr2)
    }
    document.body.appendChild(tbl)
    const snap = capturePageSnapshot()
    let total = 0
    for (const t of snap.tables) {
      if (t.caption) total += t.caption.length
      for (const row of t.rows) for (const cell of row) total += cell.length
    }
    expect(total, 'boundary не должен дать 40001').toBeLessThanOrEqual(40000)
  })

  // ── R2-12..R2-15: живое selection без cloneContents ───────────────────────

  it('R2-12. Selection safe → CSS-hidden-by-ancestor → safe отбрасывается целиком', () => {
    // Один range пересекает безопасный узел И узел под скрытым предком.
    // По контракту: если range пересекает хотя бы один private-узел — весь range
    // отбрасывается (fail-closed).
    resetDocument()
    const style = document.createElement('style')
    style.textContent = '.hidden-cls { display: none; }'
    document.head.appendChild(style)
    document.body.innerHTML = `
      <div id="safe-zone"><span>SAFE_BEFORE_SECRET</span></div>
      <div class="hidden-cls"><span>CSS_ANCESTOR_SELECTION_SECRET</span></div>
    `
    // Создаём range, охватывающий оба дива.
    const safeZone = document.getElementById('safe-zone')!
    const hiddenZone = document.querySelector('.hidden-cls')!
    const sel = window.getSelection()
    sel?.removeAllRanges()
    const range = document.createRange()
    range.setStartBefore(safeZone)
    range.setEndAfter(hiddenZone)
    sel?.addRange(range)
    const snap = capturePageSnapshot()
    expect(snap.selection).not.toContain('SAFE_BEFORE_SECRET')
    expect(snap.selection).not.toContain('CSS_ANCESTOR_SELECTION_SECRET')
    assertNoSecrets(snap, ['CSS_ANCESTOR_SELECTION_SECRET'])
  })

  it('R2-13. контекстный CSS зависит от живого предка; секрет не появляется', () => {
    // body.private-mode .secret { display:none } — селектор зависит от класса body.
    // cloneContents() теряет body-context → секрет утечёт. Живой путь должен
    // увидеть реальный computed style.
    resetDocument()
    const style = document.createElement('style')
    style.textContent = 'body.private-mode .secret { display: none; }'
    document.head.appendChild(style)
    document.body.classList.add('private-mode')
    document.body.innerHTML = `
      <p>SAFE_VISIBLE</p>
      <p class="secret">CSS_ANCESTOR_SELECTION_SECRET</p>
    `
    // Выделяем оба параграфа одним range.
    const ps = document.querySelectorAll('p')
    const sel = window.getSelection()
    sel?.removeAllRanges()
    const range = document.createRange()
    range.setStartBefore(ps[0])
    range.setEndAfter(ps[1])
    sel?.addRange(range)
    const snap = capturePageSnapshot()
    expect(snap.selection).not.toContain('CSS_ANCESTOR_SELECTION_SECRET')
    assertNoSecrets(snap, ['CSS_ANCESTOR_SELECTION_SECRET'])
  })

  it('R2-14. подмена range.cloneContents на throw — новый код не вызывает cloneContents', () => {
    // Если R1-код всё ещё использует cloneContents, подмена его на throw сломает
    // логику (selection станет пустым через fail-closed или упадёт).
    // R2-код не должен вызывать cloneContents вообще → selection остаётся рабочим.
    setBodyHtml(`<p>SAFE_CLONECHECK</p>`)
    const target = document.querySelector('p')!
    const sel = window.getSelection()
    sel?.removeAllRanges()
    const range = document.createRange()
    range.selectNodeContents(target)
    sel?.addRange(range)

    // Подменяем cloneContents на throw — R2 не должен его вызывать.
    const originalClone = window.Range.prototype.cloneContents
    let cloneCalled = false
    window.Range.prototype.cloneContents = function () {
      cloneCalled = true
      throw new Error('cloneContents must not be called')
    }
    try {
      const snap = capturePageSnapshot()
      // Либо cloneContents не вызывался, либо selection пуст (fail-closed), но
      // исключения наружу не вылетает.
      expect(typeof snap).toBe('object')
      expect(cloneCalled, 'R2-код не должен вызывать range.cloneContents').toBe(false)
      // Обычное безопасное выделение должно сохраниться.
      expect(snap.selection).toContain('SAFE_CLONECHECK')
    } finally {
      window.Range.prototype.cloneContents = originalClone
    }
  })

  it('R2-15. огромный selection останавливается по node budget до полной материализации', () => {
    // 1000 узлов внутри одного range; nodeBudgetLimit=50 должен остановить сбор
    // без throw и без материализации гигантской строки.
    resetDocument()
    setLocation('https://example.com/r2-sel-budget')
    document.body.innerHTML = `<div id="container"></div>`
    const container = document.getElementById('container')!
    for (let i = 0; i < 1000; i++) {
      const span = document.createElement('span')
      span.textContent = 's' + i + ' '
      container.appendChild(span)
    }
    const sel = window.getSelection()
    sel?.removeAllRanges()
    const range = document.createRange()
    range.selectNodeContents(container)
    sel?.addRange(range)
    expect(() => {
      const snap = capturePageSnapshot({ nodeBudgetLimit: 50 } as Record<string, unknown>)
      expect(typeof snap).toBe('object')
      expect(snap.schemaVersion).toBe(1)
      // Selection длиной не превосходит лимит.
      expect(snap.selection.length).toBeLessThanOrEqual(5000)
    }).not.toThrow()
  })

  // ── R2-16..R2-17: escape amplification и огромные omissions vs JSON cap ────

  it('R2-16. escape amplification: много " и \\ — итоговый JSON строго ≤120000', () => {
    // JSON экранирует каждую кавычку в \" и каждый backslash в \\ — payload
    // в сериализованном виде может оказаться вдвое длиннее исходного.
    // Контракт: итоговый JSON ≤ 120000 при любых входных данных.
    resetDocument()
    setLocation('https://example.com/r2-escape')
    // 60000 символов половина кавычки/половина backslash → в JSON ~120000+.
    const payload = '"\\'.repeat(30000)
    const p = document.createElement('p')
    p.textContent = payload
    document.body.appendChild(p)
    const snap = capturePageSnapshot()
    const json = JSON.stringify(snap)
    expect(json.length, 'JSON с escape amplification должен быть ≤ 120000').toBeLessThanOrEqual(120000)
  })

  it('R2-17. огромные omissions также не пробивают JSON cap', () => {
    // Подсовываем экстремально длинные omissions через грязный path — здесь
    // симулируем через node budget (каждый узел добавляет omission-маркер? нет,
    // omission один). Поэтому проверяем escape-amplified omissions напрямую:
    // формируем selection с 5000 символов кавычек (selection попадёт в snapshot),
    // плюс text с 50000 backslashes — JSON не должен пробить 120000.
    resetDocument()
    setLocation('https://example.com/r2-omissions')
    const textPayload = '"\\'.repeat(25000)
    const p = document.createElement('p')
    p.textContent = textPayload
    document.body.appendChild(p)
    // Добавляем несколько «грязных» элементов, которые добавляют omissions.
    for (let i = 0; i < 100; i++) {
      const div = document.createElement('div')
      div.setAttribute('data-bad', '"' + '\\'.repeat(100) + '"')
      div.textContent = 'x'
      // contenteditable → будет omit в text-path.
      div.setAttribute('contenteditable', 'true')
      document.body.appendChild(div)
    }
    const snap = capturePageSnapshot()
    const json = JSON.stringify(snap)
    expect(json.length, 'JSON с огромными omissions должен быть ≤ 120000').toBeLessThanOrEqual(120000)
  })

  // ── R2-18: уже покрыт исправленным тестом #11 выше (точный marker check). ──

  // ── R2-19: прямой regression probe — ни одного SECRET во ВСЕХ полях ───────

  it('R2-19. прямой regression probe — ни одного SECRET во всех полях сериализованного snapshot', () => {
    resetDocument()
    const style = document.createElement('style')
    style.textContent = `
      .r2-hidden { display: none; }
      .r2-vis { visibility: hidden; }
      body.private .r2-ctx { display: none; }
    `
    document.head.appendChild(style)
    document.body.classList.add('private')
    document.body.innerHTML = `
      <p>SAFE_NORMAL</p>
      <div hidden><table><tr><td>HIDDEN_PARENT_SECRET</td></tr></table></div>
      <form><table><tr><td>FORM_PARENT_SECRET</td></tr></table></form>
      <div contenteditable="true"><table><tr><td>EDITABLE_PARENT_SECRET</td></tr></table></div>
      <div aria-hidden="true"><table><tr><td>ARIA_PARENT_SECRET</td></tr></table></div>
      <div class="r2-hidden"><table><tr><td>CSS_HIDDEN_PARENT_SECRET</td></tr></table></div>
      <div class="r2-vis"><table><tr><td>VIS_HIDDEN_PARENT_SECRET</td></tr></table></div>
      <div class="r2-ctx"><table><tr><td>CTX_CSS_PARENT_SECRET</td></tr></table></div>
      <table hidden><tr><td>SELF_HIDDEN_TABLE_SECRET</td></tr></table>
      <table>
        <caption>CAPTION_SAFE <input value="CAPTION_INPUT_SECRET" /></caption>
        <tr><td>CELL_SAFE <textarea>CELL_TA_SECRET</textarea></td></tr>
      </table>
      <form>
        <input value="FORM_INPUT_R2" />
        <textarea>FORM_TA_R2</textarea>
      </form>
      <div contenteditable="true">EDIT_R2</div>
      <div hidden>HIDDEN_R2</div>
      <div style="display:none">DN_R2</div>
      <script>SCRIPT_R2=1</script>
    `
    // Selection, охватывающий safe + secret-узлы.
    const safeP = document.querySelector('p')!
    const secretVis = document.querySelector('.r2-vis')!
    const sel = window.getSelection()
    sel?.removeAllRanges()
    const range = document.createRange()
    range.setStartBefore(safeP)
    range.setEndAfter(secretVis)
    sel?.addRange(range)

    const snap = capturePageSnapshot()
    const secrets = [
      'HIDDEN_PARENT_SECRET', 'FORM_PARENT_SECRET', 'EDITABLE_PARENT_SECRET',
      'ARIA_PARENT_SECRET', 'CSS_HIDDEN_PARENT_SECRET', 'VIS_HIDDEN_PARENT_SECRET',
      'CTX_CSS_PARENT_SECRET', 'SELF_HIDDEN_TABLE_SECRET',
      'CAPTION_INPUT_SECRET', 'CELL_TA_SECRET',
      'FORM_INPUT_R2', 'FORM_TA_R2', 'EDIT_R2', 'HIDDEN_R2', 'DN_R2', 'SCRIPT_R2',
    ]
    assertNoSecrets(snap, secrets)
    // SAFE-маркеры присутствуют.
    const json = JSON.stringify(snap)
    expect(json).toContain('SAFE_NORMAL')
    expect(json).toContain('CAPTION_SAFE')
    expect(json).toContain('CELL_SAFE')
  })
})
