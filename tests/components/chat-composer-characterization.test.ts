// @vitest-environment jsdom
//
// 2.1.11 срез B — characterization композера, снятая ДО переноса.
//
// Композер (ввод, скилл-полосы, служебные контролы, горячие клавиши) жил внутри
// 4100-строчного Chat.tsx и напрямую не проверялся. Клавиатурный контракт —
// «Shift+Enter переносит строку, слэш-команду Enter не отправляет, во время стрима
// Enter ставит в очередь, Esc останавливает» — держался только глазами на ревью.
//
// Эти тесты написаны против ИСХОДНОГО Chat.tsx и после выноса компонентов обязаны
// остаться зелёными БЕЗ ЕДИНОЙ ПРАВКИ. Любая правка теста при переносе означает,
// что перенос изменил поведение.
//
// ГРАНИЦА ХАРНЕССА (осознанная, задокументирована при снятии). Проверки только
// синхронные, и ни одна не запускает реальный конвейер отправки. Причина не в
// удобстве: под jsdom вызов send() из смонтированного Chat НЕ ЗАВЕРШАЕТСЯ — любое
// асинхронное продолжение после Enter (await act, флаш микрозадач, setTimeout)
// вешает прогон наглухо. Это свойство существующей связки Chat + стор + proxy-мок,
// а не переносa; чинить его здесь нельзя — срез обязан быть поведенчески пустым.
// Поэтому пины покрывают ГАРДЫ (когда отправки быть не должно) — именно там живёт
// риск переноса. Позитивный путь «Enter реально отправил» остаётся за
// tests/components/send-chat-message.test.ts, который дёргает конвейер напрямую.
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
    rightPanel: null as never,
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

function press(key: string, mods: Record<string, boolean> = {}): void {
  act(() => { fireEvent.keyDown(textarea(), { key, ...mods }) })
}

/** Спаи в моке ленивые: не тронули свойство — записи нет. 0 = «не вызывали». */
function callCount(name: string): number {
  return mock.calls.get(name)?.mock.calls.length ?? 0
}

function startStreaming(sendId = 501, chatId = 7): void {
  act(() => {
    useProject.getState().registerSendOwner(sendId, { kind: 'chat', chatId, projectPath: '/p' })
    useProject.getState().setStreaming(true)
  })
}

