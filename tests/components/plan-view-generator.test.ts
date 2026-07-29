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
// Пакет A2: форма зовёт продуктовый метод main, а не собирает промпт сама.
let generateResult: { ok: boolean; planId?: number; error?: string; notice?: string } = { ok: true, planId: 7 }
const plansGenerate = vi.fn(async (_req: { projectPath: string; title: string; taskDescription: string; clarification?: string }) => generateResult)
const plansCancelGenerate = vi.fn(async () => true)

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
      plans: {
        list: plansList, create: plansCreate, get: vi.fn(async () => null), updateStep: vi.fn(), setStatus: vi.fn(),
        generate: plansGenerate, cancelGenerate: plansCancelGenerate,
      },
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

  it('генерация идёт через продуктовый метод main, а НЕ через прямой plans.create', () => {
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
    // Пакет A2 §3: renderer передаёт НАМЕРЕНИЕ, а не промпт. Прежний вариант
    // (событие в чат с собранным здесь промптом) запрещён прямо.
    expect(sent, 'renderer больше не собирает промпт и не шлёт его в чат').toHaveLength(0)
    expect(plansGenerate).toHaveBeenCalledTimes(1)
    const req = plansGenerate.mock.calls[0][0] as unknown as { title: string; taskDescription: string; projectPath: string }
    expect(req.title).toBe('Настройка Директа')
    expect(req.taskDescription).toBe('Изучи контекст проекта и составь план настройки кампаний')
    expect(req.projectPath).toBe('/p')
  })

  it('пустое состояние объясняет оба входа — раздел и чат', () => {
    const { container } = mount()
    expect(container.textContent).toContain('Verstak сам сформирует план')
  })
})

