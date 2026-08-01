# Browser recon — фактическое устройство (VSK-BROWSER-B1, этап 0)

Дата: 2026-08-01. Разведка без правок. Факты с привязкой к коду.

> **ГЛАВНОЕ (ответ на «там обычный хром»):** агентной инструментовки нет вовсе.
> Модель видит страницу как **плоский `document.body.innerText`** (не дерево, не
> номера элементов) и кликает по **угаданному CSS-селектору или тексту**. Плюс
> браузер работает ТОЛЬКО пока открыта вкладка Browser (нигде не задокументировано).
> Оттого он и «обычный»: это Chromium без структурного видения, нумерации,
> ожиданий и чтения консоли/сети.

## На чём построено
- Электроновский тег **`<webview>`** (`webviewTag: true`, `electron/main.ts:164`).
  Контент webview крутится в отдельном renderer-процессе.
- **`partition` НЕ задан НИГДЕ** → webview живёт в `session.defaultSession` —
  той же персистентной сессии (`electron/main.ts:213-219`, это исправленная
  ложная запись «webview в своей сессии»). Отсюда «обычный хром»: это обычный
  Chromium с общими cookies/хранилищем, без агентной инструментовки.
- Периметр безопасности на webview ЕСТЬ: `will-attach-webview` форсит безопасные
  webPreferences (`contextIsolation:true`, снят preload), `setWindowOpenHandler`
  (SEC-CMD-08, `main.ts:354`), `setPermissionRequestHandler` на defaultSession.

## Какие инструменты есть (ровно 4)
`browser_navigate`, `browser_read_page`, `browser_screenshot`, `browser_click`
(`electron/ai/tools.ts:351-450`). CDP не используется вообще.

## Что ИМЕННО видит модель
- `browser_read_page` → `{ url, title, text }`, где
  `text = document.body.innerText.slice(0, 50000)` (или
  `querySelector(selector).innerText`) — `src/components/BrowserView.tsx:109-116`.
  То есть **ПЛОСКИЙ ТЕКСТ**: ни дерева, ни пронумерованных элементов, ни HTML, ни
  accessibility-снимка. Структурного видения страницы НЕТ.
- `browser_click(selector)` — сперва `document.querySelector(selector)`, иначе
  фолбэк: поиск `a/button/[role=button]/input[submit]` по видимому тексту
  (`BrowserView.tsx:120-140`). Клик по **CSS-селектору или тексту**, НЕ по номеру
  элемента. Модель угадывает селектор/текст.
- `browser_screenshot` → `capturePage().toDataURL()`, кладётся вложением к
  следующему сообщению (`browser.ts:109-125`).
- Ожидания появления элемента, чтения консоли/сети — НЕТ.

## Почему без открытой вкладки ничего не работает
`window.verstakBrowser` (API navigate/readPage/click/screenshot) ставится в
`useEffect` при МОНТИРОВАНИИ компонента `BrowserView` и удаляется при размонтaже
(`BrowserView.tsx:95-159`, `return () => { delete window.verstakBrowser }`).
Инструменты исполняются через `ctx.sender.exec(snippet)` в главном renderer'е, и
snippet читает `window.verstakBrowser`; если вкладка не открыта — API нет, и
хендлер возвращает «Вкладка Browser не открыта» (`browser.ts:26-34`). То есть
открытая вкладка — УСЛОВИЕ, а не окно наблюдения. Нигде не задокументировано.

## Где стоят гейты SEC-CMD (важно для этапа 1)
Все — в `browserHandler.handle` (`electron/ipc/tool-handlers/browser.ts:42-131`):
`resolveDecision` → `block` для `plan` (SEC-CMD-06, :60), `confirm` реально
останавливает (SEC-CMD-07, :78), плюс `setWindowOpenHandler` (SEC-CMD-08). Любой
новый путь исполнения браузера ОБЯЗАН идти через `browserHandler`, иначе гейты
окажутся на мёртвом пути.

## Что технически значит «обычный хром»
Webview = чистый Chromium с общей defaultSession, без CDP, без структурного
снимка, без нумерации элементов, без ожиданий, без чтения консоли/сети. Для
агента это «просто браузер»: он читает innerText и кликает по тексту/селектору.
Планка «как в Claude Code» (структурный снимок + номер элемента + ожидание +
консоль/сеть + работа без вкладки) сегодня не выполнена ни по одному пункту.

## Вывод к этапу 1 (направление, не правка)
CDP уже внутри Electron (`webContents.debugger` у webview) — структурный снимок с
нумерацией, клик по номеру, ожидания, консоль/сеть строятся на нём, новых движков
не нужно. Фоновый режим (BrowserView без вкладки) требует держать webContents
живым вне монтирования компонента — и провести исполнение через тот же
`browserHandler`, чтобы гейты SEC-CMD остались на пути (условие приёмки).
