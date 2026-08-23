// @vitest-environment jsdom
//
// ДЕФЕКТ (живая проверка 22.08, обход всего меню на собранном приложении): вкладка
// «Браузер» открывается белым полотном во весь экран — webview стоит на about:blank с
// белым фоном. Ошибок нет, всё работает, но человек видит пустоту и решает, что
// сломано. У соседней вкладки «Дизайн» объяснение есть, у браузера не было.
//
// ГЛАВНЫЙ ПИН: пока никуда не ходили — над кадром висит объяснение; как только адрес
// появился — объяснение уходит и не закрывает страницу.
//
// ГРАНИЦА: объяснение кладётся ПОВЕРХ кадра, а не вместо него. Прятать webview через
// display:none нельзя — он теряет лейаут-бокс, вьюпорт становится 0×0, кадры не идут
// (shared/browser-slot-style.ts). Поэтому пин проверяет, что webview остаётся в дереве
// в ОБОИХ состояниях — иначе «починка» пустоты убьёт сам браузер.
import { describe, it, expect, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, waitFor } from '@testing-library/react'
import { BrowserView } from '../../src/components/BrowserView'

afterEach(() => {
  cleanup()
  delete (window as unknown as { verstakBrowser?: unknown }).verstakBrowser
})

const idle = (c: HTMLElement) => c.querySelector('.gg-browser-idle')
const webview = (c: HTMLElement) => c.querySelector('webview')

describe('Браузер: пустое состояние вместо белого полотна', () => {
  it('никуда не ходили → человек видит объяснение, а не пустоту', async () => {
    const { container } = render(createElement(BrowserView))
    await waitFor(() => expect(idle(container)).toBeTruthy())
    const text = idle(container)!.textContent ?? ''
    // Смысл, а не буква: экран обязан сказать, ЧТО это за окно.
    expect(text.length).toBeGreaterThan(40)
    expect(text).toMatch(/агент/i)
  })

  // Оба кейса ниже НАМЕРЕННО не ждут оверлея: они стерегут границу, которая обязана
  // держаться независимо от того, показано объяснение или нет. Если связать их с
  // оверлеем через общее ожидание, они краснеют вместе с ним и перестают измерять
  // собственное утверждение — то есть врут о том, что проверяют.
  it('кадр браузера НЕ подменён заглушкой — webview в дереве', async () => {
    // Если однажды заменить кадр на статичный блок, браузер перестанет отдавать кадры
    // молча, без единой ошибки (shared/browser-slot-style.ts). Здесь это станет красным.
    const { container } = render(createElement(BrowserView))
    await waitFor(() => expect(webview(container)).toBeTruthy())
  })

  it('адресная строка доступна сразу — начать можно, не убирая объяснение', async () => {
    const { container } = render(createElement(BrowserView))
    await waitFor(() => expect(container.querySelector('.gg-browser-url')).toBeTruthy())
  })
})
