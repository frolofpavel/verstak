// Characterization-харнес help-ветки send() (фаза 5, срез 1): поведение зафиксировано
// ПРИ выносе из Chat.tsx в src/components/chat/send-help-message.ts. Падение любого
// сценария = расхождение с бывшей inline-веткой (Chat.tsx ~2806-2888 до выноса).
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, Skill } from '../../src/types/api'
import { buildInitialAgentProgress } from '../../src/lib/agent-progress'
import {
  sendHelpMessage,
  type HelpSendProjectState,
  type HelpSendOverrides,
  type SendHelpMessageDeps,
  type SendHelpMessageInput,
} from '../../src/components/chat/send-help-message'

const ASSISTANT_ROW_ID = 42

const skillWithLoaders: Skill = {
  id: 's1',
  name: 'S1',
  systemPrompt: 'SYS',
  source: 'user',
  sourceRef: 'ref',
  default_provider: 'openai',
  default_model: 'gpt-x',
  tools_allow: ['read_file'],
  context_loaders: [{ id: 'l1', impl: 'load_today_brief', runs_on: 'chat_open' }],
  recipe: { id: 'r1', kind: 'k', trigger: [], read_set: [], steps: [], stop: [] },
}

function makeHarness(opts: {
  helpChatId?: number | null
  laneActive?: boolean
  effort?: 'quick' | 'standard' | 'deep'
  messages?: ChatMessage[]
  skills?: Skill[]
  activeSkillId?: string | null
  sendId?: number
  loadersResult?: { context: string; labels: string[] }
  loadersThrow?: boolean
  provider?: string | null
} = {}) {
  const calls: string[] = []
  const state: HelpSendProjectState = {
    helpChatId: opts.helpChatId === undefined ? 77 : opts.helpChatId,
    help: { messages: [...(opts.messages ?? [])], agentProgress: [] },
    effortLevel: opts.effort ?? 'standard',
    hasActiveChatLane: vi.fn(() => opts.laneActive ?? false),
    clearHelpActivity: vi.fn(() => { calls.push('clearHelpActivity') }),
    setHelpAgentProgress: vi.fn(() => { calls.push('setHelpAgentProgress') }),
    addHelpMessage: vi.fn((m) => { calls.push(`addHelpMessage:${m.role}`); state.help.messages.push(m) }),
    setHelpStreaming: vi.fn((v) => { calls.push(`setHelpStreaming:${v}`) }),
    updateHelpLastAssistant: vi.fn(() => { calls.push('updateHelpLastAssistant') }),
    applyEventToHelp: vi.fn((e) => { calls.push(`applyEventToHelp:${e.type}`) }),
  }
  const sentCalls: Array<{ messages: ChatMessage[]; projectPath: string | null; overrides: HelpSendOverrides; chatId?: string }> = []
  const appended: Array<{ role: string; content: string }> = []
  const loadersCalls: Array<{ skillId: string; opts: { arg?: string; projectPath?: string | null; trigger: string } }> = []
  const updatedMessages: Array<{ id: number; content: string }> = []
  const deps: SendHelpMessageDeps = {
    getProjectState: () => state,
    getSkillsState: () => ({ activeSkillId: opts.activeSkillId ?? null, skills: opts.skills ?? [] }),
    api: {
      chatsAppend: vi.fn(async (_chatId, _path, role, content) => {
        calls.push(`append:${role}`)
        appended.push({ role, content })
        return { id: role === 'assistant' ? ASSISTANT_ROW_ID : 1 }
      }),
      chatsUpdateMessage: vi.fn(async (id, content) => { calls.push('updateMessage'); updatedMessages.push({ id, content }) }),
      runLoaders: vi.fn(async (skillId, o) => {
        calls.push('runLoaders')
        loadersCalls.push({ skillId, opts: o })
        if (opts.loadersThrow) throw new Error('boom')
        return opts.loadersResult ?? { context: '', labels: [] }
      }),
      getSetting: vi.fn(async () => { calls.push('getSetting'); return opts.provider ?? null }),
      sendWithOverrides: vi.fn(async (messages, projectPath, overrides, chatId) => {
        calls.push('sendWithOverrides')
        sentCalls.push({ messages, projectPath, overrides, chatId })
        return opts.sendId ?? 7
      }),
    },
    queueFollowUp: vi.fn((t) => { calls.push(`queueFollowUp:${t}`) }),
    resetComposerAfterSend: vi.fn(() => { calls.push('resetComposer') }),
    armAutoScrollForOutgoing: vi.fn(() => { calls.push('armAutoScroll') }),
    registerChatSendOwner: vi.fn((id, chatId, isHelp, p) => { calls.push(`registerOwner:${id}:${chatId}:${isHelp}:${p}`) }),
    registerPersistedAssistant: vi.fn((id, rowId) => { calls.push(`registerPersisted:${id}:${rowId}`) }),
    setCurrentSendId: vi.fn((id) => { calls.push(`setCurrentSendId:${id}`) }),
    setExhausted: vi.fn(() => { calls.push('setExhausted:null') }),
    setCrossVerify: vi.fn(() => { calls.push('setCrossVerify:null') }),
  }
  return { state, calls, deps, sentCalls, appended, loadersCalls, updatedMessages }
}

