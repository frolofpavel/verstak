// Б1 (пакет живой приёмки P1, 11.08) · главное окно НЕ уводится top-level
// навигацией из встроенного контента.
//
// ЖИВОЙ ФАКТ, КОТОРЫЙ ЭТО ЗАКРЫВАЕТ. Дважды за прогон главное окно уехало на
// passport.yandex.ru (retpath = metrika.yandex.ru — восстановленный URL
// встроенного браузера): renderer выгружается МОЛЧА, весь стор теряется, второй
// раз это кончилось app.before_quit. Механизм класса: у главного окна не было
// НИ will-navigate-гарда, НИ setWindowOpenHandler — любая страничная навигация
// (клик по <a href>, window.open + target=_top, drag&drop ссылки в окно)
// проходила без единой проверки.
//
// КЛАСС ЗАКРЫВАЕТСЯ ПРАВИЛОМ, А НЕ СПИСКОМ: главное окно грузит ТОЛЬКО
// собственный index (dev-сервер electron-vite ИЛИ file://.../renderer/index.html).
// Всё остальное блокируется и логируется с URL. Попап главного окна никогда не
// создаёт child-окно: http(s) уходит в СИСТЕМНЫЙ браузер (видимо человеку, а не
// молча), остальные схемы глушатся.
//
// КОНТРОЛЬ, без которого «починкой» был бы глухой запрет всего: переходы ВНУТРИ
// встроенного браузера (webview) этим гардом не судятся вовсе — у webview свой
// контур (SEC-CMD-07/08), и его пины живут в popup-navigation.test.ts.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { decideMainWindowNavigation, decideMainWindowPopup } from '../../electron/main-window-navigation'

const ROOT = join(__dirname, '..', '..')

const PROD_INDEX = 'file:///C:/Users/x/AppData/Local/Programs/Verstak/resources/app.asar/out/renderer/index.html'
const DEV_URL = 'http://localhost:5173/'

describe('Б1 · decideMainWindowNavigation: только собственный index', () => {
  // ОБЯЗАТЕЛЬНЫЙ: живой URL увода из приёмки 11.08 блокируется, URL попадает в reason.
  it('passport.yandex.ru (живой факт приёмки) блокируется, и URL виден в причине', () => {
    const url = 'https://passport.yandex.ru/auth?retpath=https%3A%2F%2Fmetrika.yandex.ru%2F'
    const v = decideMainWindowNavigation(url, { devServerUrl: null, indexFileUrl: PROD_INDEX })
    expect(v.allow, 'главное окно снова уводится top-level навигацией наружу').toBe(false)
    expect(String(v.reason)).toContain('passport.yandex.ru')
  })

  it('любой http(s)-адрес наружу блокируется и в dev, и в prod', () => {
    for (const opts of [
      { devServerUrl: DEV_URL, indexFileUrl: null },
      { devServerUrl: null, indexFileUrl: PROD_INDEX },
    ]) {
      const v = decideMainWindowNavigation('https://example.com/anything', opts)
      expect(v.allow, `наружная навигация прошла при ${JSON.stringify(opts)}`).toBe(false)
    }
  })

  it('не-http(s) схемы (javascript:, data:, file: чужого пути) блокируются', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<h1>x', 'file:///C:/Windows/win.ini']) {
      const v = decideMainWindowNavigation(url, { devServerUrl: DEV_URL, indexFileUrl: PROD_INDEX })
      expect(v.allow, `${url} прошёл в главное окно`).toBe(false)
    }
  })

  // КОНТРОЛЬ «происходит»: собственный index обязан проходить — иначе гард ломает
  // reload/HMR и превращается в глухой запрет, который выключат.
  it('контроль: prod-index (file://…/renderer/index.html) проходит, с query и hash тоже', () => {
    expect(decideMainWindowNavigation(PROD_INDEX, { devServerUrl: null, indexFileUrl: PROD_INDEX }).allow).toBe(true)
    expect(decideMainWindowNavigation(`${PROD_INDEX}#/settings`, { devServerUrl: null, indexFileUrl: PROD_INDEX }).allow).toBe(true)
    expect(decideMainWindowNavigation(`${PROD_INDEX}?x=1`, { devServerUrl: null, indexFileUrl: PROD_INDEX }).allow).toBe(true)
  })

  it('контроль: dev-сервер electron-vite проходит целиком по origin (reload/HMR)', () => {
    for (const url of [DEV_URL, 'http://localhost:5173/index.html', 'http://localhost:5173/?hmr=1']) {
      expect(decideMainWindowNavigation(url, { devServerUrl: DEV_URL, indexFileUrl: null }).allow, `${url} не прошёл`).toBe(true)
    }
    // Чужой порт на том же хосте — НЕ наш origin.
    expect(decideMainWindowNavigation('http://localhost:9999/', { devServerUrl: DEV_URL, indexFileUrl: null }).allow).toBe(false)
  })

  it('регистр буквы диска Windows не делает свой index чужим', () => {
    const lower = PROD_INDEX.replace('file:///C:/', 'file:///c:/')
    expect(decideMainWindowNavigation(lower, { devServerUrl: null, indexFileUrl: PROD_INDEX }).allow).toBe(true)
  })
})

describe('Б1 · decideMainWindowPopup: попап главного окна не создаёт окно', () => {
  it('http(s)-попап уходит в системный браузер (видимо, не молча)', () => {
    const v = decideMainWindowPopup('https://platform.moonshot.ai/console/api-keys')
    expect(v.openExternal, 'внешняя ссылка из UI (target=_blank «Где взять ключ») потеряла путь наружу').toBe(true)
  })

  it('не-http(s) попап глушится с причиной', () => {
    for (const url of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,x']) {
      const v = decideMainWindowPopup(url)
      expect(v.openExternal, `${url} ушёл в системный браузер`).toBe(false)
      expect(String(v.reason).length > 0).toBe(true)
    }
  })
})

// Пин на ИСТОЧНИК, а не только на функцию (приём проекта: popup-navigation,
// provider-model-drift). В main.ts тесты не заходят (Electron), поэтому текстом:
// правильная функция, которую никто не зовёт, — ложная закрытость.
describe('Б1 · main.ts реально ставит гард на главное окно', () => {
  const main = readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf8')

  it('есть ветка для contents.getType() === \'window\'', () => {
    expect(main, 'гарда главного окна в web-contents-created нет').toMatch(
      /getType\(\)\s*===\s*'window'/
    )
  })

  it('will-navigate главного окна судится decideMainWindowNavigation и блокируется preventDefault', () => {
    expect(main).toContain('decideMainWindowNavigation')
    const idx = main.indexOf('decideMainWindowNavigation(')
    const around = main.slice(Math.max(0, idx - 600), idx + 600)
    expect(around, 'вердикт есть, а навигация не предотвращается').toContain('preventDefault')
  })

  it('попап главного окна проходит decideMainWindowPopup и всегда deny', () => {
    expect(main).toContain('decideMainWindowPopup')
    const idx = main.indexOf('decideMainWindowPopup(')
    const around = main.slice(idx, idx + 800)
    expect(around, 'обработчик попапа главного окна не возвращает deny').toContain("action: 'deny'")
  })

  it('заблокированная попытка увода оставляет след с URL (logRuntime)', () => {
    const idx = main.indexOf('decideMainWindowNavigation(')
    const around = main.slice(Math.max(0, idx - 600), idx + 900)
    expect(around, 'блокировка молчит — след с URL обязателен').toMatch(/logRuntime\([^)]*url/)
  })
})
