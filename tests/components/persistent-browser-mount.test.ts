// @vitest-environment jsdom
//
// ДЕФЕКТ (Павел, живая задача «открой сайт альфы»): browser_navigate вернул
// «вкладка Browser не открыта», агент зациклился и попросил ЧЕЛОВЕКА открыть вкладку.
// Причина: window.verstakBrowser ставится при монтировании BrowserView, а App
// монтировал его ТОЛЬКО на своей вкладке ({activeView === 'browser' && ...}). Пока
// вкладку ни разу не открыли — API нет, инструменты мертвы. Требование №5 ТЗ: вкладка
// — окно наблюдения для человека, НЕ условие работы инструментов; №2: один браузер.
//
// ГЛАВНЫЙ ПИН: инструменты браузера доступны, когда вкладка НИ РАЗУ не открывалась.
// Мутация (проверено вручную): вернуть PersistentBrowser к {active && <BrowserView/>}
// — пин «API есть при active=false» краснеет. Значит пин не декоративный.
import { describe, it, expect, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, waitFor } from '@testing-library/react'
import { PersistentBrowser } from '../../src/components/PersistentBrowser'

afterEach(() => {
  cleanup()
  delete (window as unknown as { verstakBrowser?: unknown }).verstakBrowser
})

const api = () => (window as unknown as { verstakBrowser?: { navigate?: unknown; snapshot?: unknown } }).verstakBrowser

describe('PersistentBrowser — браузер смонтирован без открытой вкладки', () => {
  it('вкладка НЕ выбрана (active=false) → window.verstakBrowser ВСЁ РАВНО есть и умеет navigate/snapshot', async () => {
    render(createElement(PersistentBrowser, { active: false }))
    // Тот самый случай «первый запуск, вкладку не открывали»: API обязан присутствовать.
    await waitFor(() => expect(api()).toBeTruthy())
    expect(typeof api()!.navigate).toBe('function')
    expect(typeof api()!.snapshot).toBe('function')
  })

  it('скрыт, когда вкладка не выбрана (display:none), и раскрыт на своей вкладке (display:contents)', async () => {
    const { rerender } = render(createElement(PersistentBrowser, { active: false }))
    const slot = () => document.querySelector('.gg-browser-slot') as HTMLElement | null
    await waitFor(() => expect(slot()).toBeTruthy())
    expect(slot()!.style.display).toBe('none')          // человек не видит браузер вне его вкладки
    rerender(createElement(PersistentBrowser, { active: true }))
    expect(slot()!.style.display).toBe('contents')      // открыл вкладку — виден, тот же webview
  })

  it('размонтирование снимает API (чистый контракт жизненного цикла)', async () => {
    const { unmount } = render(createElement(PersistentBrowser, { active: false }))
    await waitFor(() => expect(api()).toBeTruthy())
    unmount()
    expect(api()).toBeUndefined()
  })
})