beforeEach(() => {
  mock = makeApiMock({
    ...CHAT_API_DEFAULTS,
    // Формы, которые читает код композера: без них проверки проходят, но прогон
    // заканчивается unhandled-ошибкой (SlashCommandPopup мапит список команд,
    // appendTextToCurrentContext читает res.ok).
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

describe('композер — гарды отправки', () => {
  it('Shift+Enter не отправляет: это перенос строки, текст остаётся в поле', () => {
    mountChat()
    type('первая строка')
    press('Enter', { shiftKey: true })
    expect(callCount('ai.sendWithOverrides')).toBe(0)
    expect(textarea().value).toBe('первая строка')
  })

  it('пустой композер: Enter не отправляет ничего', () => {
    mountChat()
    press('Enter')
    expect(callCount('ai.sendWithOverrides')).toBe(0)
  })

  // Слэш-команду обрабатывает SlashCommandPopup своим хэндлером. Если композер тоже
  // отреагирует на Enter — команда И выполнится, И уедет в модель текстом.
  it('под слэш-командой Enter не отправляет — попап обрабатывает сам', () => {
    mountChat()
    type('/code-review')
    press('Enter')
    expect(callCount('ai.sendWithOverrides')).toBe(0)
    expect(textarea().value).toBe('/code-review')
  })
})

// VSK-PRODUCT-A1 (композер): «Папка с документами» + подпись после выбора (B1).
describe('композер — папка с документами', () => {
  // ОБЪЯВЛЯЮ ПРАВКУ ПИНА (§3.1): утверждение изменено, потому что контракт A1
  // ОТМЕНЁН решением Павла 16.08 — «кнопки файлов вообще одинаковые, одна
  // функция». Пин требовал, чтобы 📁 стояла В КОМПОЗЕРЕ рядом со скрепкой, то
  // есть требовал ровно того, что цель 2.7.0 (критерий 4) убирает.
  //
  // Это снятие отменённого контракта, а не подгонка под правку: сохранить пин
  // зелёным было можно, только оставив вторую файловую кнопку на месте.
  //
  // Что осталось под охраной и почему именно так. Разбор показал, что две кнопки
  // выглядели близнецами из-за НЕВЕРНОГО ИМЕНИ: 📁 ничего не прикрепляла, она
  // открывала выбранную папку ПРОЕКТОМ (`pickMaterialsFolder` → `setProject`).
  // Поэтому проверяется теперь пара утверждений: в композере файловая кнопка
  // ровно одна, а действие никуда не делось — живёт в «Инструментах чата» под
  // именем, называющим последствие.
  it('в композере ОДНА файловая кнопка — 📁 рядом со скрепкой больше нет', () => {
    mountChat()
    const actions = document.querySelector('.gg-composer-actions')
    expect(actions).toBeTruthy()
    expect(actions!.querySelectorAll('.gg-attach-btn').length).toBe(1)
    expect(actions!.querySelector('.gg-materials-btn')).toBeNull()
  })

  it('действие не потеряно: «открыть папку проектом» живёт в «Инструментах чата»', () => {
    mountChat()
    const settings = document.querySelector('.gg-chat-settings-btn') as HTMLElement
    expect(settings, 'нет кнопки поповера — пин потерял якорь').toBeTruthy()
    act(() => { fireEvent.click(settings) })
    const btn = document.querySelector('.gg-materials-btn')
    expect(btn, 'папка с документами исчезла совсем — это потеря возможности').toBeTruthy()
    expect(btn?.getAttribute('title')).toContain('как проект')
  })

  it('вооружённая папка → подпись B1 «{имя}: N документов в корне» с явной границей', () => {
    act(() => { useProject.setState({ materialsFolder: { path: '/p/Договоры', name: 'Договоры', docCount: 3 } }, false) })
    mountChat()
    const note = document.querySelector('.gg-materials-armed') as HTMLElement
    expect(note).toBeTruthy()
    expect(note.textContent).toContain('Договоры: 3 документа в корне')
    expect(note.getAttribute('title')).toBe('/p/Договоры')   // полный путь в подсказке
  })

  it('подпись склоняет «документ» по числу (1 / 2 / 5)', () => {
    act(() => { useProject.setState({ materialsFolder: { path: '/p/a', name: 'a', docCount: 1 } }, false) })
    const r1 = mountChat()
    expect(document.querySelector('.gg-materials-armed')?.textContent).toContain('1 документ в корне')
    r1.unmount()
    act(() => { useProject.setState({ materialsFolder: { path: '/p/b', name: 'b', docCount: 5 } }, false) })
    mountChat()
    expect(document.querySelector('.gg-materials-armed')?.textContent).toContain('5 документов в корне')
  })
})

describe('композер во время стрима', () => {
  it('Enter не стартует второй прогон, а ставит сообщение в очередь и чистит поле', () => {
    mountChat()
    startStreaming()
    type('и ещё вот это')
    press('Enter')
    expect(callCount('ai.sendWithOverrides')).toBe(0)
    expect(textarea().value).toBe('')
  })

  it('Ctrl+Enter не стартует второй прогон — уходит в дописывание контекста', () => {
    mountChat()
    startStreaming(777)
    type('уточнение на лету')
    press('Enter', { ctrlKey: true })
    expect(callCount('ai.sendWithOverrides')).toBe(0)
  })

  it('во время стрима показывается стоп, а не отправка', () => {
    mountChat()
    startStreaming()
    expect(document.querySelector('.gg-stop-btn')).toBeTruthy()
  })
})

describe('композер — кнопка отправки', () => {
  it('пустой композер: кнопка заблокирована', () => {
    mountChat()
    expect((document.querySelector('.gg-send-btn') as HTMLButtonElement).disabled).toBe(true)
  })

  it('появился текст — кнопка разблокирована', () => {
    mountChat()
    type('поехали')
    expect((document.querySelector('.gg-send-btn') as HTMLButtonElement).disabled).toBe(false)
  })

  it('пробелы отправку не разблокируют', () => {
    mountChat()
    type('   ')
    expect((document.querySelector('.gg-send-btn') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('композер — служебные контролы', () => {
  it('переключатель автопрокрутки меняет состояние', () => {
    mountChat()
    const before = (document.querySelector('.gg-auto-scroll-btn') as HTMLButtonElement).getAttribute('aria-pressed')
    act(() => { fireEvent.click(document.querySelector('.gg-auto-scroll-btn') as HTMLButtonElement) })
    const after = (document.querySelector('.gg-auto-scroll-btn') as HTMLButtonElement).getAttribute('aria-pressed')
    expect(after).not.toBe(before)
  })

  it('«Инструменты чата» открывают и закрывают поповер', () => {
    mountChat()
    expect(document.querySelector('.gg-chat-settings-popover')).toBeNull()
    act(() => { fireEvent.click(document.querySelector('.gg-chat-settings-btn') as HTMLButtonElement) })
    expect(document.querySelector('.gg-chat-settings-popover')).toBeTruthy()
    act(() => { fireEvent.click(document.querySelector('.gg-chat-settings-btn') as HTMLButtonElement) })
    expect(document.querySelector('.gg-chat-settings-popover')).toBeNull()
  })

  it('вложений нет — ряд вложений не рендерится', () => {
    mountChat()
    expect(document.querySelector('.gg-attach-row')).toBeNull()
  })

  it('скиллов не применено — полоса применённых скиллов не рендерится', () => {
    mountChat()
    expect(document.querySelector('.gg-applied-skills-draft')).toBeNull()
  })
})

// Пины под срез B-остаток (ядро композера): ряд ввода, скрытый файловый вход,
// кнопка вложения и её блокировка на стриме. Сняты ДО переноса ряда в компонент.
describe('композер — ряд ввода', () => {
  it('ряд ввода содержит поле, действия и скрытый файловый вход', () => {
    mountChat()
    expect(document.querySelector('.gg-composer-inner')).toBeTruthy()
    expect(document.querySelector('.gg-composer-actions')).toBeTruthy()
    const file = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(file).toBeTruthy()
    expect(file.multiple).toBe(true)
    expect(file.style.display).toBe('none')
  })

  it('кнопка вложения активна вне стрима и блокируется на стриме', () => {
    mountChat()
    expect((document.querySelector('.gg-attach-btn') as HTMLButtonElement).disabled).toBe(false)
    startStreaming()
    expect((document.querySelector('.gg-attach-btn') as HTMLButtonElement).disabled).toBe(true)
  })

  it('поле ввода однострочное по умолчанию и хранит текст композера', () => {
    mountChat()
    expect(textarea().rows).toBe(1)
    type('черновик')
    expect(textarea().value).toBe('черновик')
  })

  it('пауза не предлагается, когда прогон не идёт', () => {
    mountChat()
    expect(document.querySelector('.gg-pause-btn')).toBeNull()
  })
})

// Пины под срез B-остаток, часть 2 (нижняя строка композера: gg-composer-hint +
// gg-composer-meta). Сняты ДО переноса блока в отдельный компонент.
describe('композер — нижняя строка', () => {
  it('нижняя строка держит оба кластера меты', () => {
    mountChat()
    expect(document.querySelector('.gg-composer-hint')).toBeTruthy()
    expect(document.querySelector('.gg-composer-meta')).toBeTruthy()
    expect(document.querySelectorAll('.gg-composer-meta-cluster').length).toBe(2)
    expect(document.querySelector('.gg-composer-meta-cluster--end')).toBeTruthy()
  })

  it('правок не было — кнопка отката не рендерится', () => {
    mountChat()
    expect(document.querySelector('.gg-undo-btn')).toBeNull()
  })

  it('превью черновика нет — счётчик токенов не рендерится', () => {
    mountChat()
    expect(document.querySelector('.gg-usage-pill.is-preview')).toBeNull()
    expect(document.querySelector('.gg-usage-meter-label')).toBeNull()
  })

  it('расхода за сессию нет — пилюля usage не рендерится', () => {
    mountChat()
    expect(document.querySelector('.gg-usage-pill')).toBeNull()
  })

  // ОБЪЯВЛЯЮ ПРАВКУ ПИНА (§3.1). Здесь стоял пин «турбо-кнопка при дефолтном
  // режиме (auto) сообщает включённое состояние» — он стерёг САМО СУЩЕСТВОВАНИЕ
  // 🔥 `.gg-chat-turbo-btn` на виду. Контракт отменён шагом 3 цели 2.7.0.
  //
  // Почему кнопка снята, а не переименована. Режим по умолчанию — `auto`
  // (решение Павла, 11.08), то есть продукт УЖЕ принял это решение; кнопка на
  // виду предлагала отменить его собственный дефолт. Ровно то же самое сказано
  // словами строкой «Режим» в «Инструментах чата», где выбор и остаётся. Плюс
  // «Турбо» на экране было ДВА и означало разное: 🔥 — режим безопасности
  // (auto/ask), `IntensityToggle` — интенсивность (сколько машинерии). Оси
  // ортогональны, но две соседние кнопки с одним словом объяснять пришлось бы.
  //
  // ЧТО НЕ ПОТЕРЯНО И ЧЕМ ЭТО ДОКАЗАНО. Само СВОЙСТВО, которое пин измерял —
  // «UI отражает фактический режим агента» — под охраной осталось: полная пара
  // по значениям настройки живёт в tests/lib/agent-mode-default.test.ts (там
  // же, где жило зеркало этого кейса, и по той же причине — чтение настроек
  // асинхронно, а под jsdom асинхронное ожидание в смонтированном Chat вешает
  // прогон без вывода). Здесь остаётся то, что можно проверить синхронно:
  // выбор режима доступен в поповере.
  it('🔥 турбо-кнопки на виду нет — режим выбирается в «Инструментах чата»', () => {
    mountChat()
    expect(document.querySelector('.gg-chat-turbo-btn')).toBeNull()
    act(() => { fireEvent.click(document.querySelector('.gg-chat-settings-btn') as HTMLButtonElement) })
    const popover = document.querySelector('.gg-chat-settings-popover') as HTMLElement
    expect(popover, 'поповер не открылся — пин потерял якорь').toBeTruthy()
    expect(popover.textContent).toContain('Режим')
  })

  it('подсказки стрима нет, пока черновик пуст и прогон не идёт', () => {
    mountChat()
    expect(document.querySelector('.gg-composer-streaming-hint')).toBeNull()
    startStreaming()
    type('и ещё вот это')
    expect(document.querySelector('.gg-composer-streaming-hint')).toBeTruthy()
  })

  // ОБЪЯВЛЯЮ ПРАВКУ ПИНА (§3.1). Здесь стоял пин «в конце меты стоят пикеры
  // режима, модели и маршрута» — он стерёг контракт «пикеры висят на виду»,
  // отменённый критерием 5 цели 2.7.0 дословно: по умолчанию не показывается
  // ничего, кроме поля ввода и отправки.
  //
  // Снятие, а не подгонка: ModelPicker, ModePicker и меню «Выбрать»
  // рендерились ДВАЖДЫ — в поповере и рядом на виду. Удалён второй экземпляр;
  // дом остался прежним. Утверждение переворачивается — и это ровно та пара,
  // без которой «схлопнули» неотличимо от «сломали».
  it('на виду в конце меты — только вход в «Инструменты чата»', () => {
    mountChat()
    const end = document.querySelector('.gg-composer-meta-cluster--end') as HTMLElement
    expect(end).toBeTruthy()
    expect(end.querySelector('.gg-chat-settings-wrap')).toBeTruthy()
    // Пикеры (общий класс .gg-mp-wrap у ModelPicker и ModePicker) в закрытом
    // состоянии не отрисованы вовсе: поповер монтируется только открытым.
    expect(end.querySelector('.gg-mp-wrap')).toBeNull()
    expect(end.querySelector('.gg-intensity-pill')).toBeNull()
    expect(end.querySelector('.gg-effort-wrap')).toBeNull()
  })

  it('КОНТРОЛЬ: всё спрятанное живо — поповер отдаёт модель, режим и интенсивность', () => {
    mountChat()
    act(() => { fireEvent.click(document.querySelector('.gg-chat-settings-btn') as HTMLButtonElement) })
    const popover = document.querySelector('.gg-chat-settings-popover') as HTMLElement
    expect(popover).toBeTruthy()
    expect(popover.querySelectorAll('.gg-mp-wrap').length, 'пикеры модели/режима потеряны, а не спрятаны').toBeGreaterThanOrEqual(2)
    expect(popover.querySelector('.gg-intensity-pill'), 'интенсивность потеряна').toBeTruthy()
    expect(popover.querySelector('.gg-effort-wrap'), 'глубина потеряна').toBeTruthy()
  })

  it('EffortPicker ушёл из ряда ввода композера', () => {
    mountChat()
    expect(document.querySelector('.gg-composer-actions .gg-effort-wrap')).toBeNull()
  })
})
