// @vitest-environment jsdom
//
// Панель реестра возможностей. Живая приёмка на собранном приложении доказала
// главную половину — сборку паспорта в главном процессе и мост наружу (316
// возможностей, все поля непустые, ошибок нет). До ОТРИСОВКИ живьём дойти не
// удалось: экран «Скиллы» требует открытого проекта, а автоматизация выбора
// папки упирается в системный диалог. Поэтому вторая половина закрывается здесь.
//
// ГЛАВНЫЙ ПИН: паспорт доезжает до человека целиком — тип, владелец, риск,
// доверие и версия, а не только имя. Реестр, показывающий одно имя, ничем не
// лучше четырёх прежних списков, ради ухода от которых он и заведён.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { CapabilityRegistryPanel } from '../../src/components/CapabilityRegistryPanel'
import type { Capability } from '../../shared/contracts/capability'

const cap = (over: Partial<Capability> = {}): Capability => ({
  id: 'skill:github',
  type: 'skill',
  nativeId: 'github',
  name: 'Разбор репозитория',
  description: 'Читает репозиторий',
  owner: 'user',
  version: '0f2029823d0b',
  source: 'C:/skills/github.md',
  enabled: true,
  status: 'ready',
  allowedTools: ['read_file'],
  allowedPaths: null,
  allowedDomains: null,
  dependencies: [],
  riskTier: 'low',
  trustLevel: 'T1',
  evalScore: null,
  lastVerifiedAt: null,
  ...over,
})

function mockApi(list: Capability[], reason: string | null = null, fail = false) {
  ;(window as unknown as { api: unknown }).api = {
    capabilities: {
      list: fail ? vi.fn().mockRejectedValue(new Error('нет связи')) : vi.fn().mockResolvedValue(list),
      get: vi.fn().mockResolvedValue(null),
      reason: vi.fn().mockResolvedValue(reason),
    },
  }
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('паспорт доезжает до человека целиком', () => {
  it('в строке видны тип, владелец, риск, доверие и состояние', async () => {
    mockApi([cap({ owner: 'встроенный', riskTier: 'high', trustLevel: 'T3' })])
    const { container } = render(createElement(CapabilityRegistryPanel))
    await waitFor(() => expect(container.querySelector('.gg-cap-row')).toBeTruthy())
    const text = container.querySelector('.gg-cap-row')!.textContent ?? ''
    expect(text).toContain('Скилл')
    expect(text).toContain('Разбор репозитория')
    expect(text).toContain('встроенный')
    expect(text).toMatch(/риск высокий/)
    // Уровень читается смыслом, а не кодом: «T3» без расшифровки человеку ничего
    // не говорит о том, что именно разрешено.
    expect(text).toMatch(/T3.*политик/)
    expect(text).toContain('готов')
  })

  it('раскрытая карточка показывает происхождение и версию', async () => {
    mockApi([cap()], 'три зелёные проверки')
    const { container } = render(createElement(CapabilityRegistryPanel))
    await waitFor(() => expect(container.querySelector('.gg-cap-row-main')).toBeTruthy())
    fireEvent.click(container.querySelector('.gg-cap-row-main')!)
    await waitFor(() => expect(container.querySelector('.gg-cap-details')).toBeTruthy())
    const d = container.querySelector('.gg-cap-details')!.textContent ?? ''
    expect(d).toContain('C:/skills/github.md')
    expect(d).toContain('0f2029823d0b')
    expect(d).toContain('read_file')
  })

  it('непроверенная возможность так и говорит, а не показывает ноль', async () => {
    mockApi([cap()])
    const { container } = render(createElement(CapabilityRegistryPanel))
    await waitFor(() => expect(container.querySelector('.gg-cap-row-main')).toBeTruthy())
    fireEvent.click(container.querySelector('.gg-cap-row-main')!)
    await waitFor(() => expect(container.querySelector('.gg-cap-details')).toBeTruthy())
    const d = container.querySelector('.gg-cap-details')!.textContent ?? ''
    expect(d).toContain('не проверялась')
    expect(d).not.toMatch(/оценка 0[.,]00/)
  })

  // Отсутствие ограничения и отсутствие прав — разные вещи. Пустой список здесь
  // прочитали бы как защиту, которой нет.
  it('неограниченные инструменты названы словами, а не пустотой', async () => {
    mockApi([cap({ allowedTools: null })])
    const { container } = render(createElement(CapabilityRegistryPanel))
    await waitFor(() => expect(container.querySelector('.gg-cap-row-main')).toBeTruthy())
    fireEvent.click(container.querySelector('.gg-cap-row-main')!)
    await waitFor(() => expect(container.querySelector('.gg-cap-details')).toBeTruthy())
    expect(container.querySelector('.gg-cap-details')!.textContent).toContain('не ограничены')
  })
})

describe('фильтр по типам', () => {
  const mixed = [
    cap(),
    cap({ id: 'mcp:moex', type: 'mcp', nativeId: 'moex', name: 'MOEX' }),
    cap({ id: 'connector:github', type: 'connector', nativeId: 'github', name: 'GitHub' }),
  ]

  it('по умолчанию видны все', async () => {
    mockApi(mixed)
    const { container } = render(createElement(CapabilityRegistryPanel))
    await waitFor(() => expect(container.querySelectorAll('.gg-cap-row').length).toBe(3))
  })

  it('выбор типа сужает список', async () => {
    mockApi(mixed)
    const { container, getByText } = render(createElement(CapabilityRegistryPanel))
    await waitFor(() => expect(container.querySelectorAll('.gg-cap-row').length).toBe(3))
    fireEvent.click(getByText('MCP 1'))
    await waitFor(() => expect(container.querySelectorAll('.gg-cap-row').length).toBe(1))
    expect(container.querySelector('.gg-cap-row')!.textContent).toContain('MOEX')
  })

  // Контроль: без него пин выше зелен и у фильтра, который всегда показывает одну
  // строку или не показывает ничего.
  it('контроль: возврат к «Все» возвращает все строки', async () => {
    mockApi(mixed)
    const { container, getByText } = render(createElement(CapabilityRegistryPanel))
    await waitFor(() => expect(container.querySelectorAll('.gg-cap-row').length).toBe(3))
    fireEvent.click(getByText('MCP 1'))
    await waitFor(() => expect(container.querySelectorAll('.gg-cap-row').length).toBe(1))
    fireEvent.click(getByText('Все 3'))
    await waitFor(() => expect(container.querySelectorAll('.gg-cap-row').length).toBe(3))
  })
})

describe('пустой реестр и несобравшийся — разные экраны', () => {
  it('пусто — так и сказано', async () => {
    mockApi([])
    const { container } = render(createElement(CapabilityRegistryPanel))
    await waitFor(() => expect(container.textContent).toContain('не подключено'))
  })

  // Путать «ничего не подключено» с «не смогли собрать» нельзя: первое человек
  // прочитает как норму и не пойдёт разбираться.
  it('сбор не удался — сказано про сбой, а не про пустоту', async () => {
    mockApi([], null, true)
    const { container } = render(createElement(CapabilityRegistryPanel))
    await waitFor(() => expect(container.textContent).toMatch(/не собрался/))
    expect(container.textContent).not.toContain('не подключено')
  })
})
