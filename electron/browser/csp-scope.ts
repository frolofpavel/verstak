/**
 * КОМУ адресован собственный CSP приложения — и кому он адресован НЕ БЫЛ НИКОГДА.
 *
 * ДЕФЕКТ (P3 кусок 2, найден 12.08 живым прогоном собранного приложения). `installCSP`
 * вешает `onHeadersReceived` на `session.defaultSession` и штампует строгий
 * `script-src 'self'` на КАЖДЫЙ ответ типа mainFrame/subFrame/stylesheet/script.
 * Встроенный браузер живёт в ТОЙ ЖЕ сессии (`partition` не задан нигде — это прямо
 * зафиксировано в шапке `installCSP` правкой 30.07), поэтому политика, написанная для
 * СВОЕГО окна на `file://`, доставалась и чужим сайтам во вкладке браузера.
 *
 * ЧТО ЭТО ДАВАЛО. Для стороннего сайта `'self'` — это его собственный домен, а скрипты
 * и стили он почти всегда отдаёт с отдельного (habr.com → assets.habr.com). Замер на
 * живом приложении: 89 записей «violates the following Content Security Policy
 * directive», `window.__NUXT__` отсутствует — фреймворк страницы НЕ СТАРТОВАЛ вообще.
 * Дальше всё следствия: SPA не рисует выдачу; Enter в форме уходит нативной
 * GET-навигацией (обработчика-то нет), адрес меняется — и человек видит «поиск
 * выполнился, а результатов нет». Ровно наблюдение Павла 10.08.
 *
 * ПОЧЕМУ НЕ ЗАМЕТИЛИ РАНЬШЕ — два слепых пятна разом:
 *  1. `installCSP` РАНО ВЫХОДИТ в dev (`ELECTRON_RENDERER_URL` задан), поэтому под
 *     `npm run dev` встроенный браузер исправен, а ломается только в собранном
 *     приложении — том самом, которым пользуется человек.
 *  2. Нарушения CSP печатает БРАУЗЕР, а не страница, и событие `console-message`
 *     у <webview> их не несёт. Поэтому `browser_console_messages` честно отдавал
 *     пустоту: «ошибок в консоли нет» было правдой и одновременно не значило ничего.
 *
 * ГРАНИЦА ПОЧИНКИ. Снимается ровно ОДИН заголовок и ровно у вкладок браузера.
 * Ничего из того, чем webview реально удержан, не трогается: `nodeIntegration:false`,
 * `contextIsolation:true`, снятый preload и `webSecurity:true` на `will-attach-webview`,
 * запрет попапов, правила навигации и гейты SEC-CMD в `browserHandler` — на месте.
 * Собственное окно приложения продолжает получать CSP байт-в-байт как раньше:
 * решение сужено, а не ослаблено.
 */

/** Типы ответов, на которые приложение штампует свой CSP. */
export const CSP_RESOURCE_TYPES = ['mainFrame', 'subFrame', 'stylesheet', 'script'] as const

/**
 * Штамповать ли собственный CSP на этот ответ.
 *
 * `isBrowserTab` — предикат «этот webContents есть вкладка встроенного браузера»
 * (в проде — `isTrackedWebview` из network-capture: там webview регистрируется на
 * `web-contents-created`, то есть ДО первой навигации гостя).
 *
 * Неизвестный `webContentsId` считается НЕ вкладкой браузера: политика приложения
 * остаётся включённой по умолчанию, и ошибка идёт в сторону строгости.
 */
export function shouldStampAppCsp(
  resourceType: string,
  webContentsId: number | undefined,
  isBrowserTab: (id: number) => boolean,
): boolean {
  if (!(CSP_RESOURCE_TYPES as readonly string[]).includes(resourceType)) return false
  if (webContentsId != null && isBrowserTab(webContentsId)) return false
  return true
}
