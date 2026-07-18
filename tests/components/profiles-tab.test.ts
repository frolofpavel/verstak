// @vitest-environment jsdom
//
// 2.0.8-G: живая вкладка «Профили» поверх userProfiles API (была «Скоро»-заглушка).
// Проверяем ПРОВОДКУ: читает профили, метит активный, «Сделать активным» → setActive → перезагрузка.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react'
import { makeApiMock, type ApiMock } from './helpers/window-api-mock'

const { ProfilesTab } = await import('../../src/components/ProfilesTab')

const BASE = [
  { id: 1, name: 'Павел', role: 'developer', defaultProvider: 'gemini-api', defaultModel: 'gemini-2.5-flash', skillsEnabled: null, createdAt: 0 },
  { id: 2, name: 'Дизайнер', role: 'designer', defaultProvider: 'gemini-api', defaultModel: 'gemini-2.5-flash', skillsEnabled: null, createdAt: 0 },
]

let mock: ApiMock
let setActiveCalls: number[]
let activeId: number

function mountWith(list: () => Promise<unknown[]>, setActive?: (id: number) => Promise<void>) {
  mock = makeApiMock({ userProfiles: { list, setActive: setActive ?? (async () => {}) } })
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
  return render(createElement(ProfilesTab))
}

beforeEach(() => {
  setActiveCalls = []
  activeId = 1
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('ProfilesTab (2.0.8-G) — живая вкладка профилей', () => {
  it('показывает профили с ролью, активный помечен бейджем, неактивный — кнопкой', async () => {
    mountWith(async () => BASE.map(p => ({ ...p, isActive: p.id === activeId })))
    await waitFor(() => expect(screen.getByText('Павел')).toBeTruthy())
    expect(screen.getByText('Дизайнер')).toBeTruthy()
    expect(screen.getByText('developer')).toBeTruthy()                       // роль показана
    expect(screen.getByText('Активен')).toBeTruthy()                         // активный (Павел)
    expect(screen.getByRole('button', { name: 'Сделать активным' })).toBeTruthy()  // неактивный (Дизайнер)
  }, 10000)

  it('«Сделать активным» вызывает setActive(id) и переносит бейдж после перезагрузки', async () => {
    mountWith(
      async () => BASE.map(p => ({ ...p, isActive: p.id === activeId })),
      async (id: number) => { setActiveCalls.push(id); activeId = id },
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Сделать активным' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Сделать активным' }))  // единственная кнопка = у Дизайнера
    await waitFor(() => expect(setActiveCalls).toEqual([2]))
    // после reload активен Дизайнер: его строка несёт «Активен», у Павла — кнопка
    await waitFor(() => {
      const diz = screen.getByText('Дизайнер').closest('.gg-profile-row')!
      expect(diz.textContent).toContain('Активен')
    })
    const pavel = screen.getByText('Павел').closest('.gg-profile-row')!
    expect(pavel.querySelector('button')).toBeTruthy()
  }, 10000)

  it('пустой список профилей → честный пустой стейт', async () => {
    mountWith(async () => [])
    await waitFor(() => expect(screen.getByText(/Пока нет профилей/)).toBeTruthy())
  }, 10000)
})
