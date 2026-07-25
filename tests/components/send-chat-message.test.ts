// Characterization-харнес основного пути send() (фаза 5, срез 2): поведение
// зафиксировано ПРИ выносе из Chat.tsx в src/components/chat/send-chat-message.ts.
// Падение любого сценария = расхождение с бывшим inline-кодом (~2837-3058 до выноса).
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, Skill } from '../../src/types/api'
import type { PromptRouteOverride } from '../../shared/contracts/provider'
import type { AgentMode } from '../../src/components/ModePicker'
import {
  sendChatMessage,
  type ChatSendProjectState,
  type ChatSendOverrides,
  type PipelineOutcomeRef,
  type SendChatMessageDeps,
  type SendChatMessageInput,
} from '../../src/components/chat/send-chat-message'

const CTX = { path: '/p', activeChatId: 5 }
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
  ctx?: { path: string; activeChatId: number } | null
  laneActive?: boolean
  effort?: 'quick' | 'standard' | 'deep'
  messages?: ChatMessage[]
  skills?: Skill[]
  activeSkillId?: string | null
  sendId?: number
  loadersResult?: { context: string; labels: string[] }
  loadersThrow?: boolean
  provider?: string | null
  mentionsBlock?: string
  agentMode?: AgentMode
  promptRouteOverride?: PromptRouteOverride | null
  earlyRouteStop?: { chatId: number; message: string; at: number } | null
  resumeFromRunId?: string | null
  pipelineOutcome?: PipelineOutcomeRef | null
  pipelineAutoSendStep?: 'refine' | 'plan' | 'execute' | null
} = {}) {
  const calls: string[] = []
  const state: ChatSendProjectState = {
    messages: [...(opts.messages ?? [])],
    agentProgress: [],
    effortLevel: opts.effort ?? 'standard',
    promptRouteOverride: opts.promptRouteOverride ?? null,
    earlyRouteStop: opts.earlyRouteStop ?? null,
    hasActiveChatLane: vi.fn(() => opts.laneActive ?? false),
    clearActivity: vi.fn(() => { calls.push('clearActivity') }),
    setAgentProgress: vi.fn(() => { calls.push('setAgentProgress') }),
    addMessage: vi.fn((m) => { calls.push(`addMessage:${m.role}`); state.messages.push(m) }),
    setStreaming: vi.fn((v) => { calls.push(`setStreaming:${v}`) }),
    updateLastAssistant: vi.fn(() => { calls.push('updateLastAssistant') }),
    autoTitleChatSession: vi.fn(async (chatId, text) => { calls.push(`autoTitle:${chatId}:${text}`) }),
    setPromptRouteOverride: vi.fn((r) => { calls.push(`setPromptRouteOverride:${r}`); state.promptRouteOverride = r }),
    setEarlyRouteStop: vi.fn((s) => { calls.push(`setEarlyRouteStop:${s}`); state.earlyRouteStop = s }),
    applyAgentProgressEvent: vi.fn((e) => { calls.push(`applyAgentProgressEvent:${e.type}:${e.message}`) }),
  }
  const sentCalls: Array<{ messages: ChatMessage[]; projectPath: string | null; overrides: ChatSendOverrides; chatId?: string }> = []
  const appended: Array<{ role: string; content: string; meta?: unknown }> = []
  const loadersCalls: Array<{ skillId: string; opts: { arg?: string; projectPath?: string | null; trigger: string } }> = []
  const mentionsCalls: Array<{ projectPath: string; paths: string[] }> = []
  const updatedMessages: Array<{ id: number; content: string }> = []
  let resumeFromRunId = opts.resumeFromRunId ?? null
  let pipelineOutcome = opts.pipelineOutcome ?? null
  const deps: SendChatMessageDeps = {
    getProjectState: () => state,
    getSkillsState: () => ({ skills: opts.skills ?? [] }),
    api: {
      runLoaders: vi.fn(async (skillId, o) => {
        calls.push('runLoaders')
        loadersCalls.push({ skillId, opts: o })
        if (opts.loadersThrow) throw new Error('boom')
        return opts.loadersResult ?? { context: '', labels: [] }
      }),
      resolveMentions: vi.fn(async (projectPath, paths) => {
        calls.push('resolveMentions')
        mentionsCalls.push({ projectPath, paths })
        return opts.mentionsBlock ?? ''
      }),
      chatsAppend: vi.fn(async (_chatId, _path, role, content, meta) => {
        calls.push(`append:${role}`)
        appended.push({ role, content, meta })
        return { id: role === 'assistant' ? ASSISTANT_ROW_ID : 1 }
      }),
      chatsUpdateMessage: vi.fn(async (id, content) => { calls.push('updateMessage'); updatedMessages.push({ id, content }) }),
      getSetting: vi.fn(async () => { calls.push('getSetting'); return opts.provider ?? null }),
      sendWithOverrides: vi.fn(async (messages, projectPath, overrides, chatId) => {
        calls.push('sendWithOverrides')
        sentCalls.push({ messages, projectPath, overrides, chatId })
        return opts.sendId ?? 7
      }),
    },
    ensureProjectForChat: vi.fn(async () => {
      calls.push('ensureProjectForChat')
      return opts.ctx === undefined ? CTX : opts.ctx
    }),
    flashWarning: vi.fn((m) => { calls.push(`flashWarning:${m.slice(0, 20)}`) }),
    queueFollowUp: vi.fn((t) => { calls.push(`queueFollowUp:${t}`) }),
    resetComposerAfterSend: vi.fn(() => { calls.push('resetComposer') }),
    armAutoScrollForOutgoing: vi.fn(() => { calls.push('armAutoScroll') }),
    readAgentMode: vi.fn(async () => { calls.push('readAgentMode'); return opts.agentMode ?? 'auto' }),
    registerChatSendOwner: vi.fn((id, chatId, isHelp, p) => { calls.push(`registerOwner:${id}:${chatId}:${isHelp}:${p}`) }),
    registerPersistedAssistant: vi.fn((id, rowId) => { calls.push(`registerPersisted:${id}:${rowId}`) }),
    setCurrentSendId: vi.fn((id) => { calls.push(`setCurrentSendId:${id}`) }),
    setExhausted: vi.fn(() => { calls.push('setExhausted:null') }),
    setCrossVerify: vi.fn(() => { calls.push('setCrossVerify:null') }),
    consumeResumeFromRunId: vi.fn(() => { const v = resumeFromRunId; resumeFromRunId = null; return v }),
    consumePipelineOutcome: vi.fn(() => { const v = pipelineOutcome; pipelineOutcome = null; return v }),
    getPipelineAutoSendStep: vi.fn(() => opts.pipelineAutoSendStep ?? null),
    setPipelineExecuteSendId: vi.fn((id) => { calls.push(`setPipelineExecuteSendId:${id}`) }),
  }
  return { state, calls, deps, sentCalls, appended, loadersCalls, mentionsCalls, updatedMessages }
}

