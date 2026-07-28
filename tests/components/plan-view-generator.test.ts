// @vitest-environment jsdom
//
// Блок C, §7.1 ТЗ: в разделе «Планы» ручной ввод шагов заменён AI-генератором.
//
// Почему это не косметика. Прямой `plans.create` кладёт в БД ровно то, что
// напечатал человек: без контекста проекта, без порога согласования, без
// проверки качества ТЗ. Такой план внешне неотличим от сформированного, но
// цикл «задача → план → согласование → выполнение» на нём не работает.
// Поэтому кнопка обязана идти ЧЕРЕЗ AI и `create_plan` — это и закреплено.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, act } from '@testing-library/react'

const { useProject } = await import('../../src/store/projectStore')
const { PlanView } = await import('../../src/components/PlanView')

const plansCreate = vi.fn(async () => ({ id: 1 }))
const plansList = vi.fn(async () => [])

function mount() {
  return render(createElement(PlanView))
}

const type = (el: Element, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  plansCreate.mockClear()
  vi.stubGlobal('window', Object.assign(globalThis.window, {
    api: {
      plans: { list: plansList, create: plansCreate, get: vi.fn(async () => null), updateStep: vi.fn(), setStatus: vi.fn() },
      pipeline: { listStepOutcomes: vi.fn(async () => []) },
    },
  }))
  useProject.setState({ path: '/p', activeChatId: 7, chats: {}, activeView: 'plan', activePipeline: null }, false)
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('§7.1: раздел «Планы» — генератор вместо ручных шагов', () => {
  it('поля ручного ввода шагов больше нет, есть «Что нужно сделать»', () => {
    const { container } = mount()
    const areas = Array.from(container.querySelectorAll('textarea')).map(t => t.getAttribute('placeholder'))
    expect(areas).toContain('Что нужно сделать')
    expect(areas, 'ручной список шагов обходит планирование и гейт').not.toContain('Шаги, по одному на строку')
  })

  it('кнопка называется «Сгенерировать план» и без описания недоступна', () => {
    const { container } = mount()
    const btn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Сгенерировать план')
    expect(btn, 'кнопки генерации нет').toBeTruthy()
    expect((btn as HTMLButtonElement).disabled, 'пустое описание не должно запускать прогон').toBe(true)
  })

  it('генерация идёт через AI, а НЕ через прямой plans.create', () => {
    const { container } = mount()
    const [titleInput] = Array.from(container.querySelectorAll('input'))
    const [brief] = Array.from(container.querySelectorAll('textarea'))
    const sent: string[] = []
    window.addEventListener('gg-resume-send', (e) => {
      const d = (e as CustomEvent<{ text: string }>).detail
      sent.push(typeof d === 'string' ? d : d.text)
    })

    act(() => { type(titleInput, 'Настройка Директа') })
    act(() => { type(brief, 'Изучи контекст проекта и составь план настройки кампаний') })
    const btn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Сгенерировать план')!
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(plansCreate, 'прямой plans.create минует планирование и порог').not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('Настройка Директа')
    expect(sent[0]).toContain('Изучи контекст проекта и составь план настройки кампаний')
    expect(sent[0], 'план обязан сохраняться тем же инструментом, что и из чата').toContain('create_plan')
    expect(useProject.getState().activeView, 'работа идёт в чате — туда и переключаемся').toBe('chat')
  })

  it('пустое состояние объясняет оба входа — раздел и чат', () => {
    const { container } = mount()
    expect(container.textContent).toContain('Verstak сам сформирует план')
  })
})
