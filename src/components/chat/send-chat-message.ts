// Вынос основного пути send() из Chat.tsx (фаза 5, срез 2): отправка сообщения
// в обычном (проектном) чате. React-free: компонент передаёт геттеры состояния,
// api-обёртки и коллбэки, здесь — только оркестрация. Поведение 1-в-1 с бывшим
// inline-кодом (Chat.tsx ~2837-3058 до выноса), включая тонкости:
// - isFirstUserMessage для autoTitle читается из СНАПШОТА store (взят в начале),
//   trigger loaders — из СВЕЖЕГО состояния;
// - resumeFromRunId / pipelineOutcome потребляются однократно (ref read+clear);
// - sendId<=0 ждёт 30мс тик, чтобы IPC-событие раннего маршрутного стопа успело
//   дойти, и показывает ТОЧНУЮ причину (2.1.3-CD).
import type { AppliedSkillRef, Attachment, ChatMessage, PromptRouteOverride, Skill } from '../../types/api'
import type { AgentProgressEntry } from '../../lib/agent-progress'
import { activateModelProgress, buildInitialAgentProgress, reduceAgentProgress } from '../../lib/agent-progress'
import { extractMentions } from '../../lib/mentions'
import { resolveSkillOverride } from '../../lib/skill-override'
import type { AgentMode } from '../ModePicker'
import {
  buildSkillBindingProgressDetail,
  composeSkillSystemPrompt,
  firstRecipe,
  mergeToolAllow,
  uniqueSkills,
  withAppliedSkillContextForModel,
} from './skill-prompts'

/** Подмножество ProjectState, которое читает/мутирует основная отправка. */
export interface ChatSendProjectState {
  messages: ChatMessage[]
  agentProgress: AgentProgressEntry[]
  effortLevel: 'quick' | 'standard' | 'deep'
  promptRouteOverride: PromptRouteOverride | null
  earlyRouteStop: { chatId: number; message: string; at: number } | null
  hasActiveChatLane: (chatId: number, isHelp?: boolean) => boolean
  clearActivity: () => void
  setAgentProgress: (entries: AgentProgressEntry[]) => void
  addMessage: (msg: ChatMessage) => void
  setStreaming: (v: boolean) => void
  updateLastAssistant: (text: string) => void
  autoTitleChatSession: (chatId: number, firstUserText: string) => Promise<void>
  setPromptRouteOverride: (route: PromptRouteOverride | null) => void
  setEarlyRouteStop: (stop: { chatId: number; message: string; at: number } | null) => void
  applyAgentProgressEvent: (event: { type: string; [k: string]: unknown }) => void
}

export type ChatSendOverrides = Parameters<Window['api']['ai']['sendWithOverrides']>[2]

/** window.api-вызовы, нужные основной отправке (мокаются в тестах). */
export interface ChatSendApi {
  runLoaders: (skillId: string, opts: { arg?: string; projectPath?: string | null; trigger: 'chat_open' | 'slash_arg' }) => Promise<{ context: string; labels: string[] }>
  resolveMentions: (projectPath: string, paths: string[]) => Promise<string>
  chatsAppend: (chatId: number, projectPath: string, role: 'user' | 'assistant', content: string, meta?: { appliedSkills?: AppliedSkillRef[] }) => Promise<{ id: number }>
  chatsUpdateMessage: (messageId: number, content: string) => Promise<unknown>
  getSetting: (key: string) => Promise<string | null>
  sendWithOverrides: (messages: ChatMessage[], projectPath: string | null, overrides: ChatSendOverrides, chatId?: string) => Promise<number>
}

export interface PipelineOutcomeRef {
  pipelineId: number
  phase: 'refine' | 'plan' | 'execute-step'
}

export interface SendChatMessageDeps {
  /** Снапшот в начале + свежие чтения после await'ов (как useProject.getState()). */
  getProjectState: () => ChatSendProjectState
  getSkillsState: () => { skills: Skill[] }
  api: ChatSendApi
  ensureProjectForChat: () => Promise<{ path: string; activeChatId: number } | null>
  flashWarning: (msg: string) => void
  queueFollowUp: (text: string) => void
  resetComposerAfterSend: () => void
  armAutoScrollForOutgoing: () => void
  readAgentMode: (chatId: number | null, helpMode: boolean) => Promise<AgentMode>
  registerChatSendOwner: (sendId: number, chatId: number, isHelp: boolean, projectPath?: string | null) => void
  registerPersistedAssistant: (sendId: number, messageId: number) => void
  setCurrentSendId: (sendId: number | null) => void
  setExhausted: (v: null) => void
  setCrossVerify: (v: null) => void
  /** Crash-resume Фаза 2: читает ref и обнуляет (однократное потребление). */
  consumeResumeFromRunId: () => string | null
  /** Pipeline outcome на одну отправку: читает ref и обнуляет. */
  consumePipelineOutcome: () => PipelineOutcomeRef | null
  getPipelineAutoSendStep: () => 'refine' | 'plan' | 'execute' | null
  setPipelineExecuteSendId: (sendId: number) => void
}

