// @vitest-environment jsdom
//
// 2.0.8-A: CHARACTERIZATION настроек (перенесён из программы 2.0.7/2.0.8).
// ЗАЧЕМ: Settings.tsx — монолит 5279 строк, его вкладки будут выноситься по одной
// (Providers/Models уже living). Прежде чем резать — фиксируем ПОВЕДЕНИЕ оболочки, чтобы
// декомпозиция не сломала навигацию/поиск/состояние вкладок незаметно.
//
// ПРЕДЕЛ jsdom-сетки (память verstak-jsdom-chat-harness-limit): длинные async-цепочки
// виснут. Поэтому здесь — рендер + клики + waitFor по ОБОЛОЧКЕ (навигация, поиск, флаги
// вкладок), без прогонов тяжёлого контента вкладок (коннекторы с health-check, каталог).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react'
import { makeApiMock, CHAT_API_DEFAULTS, type ApiMock } from './helpers/window-api-mock'

const { Settings } = await import('../../src/components/Settings')

// Формы, которые читает контент вкладок при переключении (списки итерируются → нужен []).
const SETTINGS_DEFAULTS = {
  ...CHAT_API_DEFAULTS,
  subscriptionAccounts: { list: async () => [] },
  cliAuth: { statusAll: async () => ({}) },
  localModels: { scan: async () => [] },
  usage: { summary: async () => null, list: async () => [] },
  userProfiles: { list: async () => [] },
}

let mock: ApiMock
beforeEach(() => {
  mock = makeApiMock(SETTINGS_DEFAULTS)
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

type SettingsProps = Parameters<typeof Settings>[0]
const mountSettings = (props: { onClose?: () => void; initialTab?: SettingsProps['initialTab'] } = {}) =>
  render(createElement(Settings, { onClose: props.onClose ?? vi.fn(), initialTab: props.initialTab }))
const search = () => screen.getByPlaceholderText('Поиск настроек...') as HTMLInputElement
// Заголовок раздела (section-bar h2) уникально отражает активную вкладку.
const sectionTitle = () => document.querySelector('.gg-settings-section-bar h2')?.textContent

describe('Settings characterization — навигационная оболочка', () => {
  it('рендерит три смысловые группы навигации', async () => {
    mountSettings()
    await waitFor(() => expect(screen.getByText('Приложение')).toBeTruthy())
    expect(screen.getByText('AI')).toBeTruthy()
    expect(screen.getByText('Интеграции')).toBeTruthy()
  }, 10000)

  it('по умолчанию активна ровно одна вкладка (aria-selected + is-active совпадают)', async () => {
    mountSettings()
    await waitFor(() => expect(document.querySelector('.gg-settings-nav-item.is-active')).toBeTruthy())
    expect(document.querySelectorAll('.gg-settings-nav-item.is-active')).toHaveLength(1)
    expect(document.querySelectorAll('[role="tab"][aria-selected="true"]')).toHaveLength(1)
    // заголовок раздела (h2) присутствует — контент активной вкладки смонтирован
    expect(document.querySelector('.gg-settings-section-bar h2')).toBeTruthy()
  }, 10000)

  it('initialTab открывает нужную вкладку (Подписки активна, заголовок совпадает)', async () => {
    mountSettings({ initialTab: 'subscriptions' })
    await waitFor(() => expect(sectionTitle()).toBe('Подписки'))
    const activeTab = document.querySelector('[role="tab"][aria-selected="true"]')!
    expect(activeTab.textContent).toContain('Подписки')
  }, 10000)

  it('клик по вкладке переключает раздел (appearance → Подписки: заголовок и active едут)', async () => {
    mountSettings()
    await waitFor(() => expect(screen.getByText('Приложение')).toBeTruthy())
    expect(sectionTitle()).not.toBe('Подписки')               // до клика раздел другой
    fireEvent.click(screen.getByRole('tab', { name: /Подписки/ }))
    await waitFor(() => expect(sectionTitle()).toBe('Подписки'))
    expect(screen.getByRole('tab', { name: /Подписки/ }).getAttribute('aria-selected')).toBe('true')
  }, 10000)
})

describe('Settings characterization — поиск по настройкам', () => {
  it('фильтрует вкладки по ключевым словам, группы без совпадений скрываются', async () => {
    mountSettings()
    await waitFor(() => expect(screen.getByText('Приложение')).toBeTruthy())
    fireEvent.change(search(), { target: { value: 'подписки' } })
    await waitFor(() => expect(screen.getByText('Подписки')).toBeTruthy())
    expect(screen.getByText('AI')).toBeTruthy()               // группа с совпадением осталась
    expect(screen.queryByText('Приложение')).toBeNull()       // группа без совпадений скрыта
    expect(screen.queryByText('Интеграции')).toBeNull()
  }, 10000)

  it('поиск без совпадений → «Ничего не найдено» + кнопка очистки', async () => {
    mountSettings()
    await waitFor(() => expect(screen.getByText('Приложение')).toBeTruthy())
    fireEvent.change(search(), { target: { value: 'zzюяжэъ' } })
    await waitFor(() => expect(screen.getByText('Ничего не найдено')).toBeTruthy())
    // очистка возвращает все группы
    fireEvent.click(screen.getByLabelText('Очистить поиск'))
    await waitFor(() => expect(screen.getByText('Приложение')).toBeTruthy())
  }, 10000)
})

describe('Settings characterization — вкладка «Профили» (2.0.8-G: живая)', () => {
  it('включена (нет «Скоро», не disabled) и по клику открывает живой ProfilesTab', async () => {
    mountSettings()
    await waitFor(() => expect(screen.getByText('Приложение')).toBeTruthy())
    expect(screen.queryByText('Скоро')).toBeNull()                    // бейдж снят честно
    // ярлык вкладки локализуется (в тест-харнесе локаль EN → «Profiles»), поэтому ищем
    // терпимо к языку; доказательство переключения — hardcoded-контент ProfilesTab.
    const profTab = screen.getByRole('tab', { name: /Профили|Profiles/i }) as HTMLButtonElement
    expect(profTab.disabled).toBe(false)
    fireEvent.click(profTab)
    // смонтирован ЖИВОЙ ProfilesTab (его h2, независимый от локали), а не «Скоро»-заглушка
    await waitFor(() => expect(screen.getByText('Профиль и организация')).toBeTruthy())
  }, 10000)
})
