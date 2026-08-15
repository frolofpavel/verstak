/**
 * ОДНА форма записи консоли для браузерных сред: источник истины сразу для
 * производителя (renderer, DOM-событие <webview>), читателя (`browser-redact` в main)
 * и пинов.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ, а не литерал в компоненте. До 15.08 форма жила в трёх
 * местах и в двух из них разошлась: renderer клал `{ level, message }`,
 * `redactConsoleMessage` читал `m.text` — и модель получала `text: ''` у КАЖДОЙ
 * записи. Ни один тест не краснел: фикстуры сеток были написаны в форме ЧИТАТЕЛЯ, а
 * не производителя (класс §3.1 — «тест, чья фикстура не совпадает с продовой формой
 * вызова, не защищает ничего и не сообщает об этом»). Пока форма — литерал внутри
 * компонента, расхождению нечему краснеть; вынесенная в shared/, она даёт то одно
 * место, где производителя и читателя проверяет общий пин. Это тот же приём, что у
 * `shared/browser-snapshot.ts` и `shared/browser-slot-style.ts`.
 *
 * ЖИВОЙ ЗАМЕР (Electron 40, настоящее DOM-событие `console-message` элемента
 * <webview> — ровно продовый producer, 15.08): console.debug→0, console.log→1,
 * console.info→1, console.warn→2, console.error→3; поля события — `message`, `line`,
 * `sourceId`, ключа `text` в нём нет вовсе. Прежняя числовая таблица в main
 * (2→error, 3→debug) была зеркальной: настоящая ошибка страницы становилась `debug`
 * и выпадала из фильтра `error+warning` совсем, а обычный лог ехал модели как
 * warning. Отсюда правило: числовой уровень трактуется ТОЛЬКО по порядку Electron
 * (verbose, info, warning, error), и менять его без нового замера нельзя.
 */

export type ConsoleLevel = 'log' | 'info' | 'warning' | 'error' | 'debug'

/** Каноническая запись: то, что кладёт производитель и читает `redactConsoleMessage`. */
export interface ConsoleRecord {
  level: ConsoleLevel
  text: string
  line?: number
  source?: string
}

/**
 * Уровень к канону. Строки приходят от Playwright-среды (`msg.type()`), числа — от
 * webview. ОДНА реализация на оба пути: разъехавшиеся копии этой таблицы и есть
 * разобранный выше дефект.
 */
export function normalizeConsoleLevel(level: unknown): ConsoleLevel {
  if (typeof level === 'string') {
    const l = level.toLowerCase()
    if (l === 'warn' || l === 'warning') return 'warning'
    if (l === 'error') return 'error'
    if (l === 'debug' || l === 'verbose') return 'debug'
    if (l === 'info') return 'info'
    return 'log'
  }
  if (level === 3) return 'error'
  if (level === 2) return 'warning'
  if (level === 1) return 'info'
  if (level === 0) return 'debug'
  return 'log'
}

/** Форма события `console-message` у элемента <webview> (замер выше). */
export interface WebviewConsoleEvent { level?: unknown; message?: unknown; line?: unknown; sourceId?: unknown }

/**
 * Событие webview → каноническая запись. Единственное место, где имена полей
 * СОБЫТИЯ (`message`/`sourceId`) переводятся в имена полей ЗАПИСИ (`text`/`source`).
 * Редакции и фильтрации здесь нет — они остаются в main, где живёт secret-scanner.
 */
export function consoleRecordFromWebviewEvent(ev: WebviewConsoleEvent): ConsoleRecord {
  const rec: ConsoleRecord = {
    level: normalizeConsoleLevel(ev.level),
    text: String(ev.message ?? ''),
  }
  if (typeof ev.line === 'number') rec.line = ev.line
  if (ev.sourceId) rec.source = String(ev.sourceId)
  return rec
}