const baseInput: SendHelpMessageInput = {
  text: 'привет',
  modelText: 'привет',
  displayText: 'привет',
  attachments: [],
  providerLabel: 'Gemini',
}

describe('sendHelpMessage — characterization бывшей help-ветки send()', () => {
  it('helpChatId == null → no-chat, ничего не трогаем', async () => {
    const h = makeHarness({ helpChatId: null })
    const res = await sendHelpMessage(baseInput, h.deps)
    expect(res).toEqual({ kind: 'no-chat' })
    expect(h.calls).toEqual([])
  })

  it('активная lane + не fromQueue → follow-up в очередь, отправки нет', async () => {
    const h = makeHarness({ laneActive: true })
    const res = await sendHelpMessage(baseInput, h.deps)
    expect(res).toEqual({ kind: 'queued' })
    expect(h.calls).toEqual(['queueFollowUp:привет'])
  })

  it('fromQueue обходит lane-guard и отправляет', async () => {
    const h = makeHarness({ laneActive: true })
    const res = await sendHelpMessage({ ...baseInput, opts: { fromQueue: true } }, h.deps)
    expect(res).toEqual({ kind: 'sent', sendId: 7 })
    expect(h.calls).toContain('sendWithOverrides')
    expect(h.calls.some(c => c.startsWith('queueFollowUp'))).toBe(false)
  })

  it('happy path без скилла: порядок вызовов и контракт sendWithOverrides', async () => {
    const h = makeHarness()
    const res = await sendHelpMessage(baseInput, h.deps)
    expect(res).toEqual({ kind: 'sent', sendId: 7 })

    // Относительный порядок ключевых шагов (как в inline-ветке).
    const chain = [
      'clearHelpActivity', 'setExhausted:null', 'setCrossVerify:null', 'resetComposer',
      'armAutoScroll', 'addHelpMessage:user', 'append:user', 'append:assistant',
      'addHelpMessage:assistant', 'setHelpStreaming:true', 'sendWithOverrides',
      'setCurrentSendId:7', 'registerOwner:7:77:true:null', 'registerPersisted:7:42',
    ]
    const idx = chain.map(c => h.calls.indexOf(c))
    expect(idx.every(i => i >= 0)).toBe(true)
    expect(idx).toEqual([...idx].sort((a, b) => a - b))

    // Начальный прогресс — тот же что строила inline-ветка. Таймстампы не сравниваем:
    // buildInitialAgentProgress штампует Date.now() — под нагрузкой уходит на ±1мс.
    const stripTs = (entries: Array<Record<string, unknown>>) => entries.map(({ timestamp: _t, ...rest }) => rest)
    const firstProgress = (h.state.setHelpAgentProgress as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(stripTs(firstProgress)).toEqual(stripTs(buildInitialAgentProgress('привет', 'Gemini') as unknown as Array<Record<string, unknown>>))

    // Сообщение пользователя в UI — enrichedText (= text без скилла), в БД — summary.
    expect(h.state.help.messages[0]).toMatchObject({ role: 'user', content: 'привет', attachments: [] })
    expect(h.appended).toEqual([
      { role: 'user', content: 'привет' },
      { role: 'assistant', content: '' },
    ])

    // Модель получает историю БЕЗ только что добавленного assistant-плейсхолдера.
    expect(h.sentCalls).toHaveLength(1)
    expect(h.sentCalls[0].messages.map(m => m.role)).toEqual(['user'])
    expect(h.sentCalls[0].projectPath).toBeNull()
    expect(h.sentCalls[0].chatId).toBe('77')
    expect(h.sentCalls[0].overrides).toEqual({ noTools: true, agentMode: 'plan' })
  })

  it('attachments: summary с 📎 уходит в БД, UI-сообщение несёт attachments', async () => {
    const h = makeHarness()
    const attachments = [{ name: 'a.png', mimeType: 'image/png', data: 'x', size: 1 }]
    await sendHelpMessage({ ...baseInput, attachments }, h.deps)
    expect(h.appended[0]).toEqual({ role: 'user', content: 'привет\n\n📎 a.png' })
    expect(h.state.help.messages[0]).toMatchObject({ role: 'user', attachments })
  })

  it('opts.text задан (программная отправка) → composer не сбрасываем', async () => {
    const h = makeHarness()
    await sendHelpMessage({ ...baseInput, opts: { text: 'привет' } }, h.deps)
    expect(h.calls).not.toContain('resetComposer')
  })

  it('скилл с loaders: enrichedText, trigger chat_open (первое user-сообщение), полные overrides', async () => {
    const h = makeHarness({
      skills: [skillWithLoaders],
      activeSkillId: 's1',
      loadersResult: { context: 'CTX', labels: [] },
      provider: 'gemini',
      effort: 'deep',
    })
    const res = await sendHelpMessage({ ...baseInput, modelText: 'слово1 слово2' }, h.deps)
    expect(res).toEqual({ kind: 'sent', sendId: 7 })

    expect(h.loadersCalls).toEqual([{
      skillId: 's1',
      opts: { trigger: 'chat_open', projectPath: null, arg: 'слово1' },
    }])
    expect(h.state.help.messages[0].content).toBe('CTX\n\n---\n\nпривет')
    // В БД — оригинал без loader-контекста.
    expect(h.appended[0].content).toBe('привет')

    const o = h.sentCalls[0].overrides
    expect(o.noTools).toBe(true)
    expect(o.agentMode).toBe('plan')
    expect(o.systemPrompt).toContain('SYS')
    expect(o.systemPrompt).toContain('ВАЖНО (Verstak)')
    expect(o.providerId).toBe('openai') // другое семейство → override
    expect(o.model).toBe('gpt-x')
    expect(o.toolsAllow).toEqual(['read_file'])
    expect(o.recipe).toMatchObject({ id: 'r1' })
    expect(o.effortLevel).toBe('deep') // при скилле effort прокидывается всегда
  })

  it('loaders trigger=slash_arg, если user-сообщение уже было', async () => {
    const h = makeHarness({
      skills: [skillWithLoaders],
      activeSkillId: 's1',
      loadersResult: { context: 'CTX', labels: [] },
      messages: [{ role: 'user', content: 'было' }, { role: 'assistant', content: 'ответ' }],
    })
    await sendHelpMessage(baseInput, h.deps)
    expect(h.loadersCalls[0].opts.trigger).toBe('slash_arg')
  })

  it('loaders упали → warn + отправка с исходным текстом', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = makeHarness({
      skills: [skillWithLoaders],
      activeSkillId: 's1',
      loadersThrow: true,
    })
    const res = await sendHelpMessage(baseInput, h.deps)
    expect(res).toEqual({ kind: 'sent', sendId: 7 })
    expect(h.state.help.messages[0].content).toBe('привет')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('скилл без context_loaders → runLoaders не зовём', async () => {
    const noLoaders: Skill = { ...skillWithLoaders, context_loaders: undefined }
    const h = makeHarness({ skills: [noLoaders], activeSkillId: 's1', provider: 'openai' })
    await sendHelpMessage(baseInput, h.deps)
    expect(h.loadersCalls).toEqual([])
    // То же семейство → provider override НЕ ставим, model — ставим.
    expect(h.sentCalls[0].overrides.providerId).toBeUndefined()
    expect(h.sentCalls[0].overrides.model).toBe('gpt-x')
  })

  it('без скилла + effort≠standard → effortLevel в overrides; standard → без него', async () => {
    const deep = makeHarness({ effort: 'deep' })
    await sendHelpMessage(baseInput, deep.deps)
    expect(deep.sentCalls[0].overrides).toEqual({ noTools: true, agentMode: 'plan', effortLevel: 'deep' })

    const std = makeHarness({ effort: 'standard' })
    await sendHelpMessage(baseInput, std.deps)
    expect(std.sentCalls[0].overrides).not.toHaveProperty('effortLevel')
  })

  it('sendId <= 0 → error-ветка: текст в UI и БД, streaming снят, owner НЕ регистрируем', async () => {
    const h = makeHarness({ sendId: 0 })
    const res = await sendHelpMessage(baseInput, h.deps)
    expect(res).toEqual({ kind: 'send-failed' })
    expect(h.state.updateHelpLastAssistant).toHaveBeenCalledWith('\n\n[Ошибка: провайдер недоступен]')
    expect(h.updatedMessages).toEqual([{ id: ASSISTANT_ROW_ID, content: '\n\n[Ошибка: провайдер недоступен]' }])
    expect(h.state.applyEventToHelp).toHaveBeenCalledWith({ type: 'error', message: 'Провайдер недоступен' })
    expect(h.calls).toContain('setHelpStreaming:false')
    expect(h.calls).toContain('setCurrentSendId:0')
    expect(h.calls).toContain('setCurrentSendId:null')
    expect(h.calls.some(c => c.startsWith('registerOwner'))).toBe(false)
    expect(h.calls.some(c => c.startsWith('registerPersisted'))).toBe(false)
  })
})
