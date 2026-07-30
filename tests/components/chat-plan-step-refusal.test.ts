// @vitest-environment jsdom
//
// §2.4 A3 · отказ человека не выдаётся за выполненный шаг плана.
//
// ЧТО БЫЛО СЛОМАНО, и это хуже, чем «статус не ставится» из ТЗ. Диспетчер на
// событии `done` писал шагу `status: 'done'`, на `error` — `'failed'`, третьего
// исхода не было. А отказ завершает прогон ШТАТНО: инструмент возвращает «User
// rejected» обычным результатом, модель его читает и заканчивает ход — приходит
// `done`. Значит шаг, который человек ЗАПРЕТИЛ, отмечался ВЫПОЛНЕННЫМ, и в
// «Планах» стояла запись-неправда. Молчание было бы честнее.
//
// Пишем `'skipped'` — тем же значением, что уже кладёт пайплайн-ось
// (`outcome.ts`: «работа не сделана, но и не провалена»). Разные статусы на двух
// осях для одного исхода стали бы заготовкой дрейфа, который сегодня чинили
// дважды.
//
// ПОД JSDOM ТОЛЬКО СИНХРОННЫЕ ПРОВЕРКИ через act() и прямая эмиссия событий —
// правило §3.1: реальный конвейер отправки из смонтированного Chat не
// завершается и вешает прогон. Образец — chat-usage-cost.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { seedActive } from '../store/_active-bundle'
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

function startRunOnStep(sendId: number) {
  act(() => {
    useProject.getState().registerSendOwner(sendId, { kind: 'chat', chatId: 7, projectPath: '/p' })
    useProject.getState().setStreaming(true)
    useProject.getState().addMessage({ role: 'assistant', content: 'работаю' })
    useProject.getState().setRunningPlanStep({ planId: 1, stepId: 42, title: 'Выложить сайт' })
  })
}

/** Все вызовы plans.updateStep с их аргументами. */
function updateStepCalls() {
  return (mock.calls.get('plans.updateStep')?.mock.calls ?? []) as Array<[number, { status?: string; result?: string }]>
}

beforeEach(() => {
  mock = makeApiMock(CHAT_API_DEFAULTS)
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
  useProject.setState({
    path: '/p', activeChatId: 7,
    sendOwners: {}, chatSessions: [{ id: 7 }] as never, helpMode: false,
  }, false)
  seedActive(useProject, { messages: [], isStreaming: false, sessionUsage: emptySessionUsage() })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('§2.4 · шаг плана при отказе человека', () => {
  // ОБЯЗАТЕЛЬНЫЙ ПИН: до фикса здесь стояло 'done'.
  it('отказ от команды → шаг помечен пропущенным, а не выполненным', () => {
    mountChat()
    startRunOnStep(301)

    act(() => {
      mock.aiEvents.emit({ id: 301, event: { type: 'command-result', callId: 'c1', command: 'git push', status: 'rejected' } })
      mock.aiEvents.emit({ id: 301, event: { type: 'done' } })
    })

    const [call] = updateStepCalls()
    expect(call, 'статус шага не записан вовсе').toBeTruthy()
    expect(call[0]).toBe(42)
    expect(call[1].status, 'шаг, который человек запретил, записан выполненным').toBe('skipped')
    expect(String(call[1].result), 'человеку не объяснено, почему шаг не сделан').toMatch(/отказ/i)
  })

  // КОНТРОЛЬ: без отказа поведение прежнее — иначе «починка» превратила бы
  // каждый успешный шаг в пропущенный.
  it('контроль: успешный прогон по-прежнему помечает шаг выполненным', () => {
    mountChat()
    startRunOnStep(302)

    act(() => {
      mock.aiEvents.emit({ id: 302, event: { type: 'command-result', callId: 'c1', command: 'npm test', status: 'ok' } })
      mock.aiEvents.emit({ id: 302, event: { type: 'done' } })
    })

    expect(updateStepCalls()[0][1].status).toBe('done')
  })

  // КОНТРОЛЬ: отметка отказа эфемерна. Иначе один отказ отравил бы все
  // последующие шаги этого чата, и они бы вечно числились пропущенными.
  it('контроль: следующий прогон начинается чистым', () => {
    mountChat()
    startRunOnStep(303)
    act(() => {
      mock.aiEvents.emit({ id: 303, event: { type: 'command-result', callId: 'c1', command: 'rm -rf x', status: 'rejected' } })
      mock.aiEvents.emit({ id: 303, event: { type: 'done' } })
    })

    startRunOnStep(304)
    act(() => {
      mock.aiEvents.emit({ id: 304, event: { type: 'done' } })
    })

    const calls = updateStepCalls()
    expect(calls[0][1].status).toBe('skipped')
    expect(calls[1][1].status, 'прошлый отказ отравил следующий шаг').toBe('done')
  })

  // КОНТРОЛЬ: сбой инструмента — не отказ человека. Провал не должен
  // маскироваться под сознательное решение.
  it('контроль: ошибка прогона по-прежнему даёт failed, а не skipped', () => {
    mountChat()
    startRunOnStep(305)

    act(() => {
      mock.aiEvents.emit({ id: 305, event: { type: 'error', message: 'провайдер недоступен' } })
    })

    expect(updateStepCalls()[0][1].status).toBe('failed')
  })
})
