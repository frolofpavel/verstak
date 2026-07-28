// Хвост §10, дефект 2: «Одобрить» повышало режим ЧАТА, а не прогона.
//
// ДЕФЕКТ. Продолжение после approve несло режим `accept-edits`, а применялся он
// через `setAgentMode` — то есть через `writeAgentMode`, который пишет в
// настройку `agent_mode_chat_N`. Один клик по «Одобрить» переводил чат из `ask`
// в `accept-edits` НАВСЕГДА: следующие сообщения в этом чате уже не спрашивали
// подтверждения на правки, хотя человек соглашался ровно на один план. Строка
// матрицы §5 для `ask` жила ровно до первого одобренного плана.
//
// ЧТО ЗАКРЕПЛЕНО. Права даёт ОДНА отправка: режим едет параметром `ai:send`
// (он там был всегда — `overrides.agentMode`), настройка чата не трогается.
// Прогон закончился — чат остался в своём режиме.
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentMode } from '../../src/components/ModePicker'
import type { ChatMessage } from '../../src/types/api'
import {
  sendChatMessage,
  type ChatSendOverrides,
  type ChatSendProjectState,
  type SendChatMessageDeps,
  type SendChatMessageInput,
} from '../../src/components/chat/send-chat-message'

const CHAT_ID = 7

function makeHarness(opts: { chatMode: AgentMode; runMode?: AgentMode | null }) {
  const state: ChatSendProjectState = {
    messages: [],
    agentProgress: [],
    effortLevel: 'standard',
    promptRouteOverride: null,
    earlyRouteStop: null,
    hasActiveChatLane: vi.fn(() => false),
    clearActivity: vi.fn(),
    setAgentProgress: vi.fn(),
    addMessage: vi.fn(m => { state.messages.push(m) }),
    setStreaming: vi.fn(),
    updateLastAssistant: vi.fn(),
    autoTitleChatSession: vi.fn(async () => {}),
    setPromptRouteOverride: vi.fn(),
    setEarlyRouteStop: vi.fn(),
    applyAgentProgressEvent: vi.fn(),
  }
  const sent: Array<{ overrides: ChatSendOverrides }> = []
  let runMode = opts.runMode ?? null
  const deps: SendChatMessageDeps = {
    getProjectState: () => state,
    getSkillsState: () => ({ skills: [] }),
    api: {
      runLoaders: vi.fn(async () => ({ context: '', labels: [] })),
      resolveMentions: vi.fn(async () => ''),
      chatsAppend: vi.fn(async (_c, _p, role) => ({ id: role === 'assistant' ? 42 : 1 })),
      chatsUpdateMessage: vi.fn(async () => {}),
      getSetting: vi.fn(async () => null),
      sendWithOverrides: vi.fn(async (_m: ChatMessage[], _p, overrides: ChatSendOverrides) => {
        sent.push({ overrides })
        return 7
      }),
    },
    ensureProjectForChat: vi.fn(async () => ({ path: '/p', activeChatId: CHAT_ID })),
    flashWarning: vi.fn(),
    queueFollowUp: vi.fn(),
    resetComposerAfterSend: vi.fn(),
    armAutoScrollForOutgoing: vi.fn(),
    readAgentMode: vi.fn(async () => opts.chatMode),
    registerChatSendOwner: vi.fn(),
    registerPersistedAssistant: vi.fn(),
    setCurrentSendId: vi.fn(),
    setExhausted: vi.fn(),
    setCrossVerify: vi.fn(),
    consumeResumeFromRunId: vi.fn(() => 'run-plan-1'),
    consumePipelineOutcome: vi.fn(() => null),
    getPipelineAutoSendStep: vi.fn(() => null),
    setPipelineExecuteSendId: vi.fn(),
    consumeRunAgentMode: vi.fn(() => { const v = runMode; runMode = null; return v }),
  }
  return { deps, sent }
}

const input: SendChatMessageInput = {
  text: '✅ Пользователь ОДОБРИЛ план «Лендинг».',
  modelText: '✅ Пользователь ОДОБРИЛ план «Лендинг».',
  displayText: '✅ Пользователь ОДОБРИЛ план «Лендинг».',
  attachments: [],
  providerLabel: 'Claude',
  messageAppliedSkills: [],
  messageAppliedSkillDetails: [],
  skillCatalog: [],
  activeSkillIdForSend: null,
  autoBoundSkillDetails: [],
}

describe('§10 хвост: одобрение плана даёт права ПРОГОНУ, а не чату', () => {
  it('режим продолжения побеждает режим чата ровно в этой отправке', async () => {
    const h = makeHarness({ chatMode: 'ask', runMode: 'accept-edits' })
    await sendChatMessage(input, h.deps)

    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].overrides.agentMode, 'одобренный план обязан ехать с правами на правки').toBe('accept-edits')
    expect(h.deps.consumeRunAgentMode, 'режим прогона потребляется однократно').toHaveBeenCalledTimes(1)
  })

  it('без продолжения отправка идёт в режиме чата — прежнее поведение', async () => {
    const h = makeHarness({ chatMode: 'ask', runMode: null })
    await sendChatMessage(input, h.deps)
    expect(h.sent[0].overrides.agentMode).toBe('ask')
  })

  it('второй отправки права не достаются: режим прогона одноразовый', async () => {
    const h = makeHarness({ chatMode: 'ask', runMode: 'accept-edits' })
    await sendChatMessage(input, h.deps)
    await sendChatMessage(input, h.deps)
    expect(h.sent.map(s => s.overrides.agentMode)).toEqual(['accept-edits', 'ask'])
  })
})

// Настройку режима чата пишет ТОЛЬКО Chat.tsx, и под jsdom его send() не
// завершается (граница characterization чата, см. chat-composer-characterization).
// Поэтому вторую половину дефекта — «настройка чата не трогается» — стережём на
// исходнике: мутация (вернуть setAgentMode в ветку продолжения) даёт красный.
describe('§10 хвост: продолжение плана не переключает режим чата', () => {
  const source = readFileSync(join(process.cwd(), 'src/components/Chat.tsx'), 'utf8')

  it('ветка автоотправки продолжения не зовёт setAgentMode', () => {
    const effect = source.slice(source.indexOf('resumeAutoSendRef.current && input.trim()'))
      .slice(0, 900)
    expect(effect, 'setAgentMode здесь пишет agent_mode_chat_N — режим чата навсегда')
      .not.toContain('setAgentMode(')
  })

  it('режим продолжения уезжает одноразовым параметром прогона', () => {
    expect(source).toContain('consumeRunAgentMode')
  })

  // ВТОРАЯ ВЕТКА ТОЙ ЖЕ КНОПКИ (доработка после ревью 28.07). При выключенном
  // тумблере карточки рождает НЕ чат-контекст, а Outcome-пайплайн: гейт
  // применим по первой оси (outcomePhase==='plan'), тумблер там не спрашивается.
  // Approve такой карточки идёт через advancePipeline → gg-pipeline-send, и ЭТА
  // ветка писала agent_mode_chat_N ровно так же — то есть живая половина
  // дефекта 2 оставалась открытой.
  it('pipeline-отправка не зовёт setAgentMode', () => {
    const handler = source.slice(source.indexOf('function onPipelineSend')).slice(0, 700)
    expect(handler, 'pipeline-ветка пишет режим в настройку чата — навсегда')
      .not.toContain('setAgentMode(')
  })
})
