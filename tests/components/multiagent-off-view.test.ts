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
const { useSkills } = await import('../../src/store/skillStore')
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
  // ПРАВКА ФИКСТУРЫ, объявляю (§3.1): утверждения не изменились ни на слово —
  // изменился путь к меню. Шаг 3 цели 2.7.0 снял ВТОРОЙ экземпляр «Выбрать»,
  // висевший на виду; единственный оставшийся живёт в «Инструментах чата» и
  // монтируется только с открытым поповером. Раньше фикстура находила пилюлю
  // сразу после mountChat — теперь сначала открывает поповер.
  it('в меню нет пункта «Мультиагент», а остальные пункты на месте', () => {
    mountChat()
    const settings = document.querySelector('.gg-chat-settings-btn') as HTMLButtonElement | null
    if (!settings) throw new Error('нет входа в «Инструменты чата» — пин потерял якорь')
    act(() => { fireEvent.click(settings) })
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

  // Критерий 5 цели 2.7.0 дословно: «Инструмент: 275 доступно» человеку не
  // адресован вовсе. Число — счётчик реестра: оно меняется от установки чужих
  // скиллов, а не от чего-либо, что человек делает, и отвечает на вопрос,
  // которого никто не задавал.
  //
  // ПЕРВАЯ РЕДАКЦИЯ ЭТОГО ПИНА БЫЛА ЛОЖНО-ЗЕЛЁНОЙ, объявляю (§3.1). Она просто
  // открывала меню и убеждалась, что «N доступно» нигде нет, — и проходила ДО
  // правки тоже, потому что в моке скиллов ноль, а на пустом реестре подпись и
  // так читается «нет инструментов». Ветка со счётчиком была недостижима, то
  // есть пин стерёг вход, которого в фикстуре не существует. Поймано мутацией:
  // возврат `${skills.length} доступно` не уронил ни одного кейса.
  //
  // Здесь реестр СЕЯТСЯ явно — только тогда проверяемая ветка достижима.
  function openToolsMenuWithSkills(): string[] {
    act(() => {
      useSkills.setState({
        skills: [
          { id: 'a', name: 'Ревью кода', source: 'built-in' },
          { id: 'b', name: 'Сводка git', source: 'built-in' },
          { id: 'c', name: 'Объяснить код', source: 'built-in' },
        ] as never,
        activeSkillId: null,
      }, false)
    })
    mountChat()
    act(() => { fireEvent.click(document.querySelector('.gg-chat-settings-btn') as HTMLButtonElement) })
    act(() => { fireEvent.click(document.querySelector('.gg-tools-pill') as HTMLButtonElement) })
    return Array.from(document.querySelectorAll('.gg-tools-menu-meta')).map(el => (el.textContent ?? '').trim())
  }

  it('подпись пункта «Инструмент» не показывает счётчик реестра', () => {
    const metas = openToolsMenuWithSkills()
    // КОНТРОЛЬ 1: меню раскрылось и подписи вообще есть — иначе «числа нет»
    // было бы зелено на пустом DOM.
    expect(metas.length, 'подписи пунктов не отрисовались — пин потерял якорь').toBeGreaterThan(0)
    expect(metas.some(m => /\d+\s*доступно/.test(m)), 'счётчик реестра всё ещё на виду').toBe(false)
  })

  // КОНТРОЛЬ 2 к тому же кейсу: реестр в фикстуре НЕПУСТОЙ, то есть ветка, где
  // раньше рисовалось число, реально проходится. Без этого утверждения кейс
  // выше снова стал бы измерять пустоту.
  it('КОНТРОЛЬ: реестр непустой, и подпись говорит про ВЫБОР, а не про количество', () => {
    const metas = openToolsMenuWithSkills()
    expect(useSkills.getState().skills.length, 'реестр пуст — ветка со счётчиком недостижима').toBe(3)
    expect(metas, 'подпись не сообщает, что инструмент не выбран').toContain('не выбран')
  })
})
