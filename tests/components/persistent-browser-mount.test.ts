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

  // ДЕФЕКТ P3 кусок 2 (Павел, 10.08 и замер 12.08): вне своей вкладки слот прятался
  // через display:none. Для человека это «браузер скрыт», а для СТРАНИЦЫ — окно
  // нулевого размера: замер на живом Electron дал вьюпорт 0×0, rAF 0/с и молчащий
  // IntersectionObserver, то есть SPA-выдача не отрисовывалась вовсе, а инструменты
  // честно показывали пустоту. Числа и контрольные случаи — `npm run smoke:browser-spa`.
  //
  // ЧТО ИЗМЕНИЛОСЬ В ЭТОМ ПИНЕ (объявляется прямо, §3.1): прежнее утверждение
  // `display === 'none'` стерегло МЕХАНИЗМ, который замером признан дефектным.
  // Пользовательский контракт не отменён и проверяется здесь по-прежнему — человек
  // не видит браузер вне его вкладки и не может по нему попасть мышью; добавлено
  // требование, которого не хватало: слот обязан сохранять лейаут-бокс.
  it('вне своей вкладки: невидим человеку и не ловит мышь, но НЕ display:none — иначе у страницы нулевой вьюпорт', async () => {
    render(createElement(PersistentBrowser, { active: false }))
    const slot = () => document.querySelector('.gg-browser-slot') as HTMLElement | null
    await waitFor(() => expect(slot()).toBeTruthy())
    const st = slot()!.style
    expect(st.display).not.toBe('none')     // ГЛАВНОЕ: лейаут-бокс сохранён, вьюпорт настоящий
    expect(st.opacity).toBe('0')            // человек не видит браузер вне его вкладки
    expect(st.pointerEvents).toBe('none')   // и не может попасть по нему мышью
    expect(st.position).toBe('fixed')       // вне потока — лейаут активной вкладки не трогает
    expect(st.zIndex).toBe('-1')            // под интерфейсом, а не поверх него
  })

  it('на своей вкладке раскрыт как раньше (display:contents) — тот же webview, не второй браузер', async () => {
    const { rerender } = render(createElement(PersistentBrowser, { active: false }))
    const slot = () => document.querySelector('.gg-browser-slot') as HTMLElement | null
    await waitFor(() => expect(slot()).toBeTruthy())
    rerender(createElement(PersistentBrowser, { active: true }))
    expect(slot()!.style.display).toBe('contents')
    expect(slot()!.style.opacity).toBe('')   // видим полностью, без остаточной прозрачности
  })

  it('размонтирование снимает API (чистый контракт жизненного цикла)', async () => {
    const { unmount } = render(createElement(PersistentBrowser, { active: false }))
    await waitFor(() => expect(api()).toBeTruthy())
    unmount()
    expect(api()).toBeUndefined()
  })
})
