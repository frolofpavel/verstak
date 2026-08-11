/**
 * Б1 (пакет живой приёмки P1, 11.08): гард top-level навигации ГЛАВНОГО окна.
 *
 * ЖИВОЙ ФАКТ. 11.08 главное окно дважды уехало на passport.yandex.ru
 * (retpath = metrika.yandex.ru — восстановленный URL встроенного браузера):
 * renderer выгрузился МОЛЧА, стор потерян, второй раз — app.before_quit.
 * У главного окна не было ни will-navigate-гарда, ни setWindowOpenHandler —
 * любая страничная навигация (клик по <a href>, target=_top, drag&drop ссылки
 * в окно) уводила окно без единой проверки.
 *
 * ПРАВИЛО, А НЕ СПИСОК. Главное окно грузит ТОЛЬКО собственный index:
 * dev-сервер electron-vite (по origin) или file://…/renderer/index.html
 * (по пути, query/hash не в счёт). Всё остальное — блок + след с URL.
 * Разрешать «same-URL» нужно обязательно: reload и HMR идут теми же адресами,
 * глухой запрет сломал бы их и был бы выключен.
 *
 * ГРАНИЦА. Этот гард судит только webContents типа 'window'. Навигация ВНУТРИ
 * встроенного браузера (<webview>) — другой контур: SEC-CMD-07 (browser_navigate)
 * и SEC-CMD-08 (popup-policy), их пины отдельные. Гард их не трогает.
 */

export interface MainWindowNavOptions {
  /** ELECTRON_RENDERER_URL в dev; null в упакованной сборке. */
  devServerUrl: string | null
  /** file://-URL собственного renderer/index.html; null если неизвестен. */
  indexFileUrl: string | null
}

export interface MainWindowNavVerdict {
  allow: boolean
  /** Причина блока — человеку в лог, с самим URL. */
  reason?: string
}

/** Нормализованный путь file-URL: без query/hash, декодирован, без регистра
 *  (Windows-диски C:/ и c:/ — один путь). null — не file-URL или мусор. */
function fileUrlPath(raw: string): string | null {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'file:') return null
    return decodeURIComponent(u.pathname).toLowerCase()
  } catch {
    return null
  }
}

function sameOrigin(raw: string, base: string): boolean {
  try {
    return new URL(raw).origin === new URL(base).origin
  } catch {
    return false
  }
}

/** Пускать ли top-level навигацию главного окна. Разрешён только свой index. */
export function decideMainWindowNavigation(url: string, opts: MainWindowNavOptions): MainWindowNavVerdict {
  const raw = typeof url === 'string' ? url.trim() : ''
  if (opts.devServerUrl && sameOrigin(raw, opts.devServerUrl)) return { allow: true }
  if (opts.indexFileUrl) {
    const target = fileUrlPath(raw)
    const own = fileUrlPath(opts.indexFileUrl)
    if (target && own && target === own) return { allow: true }
  }
  return {
    allow: false,
    reason: `top-level навигация главного окна заблокирована (окно грузит только свой index): ${raw.slice(0, 500)}`,
  }
}

export interface MainWindowPopupVerdict {
  /** Открыть ли адрес в СИСТЕМНОМ браузере (child-окно не создаётся никогда). */
  openExternal: boolean
  reason: string
}

/**
 * Попап главного окна (window.open / target=_blank из нашего же UI — например,
 * «Где взять ключ» в Настройках). Child-окно не создаётся никогда: http(s)
 * уходит в системный браузер — видимо человеку, а не молча; остальные схемы
 * глушатся, у javascript:/file:/data: попапа легитимного применения нет.
 */
export function decideMainWindowPopup(url: string): MainWindowPopupVerdict {
  const raw = typeof url === 'string' ? url.trim() : ''
  if (/^https?:\/\//i.test(raw)) {
    return { openExternal: true, reason: 'http(s)-попап главного окна → системный браузер' }
  }
  return { openExternal: false, reason: `попап главного окна с не-http(s) схемой заблокирован: ${raw.slice(0, 200)}` }
}
