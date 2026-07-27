// @vitest-environment jsdom
//
// 2.1.11 срез C — characterization рендера потока, снятая ДО переноса.
//
// Поток (сообщения, разделители дат, tool-таймлайн, карточки preflight/sub-agent,
// live-блок ответа) жил внутри Chat.tsx одним 300-строчным `messages.map`. Прямых
// проверок на разметку не было вовсе.
//
// ПОЧЕМУ ЭТОТ СРЕЗ ОПАСНЕЕ ОСТАЛЬНЫХ. После PerChatState 4.4 состояние чата
// читается живым из `chats` — это единственный источник (коммит ef4af73). Регрессия
// здесь возвращает класс багов «событие фонового чата упало в активный»: поток
// показывает не то, что принадлежит открытому чату. Поэтому сетка обязана держать
// три режима, и держит их ниже: активный чат стримит / фоновый чат стримит /
// переключение чата во время живого прогона.
//
// ГРАНИЦА ХАРНЕССА — та же, что у композера (docs/CODE-AUDIT-2026-07-25.md, 2.1.11):
// только СИНХРОННЫЕ проверки через `act()`, события агента подаются ПРЯМОЙ эмиссией
// `mock.aiEvents.emit`. Реальный конвейер отправки под jsdom не завершается, поэтому
// его здесь нет вовсе — и не должно быть.
import { seedActive } from '../store/_active-bundle'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { makeApiMock, CHAT_API_DEFAULTS, type ApiMock } from './helpers/window-api-mock'

const { useProject } = await import('../../src/store/projectStore')
const { freshSnapshot } = await import('../../src/store/session-snapshot')
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

/** Разметка потока активного чата. Читаем именно её, а не весь документ: так пин
 *  не спутает текст сообщения с тем же текстом в сайдбаре или в композере. */
function stream(): HTMLElement {
  const el = document.querySelector('.gg-chat-stream-inner')
  if (!el) throw new Error('поток не отрендерился — характеризовать нечего')
  return el as HTMLElement
}

/** Прогон агента: регистрируем owner, как это делает send(). */
function startRun(sendId: number, chatId: number): void {
  act(() => {
    useProject.getState().registerSendOwner(sendId, { kind: 'chat', chatId, projectPath: '/p' })
    useProject.getState().setStreaming(true)
    useProject.getState().addMessage({ role: 'assistant', content: '' })
  })
}

function emit(id: number, event: Record<string, unknown>): void {
  act(() => { mock.aiEvents.emit({ id, event } as never) })
}

function switchTo(chatId: number): void {
  act(() => { useProject.setState({ activeChatId: chatId }, false) })
}

