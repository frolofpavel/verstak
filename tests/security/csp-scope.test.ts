/**
 * ДЕФЕКТ P3 кусок 2 (найден 12.08 живым прогоном СОБРАННОГО приложения): собственный
 * CSP приложения штамповался на страницы встроенного браузера, потому что webview
 * живёт в той же `session.defaultSession`. Для чужого сайта `script-src 'self'`
 * отрезает его же CDN — замер на habr.com в живом окне: 89 нарушений CSP в консоли
 * браузера и `window.__NUXT__ === undefined`, то есть фреймворк страницы не стартовал.
 * Отсюда «поиск выполнился, а выдачи нет»: без JS форма уходит нативным GET.
 *
 * КОНТРОЛЬНАЯ ПАРА обязательна (§3.1): рядом с «на вкладку браузера НЕ штампуем»
 * стоит «на своё окно ШТАМПУЕМ» — иначе пин зелен и у функции, которая не штампует
 * никогда, то есть молча выключает политику приложения целиком.
 */
import { describe, it, expect } from 'vitest'
import { shouldStampAppCsp, CSP_RESOURCE_TYPES } from '../../electron/browser/csp-scope'
import { trackWebview, untrackWebview, isTrackedWebview } from '../../electron/browser/network-capture'

const MAIN_WINDOW = 1
const BROWSER_TAB = 42
const isBrowserTab = (id: number) => id === BROWSER_TAB

describe('CSP приложения адресован своему окну, а не страницам встроенного браузера', () => {
  it('вкладка браузера: политику НЕ штампуем — иначе чужой сайт теряет свои скрипты', () => {
    for (const rt of CSP_RESOURCE_TYPES) {
      expect(shouldStampAppCsp(rt, BROWSER_TAB, isBrowserTab)).toBe(false)
    }
  })

  it('КОНТРОЛЬ: своё окно — политику штампуем ровно как раньше', () => {
    for (const rt of CSP_RESOURCE_TYPES) {
      expect(shouldStampAppCsp(rt, MAIN_WINDOW, isBrowserTab)).toBe(true)
    }
  })

  it('типы ответов вне списка не трогаем (поведение прежнее)', () => {
    for (const rt of ['image', 'xhr', 'fetch', 'media', 'other']) {
      expect(shouldStampAppCsp(rt, MAIN_WINDOW, isBrowserTab)).toBe(false)
      expect(shouldStampAppCsp(rt, BROWSER_TAB, isBrowserTab)).toBe(false)
    }
  })

  it('неизвестный webContentsId → штампуем: ошибка идёт в сторону строгости', () => {
    expect(shouldStampAppCsp('mainFrame', undefined, isBrowserTab)).toBe(true)
  })

  it('предикат берётся из реестра webview: пока вкладка не снята с учёта — она вкладка', () => {
    // Реестр тот же, что у захвата сети: webview регистрируется на
    // web-contents-created, то есть ДО первой навигации гостя.
    expect(isTrackedWebview(BROWSER_TAB)).toBe(false)
    expect(shouldStampAppCsp('script', BROWSER_TAB, isTrackedWebview)).toBe(true)

    trackWebview(BROWSER_TAB)
    expect(shouldStampAppCsp('script', BROWSER_TAB, isTrackedWebview)).toBe(false)

    untrackWebview(BROWSER_TAB)
    expect(shouldStampAppCsp('script', BROWSER_TAB, isTrackedWebview)).toBe(true)
  })
})
