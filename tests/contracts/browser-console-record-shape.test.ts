// Форма записи консоли встроенного браузера: ПРОИЗВОДИТЕЛЬ ↔ ЧИТАТЕЛЬ.
//
// Зачем отдельная сетка, если редакция уже покрыта (tests/ipc/browser-redact.test.ts).
// Та сетка проверяла ЧИТАТЕЛЯ на фикстурах, написанных в форме читателя, — и потому
// была зелёной ровно тогда, когда продукт был сломан: renderer клал `{level, message}`,
// читатель брал `m.text`, модель получала пустой текст у КАЖДОЙ записи, а числовые
// уровни трактовались зеркально, из-за чего настоящий `console.error` выпадал из
// выдачи целиком. Класс §3.1 — фикстура не совпала с продовой формой вызова.
//
// Поэтому здесь проверяется не «читатель умеет читать», а СВЯЗЬ: то, что кладёт
// producer, доезжает до модели с текстом и верным уровнем. Фикстура событий взята из
// ЖИВОГО замера (Electron 40, настоящее DOM-событие console-message элемента
// <webview>, 15.08) — не из головы и не из формы читателя.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  consoleRecordFromWebviewEvent, normalizeConsoleLevel,
} from '../../shared/browser-console-record'
import {
  capConsoleErrors, redactConsoleMessage, UNKNOWN_CONSOLE_SHAPE,
} from '../../electron/ipc/tool-handlers/browser-redact'

const browserView = readFileSync(join(process.cwd(), 'src/components/BrowserView.tsx'), 'utf8')

// ЖИВОЙ ЗАМЕР 15.08 (Electron 40, <webview> console-message): что именно приходит на
// каждый вызов консоли страницы. Уровни — числа, текст — в ключе `message`,
// источник — в `sourceId`; ключа `text` в событии нет вовсе.
const LIVE_WEBVIEW_EVENTS = [
  { call: 'console.debug', level: 0, message: 'L-DEBUG', line: 5, sourceId: 'app.js' },
  { call: 'console.log', level: 1, message: 'L-LOG', line: 2, sourceId: 'app.js' },
  { call: 'console.info', level: 1, message: 'L-INFO', line: 3, sourceId: 'app.js' },
  { call: 'console.warn', level: 2, message: 'L-WARN', line: 4, sourceId: 'app.js' },
  { call: 'console.error', level: 3, message: 'TypeError: cfg is undefined', line: 12, sourceId: 'app.js' },
]

describe('уровни webview трактуются по живому замеру, а не по памяти автора', () => {
  it('0/1/2/3 → debug/info/warning/error', () => {
    expect(normalizeConsoleLevel(0)).toBe('debug')
    expect(normalizeConsoleLevel(1)).toBe('info')
    expect(normalizeConsoleLevel(2)).toBe('warning')
    expect(normalizeConsoleLevel(3)).toBe('error')
  })

  it('строковые уровни (Playwright-среда) читаются как раньше — одна таблица на обе среды', () => {
    expect(normalizeConsoleLevel('error')).toBe('error')
    expect(normalizeConsoleLevel('warn')).toBe('warning')
    expect(normalizeConsoleLevel('warning')).toBe('warning')
    expect(normalizeConsoleLevel('verbose')).toBe('debug')
    expect(normalizeConsoleLevel('info')).toBe('info')
  })
})

describe('запись producer’а доезжает до модели', () => {
  it('console.error страницы приходит модели С ТЕКСТОМ и уровнем error', () => {
    const buffer = LIVE_WEBVIEW_EVENTS.map(consoleRecordFromWebviewEvent)
    const out = capConsoleErrors(buffer, 20)
    const err = out.messages.find(m => m.level === 'error')
    expect(err).toBeDefined()
    // Главное утверждение всей сетки: текст НЕ пустой. Именно он был пуст в проде.
    expect(err?.text).toBe('TypeError: cfg is undefined')
    expect(err?.line).toBe(12)
    expect(err?.source).toBe('app.js')
  })

  it('в выдачу попадают ровно warning+error, обычный лог — нет', () => {
    const buffer = LIVE_WEBVIEW_EVENTS.map(consoleRecordFromWebviewEvent)
    const out = capConsoleErrors(buffer, 20)
    expect(out.messages.map(m => m.level)).toEqual(['warning', 'error'])
    // КОНТРОЛЬ к «лог не попал»: он не попал потому, что отфильтрован, а не потому,
    // что буфер пуст или текст потерян по дороге (иначе пин ничего не измеряет).
    expect(buffer.map(r => r.text)).toContain('L-LOG')
    expect(out.count).toBe(2)
  })
})

describe('renderer не строит запись своим литералом', () => {
  it('BrowserView кладёт в буфер результат общего билдера', () => {
    expect(browserView).toContain('consoleRecordFromWebviewEvent(ev)')
  })

  it('в буфер консоли не пишется ключ `message` (та самая разошедшаяся форма)', () => {
    const onConsole = browserView.slice(
      browserView.indexOf('const onConsole = '),
      browserView.indexOf('const onNav = '),
    )
    expect(onConsole).not.toMatch(/message\s*:/)
  })
})

describe('расхождение формы оставляет СЛЕД, а не пустую строку', () => {
  it('запись без ключа `text` помечается явно', () => {
    const m = redactConsoleMessage({ level: 3, message: 'TypeError: cfg is undefined' } as Record<string, unknown>)
    expect(m.text).toBe(UNKNOWN_CONSOLE_SHAPE)
    expect(m.level).toBe('error')
  })

  it('КОНТРОЛЬ: честно пустое сообщение остаётся пустым, ложной пометки нет', () => {
    expect(redactConsoleMessage({ level: 3, text: '' }).text).toBe('')
  })
})