export interface SendChatMessageInput {
  text: string
  modelText: string
  displayText: string
  attachments: Attachment[]
  providerLabel: string
  opts?: { text?: string; modelText?: string; internalResume?: boolean; fromQueue?: boolean }
  messageAppliedSkills: AppliedSkillRef[]
  messageAppliedSkillDetails: Skill[]
  skillCatalog: Skill[]
  activeSkillIdForSend: string | null
  autoBoundSkillDetails: Skill[]
}

export type ChatSendResult =
  | { kind: 'no-project' }
  | { kind: 'queued' }
  | { kind: 'sent'; sendId: number }
  | { kind: 'send-failed' }

export async function sendChatMessage(input: SendChatMessageInput, deps: SendChatMessageDeps): Promise<ChatSendResult> {
  const { text, modelText, displayText, attachments, providerLabel, opts } = input
  const { messageAppliedSkills, messageAppliedSkillDetails, skillCatalog, activeSkillIdForSend, autoBoundSkillDetails } = input
  const { api } = deps
  const store = deps.getProjectState()
  const ctx = await deps.ensureProjectForChat()
  if (!ctx) {
    deps.flashWarning('Сначала открой папку проекта слева — без неё переписка не сохраняется.')
    return { kind: 'no-project' }
  }
  const path = ctx.path
  const userAttachments = attachments
  if (!opts?.fromQueue && ctx.activeChatId != null && store.hasActiveChatLane(ctx.activeChatId, false)) {
    deps.queueFollowUp(text)
    return { kind: 'queued' }
  }
  store.clearActivity()
  store.setAgentProgress(buildInitialAgentProgress(displayText || text || 'Новый запрос', providerLabel))
  const skillBindingProgressDetail = buildSkillBindingProgressDetail(messageAppliedSkillDetails, autoBoundSkillDetails)
  if (skillBindingProgressDetail) {
    store.setAgentProgress(reduceAgentProgress(deps.getProjectState().agentProgress, {
      type: 'agent-progress',
      id: 'skills-bound',
      phase: 'context',
      title: 'Подключаю скиллы',
      detail: skillBindingProgressDetail,
      status: 'done'
    }))
  }
  deps.setExhausted(null)  // new send wipes any pending continue state
  deps.setCrossVerify(null)  // сбрасываем предыдущий результат cross-verify
  if (!opts?.text || opts?.modelText) {
    deps.resetComposerAfterSend()
  }
  const summary = userAttachments.length > 0
    ? `${text}${text ? '\n\n' : ''}📎 ${userAttachments.map(a => a.name).join(', ')}`
    : text
  // Context loaders: если активен скилл с frontmatter context_loaders —
  // запускаем их и подмешиваем результат в content user-message ПЕРЕД
  // отправкой. Это делает скиллы реально мощными — скилл может подгрузить
  // нужные данные (карточку, отчёт, контекст) автоматически.
  let enrichedText = modelText
  const activeSkillForLoad = activeSkillIdForSend
    ? deps.getSkillsState().skills.find(s => s.id === activeSkillIdForSend)
    : null
  const loaderSkill = uniqueSkills([activeSkillForLoad, ...messageAppliedSkillDetails, ...autoBoundSkillDetails])
    .find(skill => skill.context_loaders?.length)
  if (loaderSkill?.context_loaders?.length) {
    const isFirstUserMsg = !deps.getProjectState().messages.some(m => m.role === 'user')
    const trigger: 'chat_open' | 'slash_arg' = isFirstUserMsg ? 'chat_open' : 'slash_arg'
    try {
      const loaded = await api.runLoaders(loaderSkill.id, {
        trigger,
        projectPath: path,
        arg: text.split(/\s+/)[0]  // первое слово как arg (для /dossier alfa-development)
      })
      if (loaded.context) {
        enrichedText = `${loaded.context}\n\n---\n\n${modelText}`
      }
    } catch (err) {
      console.warn('[chat] skill loaders failed:', loaderSkill.id, err)
    }
  }
  // F6: @-mentions — пользователь явно подмешал файлы (@path). Читаем их (бэкенд:
  // path-policy + redaction) и префиксим к контексту агента. БД хранит оригинал.
  try {
    const mentions = extractMentions(text)
    if (mentions.length && path) {
      const block = await api.resolveMentions(path, mentions)
      if (block) enrichedText = `${block}\n\n---\n\n${enrichedText}`
    }
  } catch (err) {
    console.warn('[chat] @-mentions resolve failed:', err)
  }
  const isFirstUserMessage = !store.messages.some(m => m.role === 'user')
  deps.armAutoScrollForOutgoing()
  if (!opts?.internalResume) {
    store.addMessage({
      role: 'user',
      content: opts?.modelText ? displayText : enrichedText,
      attachments: userAttachments,
      ...(messageAppliedSkills.length ? { appliedSkills: messageAppliedSkills } : {})
    })
  }
  const activeChatId = ctx.activeChatId
  if (path && activeChatId && !opts?.internalResume) {
    // В БД сохраняем оригинальный text пользователя (без loader-контекста),
    // чтобы при reload UI не показывал жирный системный блок.
    await api.chatsAppend(
      activeChatId,
      path,
      'user',
      summary,
      messageAppliedSkills.length ? { appliedSkills: messageAppliedSkills } : undefined
    )
    if (isFirstUserMessage) {
      void store.autoTitleChatSession(activeChatId, text || summary)
    }
  }
  const assistantRow = path && activeChatId
    ? await api.chatsAppend(activeChatId, path, 'assistant', '')
    : null
  store.addMessage({ role: 'assistant', content: '', ...(assistantRow ? { dbId: assistantRow.id } : {}) })
  store.setStreaming(true)
  store.setAgentProgress(activateModelProgress(deps.getProjectState().agentProgress, providerLabel))
  const allMessages = [...deps.getProjectState().messages].slice(0, -1)
  if (opts?.internalResume) {
    while (allMessages.length > 0 && allMessages[allMessages.length - 1].role === 'assistant') {
      allMessages.pop()
    }
    allMessages.push({ role: 'user', content: enrichedText })
  } else if (opts?.modelText) {
    const lastUserIndex = allMessages.map(m => m.role).lastIndexOf('user')
    if (lastUserIndex >= 0) {
      allMessages[lastUserIndex] = { ...allMessages[lastUserIndex], content: enrichedText }
    }
  }
  const modelMessages = withAppliedSkillContextForModel(allMessages, skillCatalog, autoBoundSkillDetails)
  const sendAgentMode = await deps.readAgentMode(activeChatId, false)
  // Skill override: если активен скилл — system prompt берётся из его тела.
  // Provider/model берутся из скилла ТОЛЬКО если активный выбор пользователя
  // несовместим с тем что предлагает скилл. Например: скилл говорит 'claude'
  // (API), пользователь выбрал 'claude-cli' (CLI/подписка) — оба = Claude,
  // НЕ переключаем. Это сохраняет выбор пользователя по подписке/API.
  const activeSkill = activeSkillIdForSend
    ? deps.getSkillsState().skills.find(s => s.id === activeSkillIdForSend)
    : null
  const skillSystemPrompt = composeSkillSystemPrompt(activeSkill ?? null, messageAppliedSkillDetails, modelText, autoBoundSkillDetails)
  const toolsAllow = mergeToolAllow([activeSkill, ...messageAppliedSkillDetails, ...autoBoundSkillDetails])
  const recipe = firstRecipe([activeSkill, ...messageAppliedSkillDetails, ...autoBoundSkillDetails])
  let sendId: number
  // Crash-resume Фаза 2: re-send прерванного прогона → прокидываем runId, чтобы
  // ai:send продолжил с накопленным контекстом из чекпойнта. Консьюмим ref однократно.
  const resumeFromRunId = deps.consumeResumeFromRunId()
  // 2.0.7-F: маршрут модели на ОДИН prompt. Берём из store, наслаиваем на overrides всех
  // веток (побеждает дефолт чата и skill-override — самый явный выбор пользователя), и
  // СРАЗУ снимаем после отправки (one-shot). requested пишется в agent_run (main).
  const oneShotRoute = deps.getProjectState().promptRouteOverride
  const routeOverride = oneShotRoute ? { promptRoute: oneShotRoute } : {}
  const pipelineOutcome = deps.consumePipelineOutcome()
  const outcomeOverride = pipelineOutcome ? { outcome: pipelineOutcome } : {}
  // Хвост ревью 2.0.11-B: chatId ОБЯЗАН доехать до ai:send. От него в main зависят три
  // вещи разом: компакция контекста (2.0.11-B), закреплённый за чатом аккаунт (2.0.8-D2)
  // и изоляция worktree. Фоновые пути его передавали, главный — забывал, и все три
  // молча не работали в основном чате. Страж: tests/contracts/chat-send-chatid-contract.
  const sendChatId = activeChatId != null ? String(activeChatId) : undefined
  if (activeSkill || skillSystemPrompt) {
    // Узнаём текущий provider пользователя — чтобы решить override или нет
    const currentProvider = activeSkill ? await api.getSetting('provider') : null
    // Provider/model override скилла (B5). Провайдер — только при разном
    // семействе (сохраняем выбор API/CLI). Модель — и при том же семействе.
    const { providerId: overrideProvider, model: overrideModel } = activeSkill
      ? resolveSkillOverride(activeSkill, currentProvider)
      : { providerId: undefined, model: undefined }
    // Anti-stall guard: некоторые скиллы — оркестраторы/штабы (los-hq, bos-hq,
    // навигаторы) с протоколом «жди пакет задачи / маршрутизируй / ✋ СТОП».
    // Базовый system-layer теперь НАСЛАИВАЕТСЯ под скилл (ipc/ai.ts передаёт
    // skillPrompt в prepareSystemContext — см. <skill_layer>), так что протокол
    // выполнения восстановлен. Но тело таких скиллов всё равно может сильно
    // давить «жди ТЗ»; nudge — дешёвое подкрепление: ясный запрос = действуй.
    sendId = await api.sendWithOverrides(modelMessages, path, {
      ...(skillSystemPrompt ? { systemPrompt: skillSystemPrompt } : {}),
      ...(overrideProvider ? { providerId: overrideProvider } : {}),
      ...(overrideModel ? { model: overrideModel } : {}),
      // Аудит M4: tools_allow скилла → agent-loop ограничивает инструменты модели.
      ...(toolsAllow?.length ? { toolsAllow } : {}),
      // Этап 4: recipe скилла → main наслаивает workflow-протокол на skill-промпт.
      ...(recipe ? { recipe } : {}),
      effortLevel: deps.getProjectState().effortLevel,
      agentMode: sendAgentMode,
      ...(resumeFromRunId ? { resumeFromRunId } : {}),
      ...outcomeOverride,
      ...routeOverride
    }, sendChatId)
  } else if (resumeFromRunId) {
    // Возобновление вне скилла: всё равно прокидываем resumeFromRunId (+ effort).
    const effort = deps.getProjectState().effortLevel
    sendId = await api.sendWithOverrides(modelMessages, path, {
      resumeFromRunId,
      agentMode: sendAgentMode,
      ...(effort !== 'standard' ? { effortLevel: effort } : {}),
      ...outcomeOverride,
      ...routeOverride
    }, sendChatId)
  } else {
    const effort = deps.getProjectState().effortLevel
    sendId = await api.sendWithOverrides(modelMessages, path, {
      ...(effort !== 'standard' ? { effortLevel: effort } : {}),
      agentMode: sendAgentMode,
      ...outcomeOverride,
      ...routeOverride
    }, sendChatId)
  }
  // one-shot: маршрут действовал только на эту отправку — снимаем.
  if (oneShotRoute) deps.getProjectState().setPromptRouteOverride(null)
  deps.setCurrentSendId(sendId)
  if (sendId <= 0) {
    // 2.1.3-CD: если причина — ранний маршрутный стоп (pin/one-shot на неготовый
    // аккаунт), main уже прислал её событием id=0. Ждём тик, чтобы IPC успело
    // дойти, и показываем ТОЧНУЮ причину с выходом из тупика вместо общего текста.
    // Окно 10с и сверка chatId — чтобы вчерашний/чужой стоп не подменил причину.
    await new Promise(r => setTimeout(r, 30))
    const early = deps.getProjectState().earlyRouteStop
    const earlyMatch = early && activeChatId != null && early.chatId === activeChatId && Date.now() - early.at < 10_000
    const reason = earlyMatch ? early.message : null
    if (earlyMatch) deps.getProjectState().setEarlyRouteStop(null)
    const errorText = `\n\n[Ошибка: ${reason ?? 'провайдер недоступен'}]`
    store.updateLastAssistant(errorText)
    if (assistantRow) void api.chatsUpdateMessage(assistantRow.id, errorText).catch(() => {})
    deps.getProjectState().applyAgentProgressEvent({ type: 'error', message: reason ?? 'Провайдер недоступен' })
    store.setStreaming(false)
    deps.setCurrentSendId(null)
    return { kind: 'send-failed' }
  }
  if (deps.getPipelineAutoSendStep() === 'execute') {
    deps.setPipelineExecuteSendId(sendId)
  }
  deps.getProjectState().setAgentProgress(activateModelProgress(deps.getProjectState().agentProgress ?? [], providerLabel))
  // Bind this send to the chat that initiated it — if user switches to
  // another chat mid-stream, the event handler will route events into
  // chatSnapshots[activeChatId] rather than corrupting the new active chat.
  if (activeChatId != null) {
    deps.registerChatSendOwner(sendId, activeChatId, false, path)
    if (assistantRow && sendId > 0) deps.registerPersistedAssistant(sendId, assistantRow.id)
  }
  return { kind: 'sent', sendId }
}
