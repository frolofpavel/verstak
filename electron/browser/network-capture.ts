/**
 * Захват сети in-app браузера на уровне main (session.webRequest).
 *
 * ЗАЧЕМ. Прежний рекордер жил В СТРАНИЦЕ (обёртка fetch/XHR, инжект на dom-ready,
 * BrowserView.NET_RECORDER). Запросы загрузки страницы — сам документ, скрипты,
 * ранние fetch до dom-ready — уходили РАНЬШЕ, чем рекордер успевал повеситься,
 * и сеть у модели всегда была пустой. session.webRequest в main видит КАЖДЫЙ
 * запрос вкладки с самого начала загрузки.
 *
 * ЧИСТЫЙ стор — без `import ... from 'electron'` на верхнем уровне: его тянет
 * tool-handler browser.ts, а тот не должен затаскивать electron в цепочку
 * (та же дисциплина, что у runtime-log.ts, §2 карты). Electron-склейку
 * (webRequest-слушатели + web-contents-created) делает main.ts, вызывая эти
 * функции.
 *
 * ГРАНИЦА. Пишем ТОЛЬКО для webContents вкладок браузера (тип 'webview'),
 * НЕ для главного окна и не для запросов провайдеров/обновлений — иначе в выдачу
 * утекла бы вся сеть приложения. main.ts регистрирует webview через trackWebview.
 */

export interface CapturedRequest {
  method: string
  url: string
  /** HTTP-статус; 0 — запрос завершился ошибкой (onErrorOccurred). null неизвестен. */
  status: number | null
  /** Длительность (мс) — если известен старт; иначе null. */
  durationMs: number | null
  /** Заголовки ЗАПРОСА (сырьё; auth маскируется редакцией в browser-redact при чтении). */
  headers?: Record<string, string>
}

/** Верхняя граница записей на вкладку (кольцевой буфер). Экспортируется для пина. */
export const MAX_PER_TAB = 200
// Верхняя граница «висящих» стартов (запрос начался, но не завершился) — чтобы
// незавершённые запросы не копили память бесконечно.
const MAX_PENDING = 1000

const tracked = new Set<number>()
const buffers = new Map<number, CapturedRequest[]>()
const pendingStart = new Map<number, { ts: number; headers?: Record<string, string> }>()
let lastActiveWcid: number | null = null

/** Пометить webContents вкладки браузера как отслеживаемый (тип 'webview'). */
export function trackWebview(wcid: number): void {
  tracked.add(wcid)
  lastActiveWcid = wcid
}

/** Забыть вкладку и её буфер (webview уничтожен). */
export function untrackWebview(wcid: number): void {
  tracked.delete(wcid)
  buffers.delete(wcid)
  if (lastActiveWcid === wcid) lastActiveWcid = null
}

export function isTrackedWebview(wcid: number | null | undefined): boolean {
  return wcid != null && tracked.has(wcid)
}

/** Новая страница во вкладке → сбросить её сеть (сеть привязана к странице). */
export function resetTab(wcid: number): void {
  if (buffers.has(wcid)) buffers.set(wcid, [])
  lastActiveWcid = wcid
}

/** Старт запроса (onSendHeaders): фиксируем время и заголовки запроса для длительности. */
export function noteStart(wcid: number, requestId: number, ts: number, headers?: Record<string, string>): void {
  if (!isTrackedWebview(wcid)) return
  pendingStart.set(requestId, { ts, headers })
  if (pendingStart.size > MAX_PENDING) {
    // Map хранит порядок вставки — вытесняем самый старый висящий старт.
    const oldest = pendingStart.keys().next().value
    if (oldest !== undefined) pendingStart.delete(oldest)
  }
}

/** Завершение запроса (onCompleted status=code / onErrorOccurred status=0). */
export function noteFinish(input: {
  wcid: number
  requestId: number
  ts: number
  method: string
  url: string
  status: number | null
  headers?: Record<string, string>
}): void {
  if (!isTrackedWebview(input.wcid)) return
  const start = pendingStart.get(input.requestId)
  pendingStart.delete(input.requestId)
  const buf = buffers.get(input.wcid) ?? []
  buf.push({
    method: String(input.method || 'GET').toUpperCase(),
    url: input.url,
    status: input.status,
    durationMs: start ? Math.round(input.ts - start.ts) : null,
    headers: input.headers ?? start?.headers,
  })
  if (buf.length > MAX_PER_TAB) buf.splice(0, buf.length - MAX_PER_TAB)
  buffers.set(input.wcid, buf)
  lastActiveWcid = input.wcid
}

/**
 * Прочитать захваченную сеть вкладки. Без аргумента — последняя активная вкладка
 * (в приложении одна панель браузера, но webview пересоздаётся при ремонтировании).
 */
export function readCapture(wcid?: number | null): CapturedRequest[] {
  const id = wcid ?? lastActiveWcid
  if (id == null) return []
  return (buffers.get(id) ?? []).slice()
}

/** Только для тестов: полный сброс модульного состояния. */
export function __resetCaptureForTests(): void {
  tracked.clear()
  buffers.clear()
  pendingStart.clear()
  lastActiveWcid = null
}