const baseInput: SendChatMessageInput = {
  text: 'привет',
  modelText: 'привет',
  displayText: 'привет',
  attachments: [],
  providerLabel: 'Gemini',
  messageAppliedSkills: [],
  messageAppliedSkillDetails: [],
  skillCatalog: [],
  activeSkillIdForSend: null,
  autoBoundSkillDetails: [],
}

describe('sendChatMessage — characterization бывшего основного пути send()', () => {
  it('нет проекта → flashWarning + no-project, дальше ничего', async () => {
    const h = makeHarness({ ctx: null })
    const res = await sendChatMessage(baseInput, h.deps)
    expect(res).toEqual({ kind: 'no-project' })
    expect(h.calls).toEqual(['ensureProjectForChat', 'flashWarning:Сначала открой папку'])
  })

  it('активная lane + не fromQueue → follow-up в очередь', async () => {
    const h = makeHarness({ laneActive: true })
    const res = await sendChatMessage(baseInput, h.deps)
    expect(res).toEqual({ kind: 'queued' })
    expect(h.calls).toEqual(['ensureProjectForChat', 'queueFollowUp:привет'])
  })

  it('happy path без скилла: порядок, БД-записи, autoTitle первого сообщения, контракт send', async () => {
    const h = makeHarness()
    const res = await sendChatMessage(baseInput, h.deps)
    expect(res).toEqual({ kind: 'sent', sendId: 7 })

    const chain = [
      'clearActivity', 'setExhausted:null', 'setCrossVerify:null', 'resetComposer',
      'armAutoScroll', 'addMessage:user', 'append:user', 'append:assistant',
      'addMessage:assistant', 'setStreaming:true', 'sendWithOverrides',
      'setCurrentSendId:7', 'registerOwner:7:5:false:/p', 'registerPersisted:7:42',
    ]
    const idx = chain.map(c => h.calls.indexOf(c))
    expect(idx.every(i => i >= 0)).toBe(true)
    expect(idx).toEqual([...idx].sort((a, b) => a - b))

    // autoTitle только для первого user-сообщения чата.
    expect(h.calls).toContain('autoTitle:5:привет')

    // UI получает enrichedText (= modelText без скиллов), БД — summary.
    expect(h.state.messages[0]).toMatchObject({ role: 'user', content: 'привет', attachments: [] })
    expect(h.appended).toEqual([
      { role: 'user', content: 'привет', meta: undefined },
      { role: 'assistant', content: '', meta: undefined },
    ])

    // Модель получает историю без assistant-плейсхолдера; chatId строкой (страж 2.0.11-B).
    expect(h.sentCalls).toHaveLength(1)
    expect(h.sentCalls[0].messages.map(m => m.role)).toEqual(['user'])
    expect(h.sentCalls[0].projectPath).toBe('/p')
    expect(h.sentCalls[0].chatId).toBe('5')
    expect(h.sentCalls[0].overrides).toEqual({ agentMode: 'auto' })
  })

  it('не первое user-сообщение → autoTitle НЕ зовём', async () => {
    const h = makeHarness({ messages: [{ role: 'user', content: 'было' }, { role: 'assistant', content: 'ответ' }] })
    await sendChatMessage(baseInput, h.deps)
    expect(h.calls.some(c => c.startsWith('autoTitle'))).toBe(false)
  })

  it('opts.text без modelText → composer НЕ сбрасываем; с modelText → сбрасываем', async () => {
    const programmatic = makeHarness()
    await sendChatMessage({ ...baseInput, opts: { text: 'привет' } }, programmatic.deps)
    expect(programmatic.calls).not.toContain('resetComposer')

    const withModel = makeHarness()
    await sendChatMessage({ ...baseInput, opts: { text: 'привет', modelText: 'MODEL' } }, withModel.deps)
    expect(withModel.calls).toContain('resetComposer')
  })

  it('attachments: summary с 📎 в БД, attachments в UI-сообщении', async () => {
    const h = makeHarness()
    const attachments = [{ name: 'a.png', mimeType: 'image/png', data: 'x', size: 1 }]
    await sendChatMessage({ ...baseInput, attachments }, h.deps)
    expect(h.appended[0].content).toBe('привет\n\n📎 a.png')
    expect(h.state.messages[0]).toMatchObject({ role: 'user', attachments })
  })

  it('loaders активного скилла: enrichedText в UI, оригинал в БД, trigger chat_open', async () => {
    const h = makeHarness({
      skills: [skillWithLoaders],
      loadersResult: { context: 'CTX', labels: [] },
    })
    await sendChatMessage({ ...baseInput, activeSkillIdForSend: 's1', skillCatalog: [skillWithLoaders] }, h.deps)
    expect(h.loadersCalls).toEqual([{ skillId: 's1', opts: { trigger: 'chat_open', projectPath: '/p', arg: 'привет' } }])
    expect(h.state.messages[0].content).toBe('CTX\n\n---\n\nпривет')
    expect(h.appended[0].content).toBe('привет')
  })

  it('loaders trigger=slash_arg, если user-сообщение уже было', async () => {
    const h = makeHarness({
      skills: [skillWithLoaders],
      loadersResult: { context: 'CTX', labels: [] },
      messages: [{ role: 'user', content: 'было' }],
    })
    await sendChatMessage({ ...baseInput, activeSkillIdForSend: 's1', skillCatalog: [skillWithLoaders] }, h.deps)
    expect(h.loadersCalls[0].opts.trigger).toBe('slash_arg')
  })

  it('loaders упали → warn + отправка с исходным modelText', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = makeHarness({ skills: [skillWithLoaders], loadersThrow: true })
    const res = await sendChatMessage({ ...baseInput, activeSkillIdForSend: 's1', skillCatalog: [skillWithLoaders] }, h.deps)
    expect(res).toEqual({ kind: 'sent', sendId: 7 })
    expect(h.state.messages[0].content).toBe('привет')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('@-mentions: resolveMentions, блок префиксом к enrichedText', async () => {
    const h = makeHarness({ mentionsBlock: 'FILE-BLOCK' })
    await sendChatMessage({ ...baseInput, text: 'прочитай @src/a.ts пожалуйста', modelText: 'прочитай @src/a.ts пожалуйста' }, h.deps)
    expect(h.mentionsCalls).toEqual([{ projectPath: '/p', paths: ['src/a.ts'] }])
    expect(h.state.messages[0].content).toBe('FILE-BLOCK\n\n---\n\nпрочитай @src/a.ts пожалуйста')
    // В БД — оригинал текста с @-меткой.
    expect(h.appended[0].content).toBe('прочитай @src/a.ts пожалуйста')
  })

  it('internalResume: user не дублируется, БД user не пишется, хвост assistant подрезается', async () => {
    const h = makeHarness({
      messages: [
        { role: 'user', content: 'старое' },
        { role: 'assistant', content: 'ответ' },
        { role: 'assistant', content: 'висюк' },
      ],
    })
    const res = await sendChatMessage({ ...baseInput, opts: { internalResume: true } }, h.deps)
    expect(res).toEqual({ kind: 'sent', sendId: 7 })
    // Ни user addMessage, ни user append в БД (только assistant-строка).
    expect(h.calls.filter(c => c === 'addMessage:user')).toEqual([])
    expect(h.appended).toEqual([{ role: 'assistant', content: '', meta: undefined }])
    // Модель: хвостовые assistant выкинуты, добавлен свежий user с enrichedText.
    const sent = h.sentCalls[0].messages
    expect(sent.map(m => m.role)).toEqual(['user', 'user'])
    expect(sent[1].content).toBe('привет')
  })

  it('opts.modelText: в UI displayText, модели — enrichedText вместо последнего user', async () => {
    const h = makeHarness({ messages: [{ role: 'user', content: 'старое' }] })
    await sendChatMessage({
      ...baseInput,
      text: '/dossier x',
      modelText: 'MODEL',
      displayText: 'SHOW',
      opts: { text: '/dossier x', modelText: 'MODEL' },
    }, h.deps)
    expect(h.state.messages[1]).toMatchObject({ role: 'user', content: 'SHOW' })
    const sent = h.sentCalls[0].messages
    expect(sent.map(m => m.content)).toEqual(['старое', 'MODEL'])
  })

  it('skill override: systemPrompt + provider/model + toolsAllow + recipe + effort всегда', async () => {
    const h = makeHarness({ skills: [skillWithLoaders], provider: 'gemini', effort: 'deep' })
    await sendChatMessage({ ...baseInput, activeSkillIdForSend: 's1', skillCatalog: [skillWithLoaders] }, h.deps)
    const o = h.sentCalls[0].overrides
    expect(o.systemPrompt).toContain('SYS')
    expect(o.systemPrompt).toContain('ВАЖНО (Verstak)')
    expect(o.providerId).toBe('openai')
    expect(o.model).toBe('gpt-x')
    expect(o.toolsAllow).toEqual(['read_file'])
    expect(o.recipe).toMatchObject({ id: 'r1' })
    expect(o.effortLevel).toBe('deep') // в skill-ветке effort прокидывается всегда
    expect(o.agentMode).toBe('auto')
    expect(h.calls).toContain('getSetting')
  })

  it('resumeFromRunId без скилла: отдельная ветка overrides, ref потреблён однократно', async () => {
    const h = makeHarness({ resumeFromRunId: 'run-1', effort: 'quick' })
    await sendChatMessage(baseInput, h.deps)
    expect(h.sentCalls[0].overrides).toEqual({ resumeFromRunId: 'run-1', agentMode: 'auto', effortLevel: 'quick' })
    expect(h.deps.consumeResumeFromRunId).toHaveBeenCalledTimes(1)
  })

  it('one-shot route: promptRoute в overrides любой ветки + снятие после отправки', async () => {
    const route: PromptRouteOverride = { providerId: 'gemini-api', model: 'm1', fallbackPolicy: 'strict' }
    const h = makeHarness({ promptRouteOverride: route })
    await sendChatMessage(baseInput, h.deps)
    expect(h.sentCalls[0].overrides.promptRoute).toEqual(route)
    expect(h.state.setPromptRouteOverride).toHaveBeenCalledWith(null)
    expect(h.state.promptRouteOverride).toBeNull()
  })

  it('pipeline outcome в overrides + execute-step запоминает sendId', async () => {
    const outcome: PipelineOutcomeRef = { pipelineId: 9, phase: 'execute-step' }
    const h = makeHarness({ pipelineOutcome: outcome, pipelineAutoSendStep: 'execute' })
    await sendChatMessage(baseInput, h.deps)
    expect(h.sentCalls[0].overrides.outcome).toEqual(outcome)
    expect(h.calls).toContain('setPipelineExecuteSendId:7')
  })

  it('sendId<=0 + совпавший earlyRouteStop → ТОЧНАЯ причина + стоп консьюмится', async () => {
    const h = makeHarness({
      sendId: 0,
      earlyRouteStop: { chatId: 5, message: 'аккаунт удалён', at: Date.now() },
    })
    const res = await sendChatMessage(baseInput, h.deps)
    expect(res).toEqual({ kind: 'send-failed' })
    expect(h.state.updateLastAssistant).toHaveBeenCalledWith('\n\n[Ошибка: аккаунт удалён]')
    expect(h.updatedMessages).toEqual([{ id: ASSISTANT_ROW_ID, content: '\n\n[Ошибка: аккаунт удалён]' }])
    expect(h.calls).toContain('applyAgentProgressEvent:error:аккаунт удалён')
    expect(h.calls).toContain('setEarlyRouteStop:null')
    expect(h.state.earlyRouteStop).toBeNull()
    expect(h.calls).toContain('setStreaming:false')
    expect(h.calls).toContain('setCurrentSendId:null')
    expect(h.calls.some(c => c.startsWith('registerOwner'))).toBe(false)
  })

  it('sendId<=0 без earlyRouteStop → общий текст; чужой chatId не подменяет причину', async () => {
    const h = makeHarness({
      sendId: 0,
      earlyRouteStop: { chatId: 999, message: 'чужой стоп', at: Date.now() },
    })
    const res = await sendChatMessage(baseInput, h.deps)
    expect(res).toEqual({ kind: 'send-failed' })
    expect(h.state.updateLastAssistant).toHaveBeenCalledWith('\n\n[Ошибка: провайдер недоступен]')
    expect(h.calls).not.toContain('setEarlyRouteStop:null')
    expect(h.state.earlyRouteStop).not.toBeNull()
  })

  it('применённые скиллы: skills-bound отметка в прогрессе + appliedSkills в UI/БД', async () => {
    const applied = [{ id: 's1' }]
    const h = makeHarness({ skills: [skillWithLoaders] })
    await sendChatMessage({
      ...baseInput,
      messageAppliedSkills: applied,
      messageAppliedSkillDetails: [skillWithLoaders],
      skillCatalog: [skillWithLoaders],
    }, h.deps)
    // Прогресс: после initial — запись skills-bound со статусом done.
    const progressCalls = (h.state.setAgentProgress as ReturnType<typeof vi.fn>).mock.calls
    const hasSkillsBound = progressCalls.some(call =>
      Array.isArray(call[0]) && call[0].some((e: { id?: string; status?: string }) => e.id === 'skills-bound' && e.status === 'done')
    )
    expect(hasSkillsBound).toBe(true)
    // appliedSkills уезжают и в UI-сообщение, и в БД-мету.
    expect(h.state.messages[0].appliedSkills).toEqual(applied)
    expect(h.appended[0].meta).toEqual({ appliedSkills: applied })
    // systemPrompt собран из применённого скилла → skill-ветка overrides.
    expect(h.sentCalls[0].overrides.systemPrompt).toContain('SYS')
  })
})
