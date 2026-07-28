// @vitest-environment jsdom
//
// Доработка хвоста §10 после ревью 28.07, дефект 1 доработки: «Одобрить» ВСЁ ЕЩЁ
// меняло режим чата навсегда — только другой веткой.
//
// ПОЧЕМУ ЭТО ЖИВАЯ ПОЛОВИНА. При выключенном тумблере «ждать одобрения плана»
// карточки согласования рождает не чат-контекст, а Outcome-пайплайн: гейт
// применим по ПЕРВОЙ оси (`outcomePhase === 'plan'`, plan-gate-modes.ts), где
// тумблер не спрашивается вовсе. Approve такой карточки идёт не через
// `gg-resume-send`, а через `advancePipeline` → `gg-pipeline-send`, и тот
// обработчик звал `setAgentMode(d.mode)` — то есть `writeAgentMode` → настройка
// `agent_mode_chat_N`. Один одобренный план пайплайна оставлял чат в
// «Принимать правки» навсегда.
//
// ЧТО ЗАКРЕПЛЕНО. Событие pipeline-отправки не пишет режим чата. Права на
// правки едут тем же одноразовым параметром прогона, что и у чат-ветки.
//
// Стрим держим включённым намеренно: авто-send под jsdom не доводится до конца
// (объявленная граница characterization чата), а `isStreaming` — тот самый
// гард, который его не пускает. Проверяем ровно доставку события, без отправки.
import { seedActive } from '../store/_active-bundle'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { makeApiMock, CHAT_API_DEFAULTS, type ApiMock } from './helpers/window-api-mock'

const { useProject } = await import('../../src/store/projectStore')
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

/** Сколько раз renderer записал режим агента в настройки этого чата. */
function modeWrites(): unknown[][] {
  const calls = mock.calls.get('settings.setKey')?.mock.calls ?? []
  return calls.filter(c => typeof c[0] === 'string' && (c[0] as string).startsWith('agent_mode'))
}

beforeEach(() => {
  mock = makeApiMock(CHAT_API_DEFAULTS)
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: mock.api }))
  useProject.setState({
    path: '/p', activeChatId: 7, chats: {},
    sendOwners: {}, chatSessions: [{ id: 7 }] as never, helpMode: false,
  }, false)
  seedActive(useProject, { messages: [], isStreaming: true }, 7)
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('доработка §10: pipeline-approve не меняет режим чата', () => {
  it('gg-pipeline-send с режимом «accept-edits» не пишет agent_mode_chat_N', () => {
    mountChat()
    act(() => {
      window.dispatchEvent(new CustomEvent('gg-pipeline-send', {
        detail: {
          text: 'Выполняй шаги утверждённого плана',
          mode: 'accept-edits',
          outcome: { pipelineId: 1, phase: 'execute-step' },
        },
      }))
    })

    expect(modeWrites(), 'одобрение плана пайплайна переводило чат в accept-edits навсегда')
      .toEqual([])
  })

  it('то же для plan-шага пайплайна: режим чата не переписывается', () => {
    mountChat()
    act(() => {
      window.dispatchEvent(new CustomEvent('gg-pipeline-send', {
        detail: { text: 'Составь план', mode: 'plan', outcome: { pipelineId: 1, phase: 'plan' } },
      }))
    })

    expect(modeWrites()).toEqual([])
  })
})
