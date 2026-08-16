// @vitest-environment jsdom
//
// Цель 2.7.0, шаг 2 пункт 2: «Оркестратор и рой убрать с виду».
//
// ПОЧЕМУ ЭТО НЕ ПОТЕРЯ ВОЗМОЖНОСТИ. Обе точки входа не запускали ничего: они
// вставляли в поле ввода текст-шаблон (см. шапку src/lib/multi-agent-templates.ts),
// который ПРОСИТ агента вызвать orchestrate/swarm/delegate_parallel. Сами
// инструменты живут у агента и вызываются им самим — ровно как в Claude Code.
// Кнопка давала не возможность, а формулировку.
//
// КОНТРОЛЬНЫЙ КЕЙС ОБЯЗАТЕЛЕН (CLAUDE.md §3.1): рядом с каждым «элемента нет»
// стоит кейс, где тот же элемент ЕСТЬ. Иначе пин зелен и тогда, когда попап не
// отрендерился вовсе, — то есть не измеряет ничего.
import { seedActive } from '../store/_active-bundle'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { makeApiMock, CHAT_API_DEFAULTS, type ApiMock } from './helpers/window-api-mock'

const { useProject } = await import('../../src/store/projectStore')
const { emptySessionUsage } = await import('../../src/store/session-snapshot')
const { Chat } = await import('../../src/components/Chat')

let mock: ApiMock

function mountChat() {
  return render(createElement(Chat, {
    onOpenSettings: vi.fn(),
    rightPanel: 'none' as never,
    onSelectRightPanel: vi.fn(),
    isSettingsOpen: false,
    onOpenSideChat: vi.fn(),
    onOpenFilePreview: vi.fn(),
  }))
}

function textarea(): HTMLTextAreaElement {
  const el = document.querySelector('.gg-composer-textarea')
  if (!el) throw new Error('композер не отрендерился — характеризовать нечего')
  return el as HTMLTextAreaElement
}

function type(text: string): void {
  act(() => { fireEvent.change(textarea(), { target: { value: text } }) })
}

/** Триггеры, показанные в попапе слэш-команд (строки вида "/new — Новый чат"). */
function popupTriggers(): string[] {
  return Array.from(document.querySelectorAll('.gg-slash-name'))
    .map(el => (el.textContent ?? '').trim())
}

beforeEach(() => {
  mock = makeApiMock({
    ...CHAT_API_DEFAULTS,
    commands: { list: async () => [] },
    ai: { appendContext: async () => ({ ok: true, mode: 'live' }) },
  })
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
  useProject.setState({
    path: '/p', activeChatId: 7,
    sendOwners: {}, chatSessions: [{ id: 7 }] as never, helpMode: false,
  }, false)
  seedActive(useProject, { messages: [], isStreaming: false, sessionUsage: emptySessionUsage() })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('мультиагент — не на виду, но досягаем', () => {
  it('список слэш-команд по «/» НЕ предлагает orchestrate / swarm / parallel', () => {
    mountChat()
    type('/')
    const triggers = popupTriggers()
    // Контроль отрисовки: попап реально построен и что-то показывает. Без этой
    // строки пин был бы зелён на несмонтированном попапе.
    expect(triggers.length).toBeGreaterThan(0)
    expect(triggers.some(t => t.startsWith('/orchestrate'))).toBe(false)
    expect(triggers.some(t => t.startsWith('/swarm'))).toBe(false)
    expect(triggers.some(t => t.startsWith('/parallel'))).toBe(false)
  })

  it('первый уровень остаётся: /new и /clear предлагаются как раньше', () => {
    mountChat()
    type('/')
    const triggers = popupTriggers()
    expect(triggers.some(t => t.startsWith('/new'))).toBe(true)
    expect(triggers.some(t => t.startsWith('/clear'))).toBe(true)
  })

  // КОНТРОЛЬНЫЙ КЕЙС к первому: команда не удалена, а снята с витрины. Кто её
  // знает — набирает и получает. Это и есть «отладочный путь, не кнопка».
  it('набранная целиком команда всё ещё находится — доступ не потерян', () => {
    mountChat()
    type('/orch')
    expect(popupTriggers().some(t => t.startsWith('/orchestrate'))).toBe(true)
    type('/swa')
    expect(popupTriggers().some(t => t.startsWith('/swarm'))).toBe(true)
    type('/paral')
    expect(popupTriggers().some(t => t.startsWith('/parallel'))).toBe(true)
  })

  // Одной буквы мало: иначе скрытая команда всплывала бы почти на каждый ввод и
  // «не на виду» превратилось бы в «на виду через раз».
  it('одной-двух букв недостаточно, чтобы скрытая команда всплыла', () => {
    mountChat()
    type('/o')
    expect(popupTriggers().some(t => t.startsWith('/orchestrate'))).toBe(false)
    type('/or')
    expect(popupTriggers().some(t => t.startsWith('/orchestrate'))).toBe(false)
  })
})

describe('меню «Выбрать» — пункта «Мультиагент» больше нет', () => {
  it('в меню нет пункта «Мультиагент», а остальные пункты на месте', () => {
    mountChat()
    const pill = document.querySelector('.gg-tools-pill') as HTMLButtonElement | null
    if (!pill) throw new Error('меню «Выбрать» не отрендерилось — пин потерял якорь')
    act(() => { fireEvent.click(pill) })
    const labels = Array.from(document.querySelectorAll('.gg-tools-menu-label'))
      .map(el => (el.textContent ?? '').trim())
    // Контроль: меню раскрылось и пункты вообще есть.
    expect(labels).toContain('Инструмент')
    expect(labels).toContain('Чекпоинт')
    expect(labels).not.toContain('Мультиагент')
  })
})
