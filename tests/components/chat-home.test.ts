// @vitest-environment jsdom
//
// Characterization для домашнего экрана чата (ChatHome) — срез 1.2 FIX-PLAN-2026-07-24.
// Лочим текущее поведение ДО любых дальнейших правок: секции «Недавние»/«Предложенные»,
// выбор агента (recent в localStorage + onSelect), aside (пустой → карточка → prompt в композер),
// устойчивость к битому localStorage.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'
import { ChatHome, ChatHomeAside, HOME_AGENTS } from '../../src/components/ChatHome'

const RECENT_KEY = 'gg.home.recentAgents'

function mountHome(selectedId: string | null = null, onSelect = vi.fn()) {
  render(createElement(ChatHome, {
    selectedId,
    onSelect,
    recentTitle: 'Недавние агенты',
    suggestedTitle: 'Предложенные',
  }))
  return { onSelect }
}

beforeEach(() => localStorage.clear())
afterEach(() => cleanup())

describe('ChatHome — characterization', () => {
  it('секция «Предложенные» показывает всех агентов каталога', () => {
    mountHome()
    const suggested = screen.getByLabelText('Предложенные')
    const buttons = within(suggested).getAllByRole('button')
    expect(buttons).toHaveLength(HOME_AGENTS.length)
    expect(within(suggested).getByText('Code')).toBeTruthy()
  })

  it('«Недавние» без истории — фолбэк на первых трёх агентов', () => {
    mountHome()
    const recent = screen.getByLabelText('Недавние агенты')
    const buttons = within(recent).getAllByRole('button')
    expect(buttons).toHaveLength(3)
    expect(buttons[0].textContent).toContain(HOME_AGENTS[0].name)
  })

  it('выбор агента: onSelect с агентом + id пишется в recent', () => {
    const { onSelect } = mountHome()
    const suggested = screen.getByLabelText('Предложенные')
    fireEvent.click(within(suggested).getByText('Code'))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0].id).toBe('code')
    expect(JSON.parse(localStorage.getItem(RECENT_KEY)!)).toEqual(['code'])
  })

  it('recent из localStorage поднимается в секцию (максимум 4, без дублей)', () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify(['ops', 'code', 'ops', 'unknown-id', 'design', 'research', 'writing']))
    mountHome()
    const recent = screen.getByLabelText('Недавние агенты')
    const names = within(recent).getAllByRole('button').map(b => b.textContent)
    expect(names).toHaveLength(4)
    expect(names[0]).toContain('Ops Agent')
    // unknown-id отфильтрован, дубль ops склеен на записи (при push), здесь — фильтрация чтения
    expect(names.every(n => !n!.includes('unknown'))).toBe(true)
  })

  it('битый JSON в localStorage не роняет рендер — фолбэк на первых трёх', () => {
    localStorage.setItem(RECENT_KEY, '{не json')
    mountHome()
    const recent = screen.getByLabelText('Недавние агенты')
    expect(within(recent).getAllByRole('button')).toHaveLength(3)
  })

  it('выбранный агент помечается is-selected', () => {
    mountHome('design')
    const suggested = screen.getByLabelText('Предложенные')
    const designBtn = within(suggested).getByText('Design').closest('button')!
    expect(designBtn.className).toContain('is-selected')
  })
})

describe('ChatHomeAside — characterization', () => {
  it('без выбора — честный пустой стейт', () => {
    render(createElement(ChatHomeAside, {
      selectedId: null,
      onUsePrompt: vi.fn(),
      asideEmpty: 'Выберите агента, чтобы начать',
      asideStart: 'Начать',
    }))
    expect(screen.getByText('Выберите агента, чтобы начать')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('с выбором — имя, описание и кнопка «Начать» отдаёт prompt агента', () => {
    const onUsePrompt = vi.fn()
    render(createElement(ChatHomeAside, {
      selectedId: 'research',
      onUsePrompt,
      asideEmpty: 'Выберите агента, чтобы начать',
      asideStart: 'Начать',
    }))
    expect(screen.getByText('Research Agent')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Начать' }))
    expect(onUsePrompt).toHaveBeenCalledWith(HOME_AGENTS.find(a => a.id === 'research')!.prompt)
  })

  it('неизвестный selectedId → пустой стейт, без падения', () => {
    render(createElement(ChatHomeAside, {
      selectedId: 'nope',
      onUsePrompt: vi.fn(),
      asideEmpty: 'Выберите агента, чтобы начать',
      asideStart: 'Начать',
    }))
    expect(screen.getByText('Выберите агента, чтобы начать')).toBeTruthy()
  })
})