beforeEach(() => {
  mock = makeApiMock(CHAT_API_DEFAULTS)
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
  useProject.setState({
    path: '/p', activeChatId: 7, chats: {},
    sendOwners: {}, chatSessions: [{ id: 7 }, { id: 8 }] as never, helpMode: false,
  }, false)
  seedActive(useProject, { messages: [], isStreaming: false })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('поток — разметка сообщений', () => {
  it('сообщений нет — вместо списка домашний экран', () => {
    mountChat()
    expect(stream().querySelector('.gg-msg')).toBeNull()
    expect(document.querySelector('.gg-chat-home, .gg-home')).toBeTruthy()
  })

  it('сообщение пользователя: свой класс, пузырь с текстом, дата-атрибуты', () => {
    mountChat()
    act(() => { useProject.getState().addMessage({ role: 'user', content: 'вопрос' }) })
    const msg = stream().querySelector('.gg-msg') as HTMLElement
    expect(msg.className).toContain('gg-msg-user')
    expect(msg.querySelector('.gg-msg-bubble')?.textContent).toBe('вопрос')
    expect(msg.getAttribute('data-message-date-label')).toBeTruthy()
    expect(msg.getAttribute('data-message-day')).toBeTruthy()
  })

  it('перед первым сообщением дня стоит разделитель даты', () => {
    mountChat()
    act(() => { useProject.getState().addMessage({ role: 'user', content: 'вопрос' }) })
    const divider = stream().querySelector('.gg-chat-date-divider')
    expect(divider).toBeTruthy()
    expect(divider?.getAttribute('role')).toBe('separator')
    expect(divider?.querySelector('.gg-chat-date-divider-label')?.textContent).toBeTruthy()
    // Второе сообщение того же дня второго разделителя не добавляет.
    act(() => { useProject.getState().addMessage({ role: 'user', content: 'ещё' }) })
    expect(stream().querySelectorAll('.gg-chat-date-divider').length).toBe(1)
  })

  it('готовое сообщение получает панель действий, стримящееся — нет', () => {
    mountChat()
    act(() => { useProject.getState().addMessage({ role: 'user', content: 'вопрос' }) })
    expect(stream().querySelector('.gg-msg-user .gg-msg-actions')).toBeTruthy()
    startRun(311, 7)
    expect(stream().querySelector('.gg-msg-assistant .gg-msg-actions')).toBeNull()
  })
})

describe('поток — live-блок ответа', () => {
  it('ответ пустой и идёт прогон — индикатор набора, автор и живой таймер', () => {
    mountChat()
    act(() => { useProject.getState().addMessage({ role: 'user', content: 'вопрос' }) })
    startRun(312, 7)
    const assistant = stream().querySelector('.gg-msg-assistant') as HTMLElement
    expect(assistant.querySelector('.gg-typing')).toBeTruthy()
    expect(assistant.querySelector('.gg-msg-author')?.textContent).toBeTruthy()
    expect(assistant.querySelector('.gg-msg-duration.is-live')).toBeTruthy()
  })

  it('прогона нет — ни индикатора набора, ни живого таймера', () => {
    mountChat()
    act(() => { useProject.getState().addMessage({ role: 'user', content: 'вопрос' }) })
    expect(stream().querySelector('.gg-typing')).toBeNull()
    expect(stream().querySelector('.gg-msg-duration.is-live')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Ядро среза C: чей поток видно. Регрессия здесь = возврат бага «событие фонового
// чата упало в активный».
// ─────────────────────────────────────────────────────────────────────────────
describe('поток — чей стрим видно (PerChatState)', () => {
  it('активный чат стримит: текст доезжает в поток активного чата', () => {
    mountChat()
    act(() => { useProject.getState().addMessage({ role: 'user', content: 'вопрос' }) })
    startRun(321, 7)
    emit(321, { type: 'text', text: 'ответ модели' })
    emit(321, { type: 'done' })
    expect(stream().textContent).toContain('ответ модели')
    expect(stream().querySelector('.gg-typing')).toBeNull()
  })

  it('фоновый чат стримит: в поток активного чата НЕ попадает ничего', () => {
    mountChat()
    act(() => {
      useProject.getState().registerSendOwner(322, { kind: 'chat', chatId: 8, projectPath: '/p' })
    })
    emit(322, { type: 'text', text: 'ФОНОВЫЙ ТЕКСТ' })
    emit(322, { type: 'done' })
    expect(stream().textContent).not.toContain('ФОНОВЫЙ ТЕКСТ')
    expect(stream().querySelector('.gg-msg')).toBeNull()
    // …и при этом текст не потерян: он лёг в bundle своего чата.
    expect(useProject.getState().chats[8]?.messages.at(-1)?.content).toBe('ФОНОВЫЙ ТЕКСТ')
  })

  it('переключение во время прогона: поток показывает новый чат, не прежний', () => {
    mountChat()
    act(() => { useProject.getState().addMessage({ role: 'user', content: 'вопрос седьмого' }) })
    startRun(323, 7)
    emit(323, { type: 'text', text: 'ответ седьмому' })
    emit(323, { type: 'done' })
    expect(stream().textContent).toContain('ответ седьмому')

    act(() => {
      useProject.setState({
        chats: {
          ...useProject.getState().chats,
          8: { ...freshSnapshot(), chatId: 8, messages: [{ role: 'user', content: 'вопрос восьмого' }] },
        },
      }, false)
    })
    switchTo(8)
    expect(stream().textContent).toContain('вопрос восьмого')
    expect(stream().textContent).not.toContain('ответ седьмому')

    // Возврат: поток прежнего чата на месте, ничего не смешалось.
    switchTo(7)
    expect(stream().textContent).toContain('ответ седьмому')
    expect(stream().textContent).not.toContain('вопрос восьмого')
  })

  it('прогон продолжает лить в свой чат, пока открыт другой', () => {
    mountChat()
    startRun(324, 7)
    switchTo(8)
    emit(324, { type: 'text', text: 'догоняющий текст' })
    emit(324, { type: 'done' })
    expect(stream().textContent).not.toContain('догоняющий текст')
    switchTo(7)
    expect(stream().textContent).toContain('догоняющий текст')
  })
})

describe('поток — карточки под последним ответом', () => {
  it('tool-активность рендерится строками под последним ответом', () => {
    mountChat()
    seedActive(useProject, {
      messages: [{ role: 'user', content: 'вопрос' }, { role: 'assistant', content: 'ответ' }],
      activity: [
        { id: 'a1', kind: 'read', label: 'Читаю файл', detail: 'src/index.ts', status: 'ok', timestamp: 1 },
        { id: 'a2', kind: 'write', label: 'Пишу файл', detail: 'src/app.ts', status: 'ok', timestamp: 2 },
      ],
    })
    act(() => { useProject.setState({}, false) })
    const rows = stream().querySelectorAll('.gg-activity-row')
    expect(rows.length).toBe(2)
    expect(rows[0].className).toContain('is-ok')
    expect(rows[0].querySelector('.gg-activity-label')?.textContent).toBe('Читаю файл')
    expect(rows[0].querySelector('.gg-activity-detail')?.textContent).toBe('src/index.ts')
  })

  it('успешные записи собираются в блок изменённых файлов', () => {
    mountChat()
    seedActive(useProject, {
      messages: [{ role: 'user', content: 'вопрос' }, { role: 'assistant', content: 'ответ' }],
      activity: [{ id: 'w1', kind: 'write', label: 'Пишу', detail: 'src/app.ts', status: 'ok', timestamp: 1 }],
    })
    act(() => { useProject.setState({}, false) })
    const changed = stream().querySelector('.gg-changed-files')
    expect(changed).toBeTruthy()
    expect(changed?.querySelector('.gg-changed-files-title')?.textContent).toContain('(1)')
    expect(changed?.querySelector('.gg-changed-files-row')?.textContent).toBe('src/app.ts')
  })

  it('preflight-карточка показывает риск, зоны и проверки', () => {
    mountChat()
    seedActive(useProject, {
      messages: [{ role: 'user', content: 'вопрос' }, { role: 'assistant', content: 'ответ' }],
      preflights: [{
        callId: 'pf1', summary: 'Правлю конфиг', affectedZones: ['electron/'],
        risk: 'high', riskReason: 'деструктивно', verifyAfter: ['npm run type'], outOfScope: ['миграции'],
      }],
    })
    act(() => { useProject.setState({}, false) })
    const pf = stream().querySelector('.gg-preflight') as HTMLElement
    expect(pf).toBeTruthy()
    expect(pf.className).toContain('is-high')
    expect(pf.querySelector('.gg-preflight-pill')?.textContent).toBe('высокий риск')
    expect(pf.querySelector('.gg-preflight-summary')?.textContent).toBe('Правлю конфиг')
    expect(pf.querySelector('.gg-preflight-reason')?.textContent).toBe('деструктивно')
    expect(pf.querySelectorAll('.gg-preflight-section').length).toBe(4)
    expect(pf.querySelector('.gg-preflight-opentask')).toBeTruthy()
  })

  it('карточка sub-agent показывает статус, метки и результат', () => {
    mountChat()
    seedActive(useProject, {
      messages: [{ role: 'user', content: 'вопрос' }, { role: 'assistant', content: 'ответ' }],
      subagentRuns: [{
        callId: 'sa1', label: 'Ревьюер', task: 'проверить диф', status: 'done',
        provider: 'claude', skill: 'code-review', role: 'reviewer', toolCount: 3, result: 'всё чисто',
      }],
    })
    act(() => { useProject.setState({}, false) })
    const sa = stream().querySelector('.gg-subagent') as HTMLElement
    expect(sa).toBeTruthy()
    expect(sa.className).toContain('is-done')
    expect(sa.querySelector('.gg-subagent-pill')?.textContent).toBe('готово')
    expect(sa.querySelector('.gg-subagent-task')?.textContent).toBe('проверить диф')
    expect(sa.querySelectorAll('.gg-subagent-tag').length).toBe(4)
    expect(sa.querySelector('.gg-subagent-result-body')?.textContent).toBe('всё чисто')
  })

  it('размышление модели свёрнуто при видимом ответе и развёрнуто без него', () => {
    mountChat()
    seedActive(useProject, {
      messages: [{ role: 'assistant', content: 'ответ', thinking: 'рассуждение' }],
    })
    act(() => { useProject.setState({}, false) })
    const withAnswer = stream().querySelector('.gg-thinking') as HTMLDetailsElement
    expect(withAnswer).toBeTruthy()
    expect(withAnswer.open).toBe(false)
    expect(withAnswer.querySelector('.gg-thinking-len')?.textContent).toBe('11 симв.')

    seedActive(useProject, { messages: [{ role: 'assistant', content: '', thinking: 'рассуждение' }] })
    act(() => { useProject.setState({}, false) })
    const onlyThinking = stream().querySelector('.gg-thinking') as HTMLDetailsElement
    expect(onlyThinking.open).toBe(true)
    expect(onlyThinking.querySelector('.gg-thinking-summary')?.textContent)
      .toContain('Только размышление, без видимого ответа')
  })
})
