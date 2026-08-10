// @vitest-environment jsdom
//
// V1 (волна 2.6.0): телеметрия подвала свёрнута под одну иконку.
//
// ЧТО ЗАКРЕПЛЕНО: по умолчанию раскрытие закрыто; клик по иконке его открывает и
// закрывает; ВСЕ прежние узлы телеметрии остались на месте (ничего не удалено и
// не переименовано), и значения в них — из того же источника, что и раньше.
//
// ГРАНИЦА ЭТИХ ПИНОВ, названная прямо. Видимость держит CSS (класс `is-closed`),
// а jsdom стилей не применяет — значит проверять «человек этого не видит» здесь
// нечем, и пин стережёт СОСТОЯНИЕ (класс + aria-expanded), а не пиксели. Узлы
// намеренно не размонтируются: 46 характеризационных пинов чата ищут их
// селектором, и размонтирование сделало бы их зелёными по причине исчезновения
// элемента, а не сохранности поведения.
import { seedActive } from '../store/_active-bundle'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { makeApiMock, CHAT_API_DEFAULTS, type ApiMock } from './helpers/window-api-mock'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { useProject } = await import('../../src/store/projectStore')
const { emptySessionUsage } = await import('../../src/store/session-snapshot')
const { Chat } = await import('../../src/components/Chat')

let mock: ApiMock

function mountChat() {
  return render(createElement(Chat, {
    onOpenSettings: vi.fn(),
    rightPanel: null as never,
    onSelectRightPanel: vi.fn(),
    isSettingsOpen: false,
    onOpenSideChat: vi.fn(),
    onOpenFilePreview: vi.fn(),
  }))
}

const drawer = () => document.querySelector('.gg-telemetry-drawer') as HTMLElement | null
const toggle = () => document.querySelector('.gg-telemetry-btn') as HTMLButtonElement

beforeEach(() => {
  mock = makeApiMock({ ...CHAT_API_DEFAULTS })
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
  useProject.setState({ path: '/p', activeChatId: 1 }, false)
  seedActive(useProject, { sessionUsage: { ...emptySessionUsage(), inputTokens: 3_700_000, outputTokens: 15_000, cachedInputTokens: 1_200_000 } })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('V1: подвал по умолчанию без телеметрии', () => {
  it('раскрытие закрыто, иконка сообщает это через aria-expanded', () => {
    mountChat()

    expect(toggle(), 'иконки показателей нет — телеметрию нечем открыть').toBeTruthy()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(drawer()!.className).toContain('is-closed')
    expect(drawer()!.className).not.toContain('is-open')
  })

  it('клик открывает раскрытие, повторный — закрывает', () => {
    mountChat()

    act(() => { fireEvent.click(toggle()) })
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(drawer()!.className).toContain('is-open')

    act(() => { fireEvent.click(toggle()) })
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(drawer()!.className).toContain('is-closed')
  })
})

describe('V1: ни одно число не потеряно', () => {
  it('прежние узлы телеметрии живут ВНУТРИ раскрытия, а не удалены', () => {
    mountChat()
    const d = drawer()!

    // Расход за чат (↑ ↓ ⟲ · $) и переключатель автопрокрутки — те же узлы.
    expect(d.querySelector('.gg-usage-pill'), 'пилюля расхода исчезла из разметки').toBeTruthy()
    expect(d.querySelector('.gg-auto-scroll-btn'), 'переключатель автопрокрутки исчез').toBeTruthy()
  })

  it('значения в раскрытии — из того же источника (стор), а не копия', () => {
    mountChat()
    const pill = drawer()!.querySelector('.gg-usage-pill') as HTMLElement
    const before = pill.textContent ?? ''
    expect(before).toContain('3.7M')   // inputTokens из seedActive
    expect(before).toContain('15k')    // outputTokens

    // Меняем ИСТОЧНИК — текст обязан поехать следом. Копия так себя не повела бы.
    act(() => {
      seedActive(useProject, { sessionUsage: { ...emptySessionUsage(), inputTokens: 1000, outputTokens: 2000 } })
    })

    const after = (drawer()!.querySelector('.gg-usage-pill') as HTMLElement).textContent ?? ''
    expect(after, 'значение не следует за стором — в раскрытии лежит копия').not.toBe(before)
    // 2000 токенов формат показывает как «2.0k» — сверяемся с тем, что человек
    // реально видит, а не с сырым числом (иначе пин мерил бы не выдачу).
    expect(after).toContain('2.0k')
  })

  // Кнопка отката рендерится только при undoCount > 0, а это ЛОКАЛЬНОЕ состояние
  // Chat.tsx — из теста его не задать, и DOM-проверка была бы условной, то есть
  // декоративной (первая версия этого кейса именно такой и была). Поэтому здесь
  // структурная проверка по исходнику: блок отката обязан стоять ВНЕ раскрытия.
  it('откат правки остаётся НА ВИДУ: его разметка вне раскрытия (это действие, не показатель)', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/chat/ComposerMetaRow.tsx'), 'utf8')
    const drawerClose = src.indexOf('</div>', src.indexOf('gg-telemetry-drawer'))
    const undoAt = src.indexOf('gg-undo-btn')

    expect(drawerClose).toBeGreaterThan(-1)
    expect(undoAt, 'кнопка отката исчезла из подвала').toBeGreaterThan(-1)
    expect(undoAt, 'кнопку отмены спрятали за раскрытие — отняли доступ к действию').toBeGreaterThan(drawerClose)
  })
})