// Пакет A2 §4/§6: состояния формы. Проверяется ПОВЕДЕНИЕ (что вызов не ушёл,
// что текст остался), а не наличие слов в разметке.
describe('A2 §4: состояния формы генерации', () => {
  it('во время генерации кнопка занята и повторный запуск НЕ уходит в main', async () => {
    let release: ((v: { ok: boolean; planId?: number }) => void) | null = null
    plansGenerate.mockImplementationOnce(() => new Promise(r => { release = r }))
    const { container } = mount()
    const [titleInput] = Array.from(container.querySelectorAll('input'))
    const [brief] = Array.from(container.querySelectorAll('textarea'))
    act(() => { type(titleInput, 'План') })
    act(() => { type(brief, 'Описание задачи') })
    const btn = () => Array.from(container.querySelectorAll('button')).find(b => /Сгенерировать план|Формирую план/.test(b.textContent ?? ''))!

    act(() => { btn().dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(btn().textContent).toBe('Формирую план…')
    expect((btn() as HTMLButtonElement).disabled, 'кнопка доступна во время работы').toBe(true)

    act(() => { btn().dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(plansGenerate, 'двойной клик отправил второй запрос').toHaveBeenCalledTimes(1)

    await act(async () => { release!({ ok: true, planId: 7 }) })
  })

  it('во время генерации доступна отмена и она зовёт штатный stop', async () => {
    let release: ((v: { ok: boolean }) => void) | null = null
    plansGenerate.mockImplementationOnce(() => new Promise(r => { release = r }))
    const { container } = mount()
    const [titleInput] = Array.from(container.querySelectorAll('input'))
    const [brief] = Array.from(container.querySelectorAll('textarea'))
    act(() => { type(titleInput, 'План') })
    act(() => { type(brief, 'Описание задачи') })
    act(() => {
      Array.from(container.querySelectorAll('button'))
        .find(b => b.textContent === 'Сгенерировать план')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const cancel = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Отменить')
    expect(cancel, 'отмены во время генерации нет').toBeTruthy()
    act(() => { cancel!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(plansCancelGenerate).toHaveBeenCalledWith('/p')

    await act(async () => { release!({ ok: false }) })
  })

  it('ошибка видна, а введённый текст НЕ теряется', async () => {
    generateResult = { ok: false, error: 'Не удалось сформировать план. Не указан кабинет.' }
    const { container } = mount()
    const [titleInput] = Array.from(container.querySelectorAll('input'))
    const [brief] = Array.from(container.querySelectorAll('textarea'))
    act(() => { type(titleInput, 'Настройка Директа') })
    act(() => { type(brief, 'Проверь кампании') })

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find(b => b.textContent === 'Сгенерировать план')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('Не указан кабинет')
    expect((titleInput as HTMLInputElement).value, 'название потеряно при ошибке').toBe('Настройка Директа')
    expect((brief as HTMLTextAreaElement).value, 'описание потеряно при ошибке').toBe('Проверь кампании')
    generateResult = { ok: true, planId: 7 }
  })

  it('успех очищает поля — постановка закрыта', async () => {
    generateResult = { ok: true, planId: 7 }
    const { container } = mount()
    const [titleInput] = Array.from(container.querySelectorAll('input'))
    const [brief] = Array.from(container.querySelectorAll('textarea'))
    act(() => { type(titleInput, 'План') })
    act(() => { type(brief, 'Описание') })

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find(b => b.textContent === 'Сгенерировать план')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect((titleInput as HTMLInputElement).value).toBe('')
    expect((brief as HTMLTextAreaElement).value).toBe('')
  })
})

// ДЕФЕКТ 1 ЖИВОЙ ПРИЁМКИ (29.07). У пользователя с подпиской (`codex-cli`)
// генерация физически не может идти на его провайдере: инструменты у CLI живут
// внутри бинаря, и вызов `create_plan` наружу не выходит. Раньше это давало отказ
// с внутренним термином; теперь — фолбэк на настроенный API-провайдер.
//
// Правило дня применено буквально: «зелёные тесты ≠ работающая функция». Главный
// процесс может отдавать `notice` идеально, а человек не увидит ничего. Поэтому
// проверяется ЭКРАН.
describe('дефект 1: подмена провайдера объясняется на экране', () => {
  function fill(container: HTMLElement) {
    const [titleInput] = Array.from(container.querySelectorAll('input'))
    const [brief] = Array.from(container.querySelectorAll('textarea'))
    act(() => { type(titleInput, 'Настройка Директа') })
    act(() => { type(brief, 'Проверь кампании') })
    return { titleInput: titleInput as HTMLInputElement, brief: brief as HTMLTextAreaElement }
  }
  const press = async (container: HTMLElement) => {
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find(b => b.textContent === 'Сгенерировать план')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }
  const notice = (container: HTMLElement) =>
    container.querySelector('[data-testid="plan-gen-notice"]')?.textContent ?? null

  it('план собран на другом провайдере → объяснение видно человеку', async () => {
    generateResult = { ok: true, planId: 7, notice: 'План собран на «ChatGPT»: «Codex» работает по подписке.' }
    const { container } = mount()
    fill(container)
    await press(container)

    expect(notice(container), 'подмена провайдера прошла молча').toContain('ChatGPT')
    generateResult = { ok: true, planId: 7 }
  })

  // КОНТРОЛЬ: без него первый кейс был бы зелёным и от «показываем всегда».
  it('контроль: подмены не было → на экране никакого объяснения', async () => {
    generateResult = { ok: true, planId: 7 }
    const { container } = mount()
    fill(container)
    await press(container)

    expect(notice(container), 'объяснение показано там, где подмены не было').toBeNull()
  })

  it('генерировать не на чем → инструкция на экране, текст задачи цел', async () => {
    generateResult = {
      ok: false,
      error: 'Откройте Настройки → Провайдеры и добавьте ключ любого из: Gemini, Claude, ChatGPT.',
    }
    const { container } = mount()
    const { titleInput, brief } = fill(container)
    await press(container)

    expect(container.textContent).toContain('Настройки')
    expect(container.textContent, 'внутренний термин показан человеку').not.toContain('unattended')
    expect(titleInput.value, 'название потеряно').toBe('Настройка Директа')
    expect(brief.value, 'описание потеряно').toBe('Проверь кампании')
    generateResult = { ok: true, planId: 7 }
  })
})
