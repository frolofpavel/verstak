// Вынос help-ветки send() из Chat.tsx (фаза 5, срез 1): отправка сообщения
// в режиме справки. React-free: компонент передаёт геттеры состояния и
// коллбэки, здесь — только оркестрация. Поведение 1-в-1 с бывшей inline-веткой,
// включая тонкость: `trigger` для loaders читается из снапшота store, взятого
// в начале send(), а allMessages — из свежего состояния после append'ов.
import type { Attachment, ChatMessage, Skill } from '../../types/api'
import type { AgentProgressEntry } from '../../lib/agent-progress'
import { activateModelProgress, buildInitialAgentProgress } from '../../lib/agent-progress'
import { HELP_CHAT_SEND_OVERRIDES, HELP_PROJECT_PATH } from '../../lib/help-scope'
import { resolveSkillOverride } from '../../lib/skill-override'

/** Подмножество ProjectState, которое читает/мутирует help-отправка. */
export interface HelpSendProjectState {
  helpChatId: number | null
  help: { messages: ChatMessage[]; agentProgress: AgentProgressEntry[] }
  effortLevel: 'quick' | 'standard' | 'deep'
  hasActiveChatLane: (chatId: number, isHelp?: boolean) => boolean
  clearHelpActivity: () => void
  setHelpAgentProgress: (progress: AgentProgressEntry[]) => void
  addHelpMessage: (msg: ChatMessage) => void
  setHelpStreaming: (v: boolean) => void
  updateHelpLastAssistant: (text: string) => void
  applyEventToHelp: (event: { type: string; [k: string]: unknown }) => void
}

export interface HelpSendSkillsState {
  activeSkillId: string | null
  skills: Skill[]
}

export type HelpSendOverrides = Parameters<Window['api']['ai']['sendWithOverrides']>[2]

/** window.api-вызовы, нужные help-отправке (мокаются в тестах). */
export interface HelpSendApi {
  chatsAppend: (chatId: number, projectPath: string, role: 'user' | 'assistant', content: string) => Promise<{ id: number }>
  chatsUpdateMessage: (messageId: number, content: string) => Promise<unknown>
  runLoaders: (skillId: string, opts: { arg?: string; projectPath?: string | null; trigger: 'chat_open' | 'slash_arg' }) => Promise<{ context: string; labels: string[] }>
  getSetting: (key: string) => Promise<string | null>
  sendWithOverrides: (messages: ChatMessage[], projectPath: string | null, overrides: HelpSendOverrides, chatId?: string) => Promise<number>
}

export interface SendHelpMessageDeps {
  /** Снапшот в начале + свежие чтения после await'ов (как useProject.getState()). */
  getProjectState: () => HelpSendProjectState
  getSkillsState: () => HelpSendSkillsState
  api: HelpSendApi
  queueFollowUp: (text: string) => void
  resetComposerAfterSend: () => void
  armAutoScrollForOutgoing: () => void
  registerChatSendOwner: (sendId: number, chatId: number, isHelp: boolean, projectPath?: string | null) => void
  registerPersistedAssistant: (sendId: number, messageId: number) => void
  setCurrentSendId: (sendId: number | null) => void
  setExhausted: (v: null) => void
  setCrossVerify: (v: null) => void
}

export interface SendHelpMessageInput {
  text: string
  modelText: string
  displayText: string
  attachments: Attachment[]
  providerLabel: string
  /** Из send(): важны только text (своя отправка vs программная) и fromQueue. */
  opts?: { text?: string; fromQueue?: boolean }
}

export type HelpSendResult =
  | { kind: 'no-chat' }
  | { kind: 'queued' }
  | { kind: 'sent'; sendId: number }
  | { kind: 'send-failed' }

// Anti-stall nudge: скиллы-оркестраторы (штабы) давят «жди пакет задачи»;
// nudge — дешёвое подкрепление: ясный запрос = действуй прямо в этом чате.
const ANTI_STALL_NUDGE = '\n\n---\nВАЖНО (Verstak): если пользователь дал ясный прямой запрос — выполни его прямо в этом чате и выдай результат. Не зацикливайся, прося оформить «пакет задачи», «одну фразу цели» или ждать отдельного «ок», если намерение уже понятно.'

export async function sendHelpMessage(input: SendHelpMessageInput, deps: SendHelpMessageDeps): Promise<HelpSendResult> {
  const { text, modelText, displayText, attachments, providerLabel, opts } = input
  const { api } = deps
  const store = deps.getProjectState()
  const helpChatId = store.helpChatId
  if (helpChatId == null) return { kind: 'no-chat' }
  if (!opts?.fromQueue && store.hasActiveChatLane(helpChatId, true)) {
    deps.queueFollowUp(text)
    return { kind: 'queued' }
  }
  const userAttachments = attachments
  store.clearHelpActivity()
  store.setHelpAgentProgress(buildInitialAgentProgress(displayText || text || 'Новый запрос', providerLabel))
  deps.setExhausted(null)
  deps.setCrossVerify(null)
  if (!opts?.text) {
    deps.resetComposerAfterSend()
  }
  const summary = userAttachments.length > 0
    ? `${text}${text ? '\n\n' : ''}📎 ${userAttachments.map(a => a.name).join(', ')}`
    : text
  // Context loaders: активный скилл с frontmatter context_loaders подмешивает
  // данные в content user-message ПЕРЕД отправкой. БД хранит оригинал (summary).
  let enrichedText = text
  const skillsForLoad = deps.getSkillsState()
  const activeSkillForLoad = skillsForLoad.activeSkillId
    ? skillsForLoad.skills.find(s => s.id === skillsForLoad.activeSkillId)
    : null
  if (activeSkillForLoad?.context_loaders?.length) {
    try {
      const loaded = await api.runLoaders(activeSkillForLoad.id, {
        trigger: !store.help.messages.some(m => m.role === 'user') ? 'chat_open' : 'slash_arg',
        projectPath: null,
        arg: modelText.split(/\s+/)[0]
      })
      if (loaded.context) enrichedText = `${loaded.context}\n\n---\n\n${text}`
    } catch (err) {
      console.warn('[help] skill loaders failed:', err)
    }
  }
  deps.armAutoScrollForOutgoing()
  store.addHelpMessage({ role: 'user', content: enrichedText, attachments: userAttachments })
  await api.chatsAppend(helpChatId, HELP_PROJECT_PATH, 'user', summary)
  const assistantRow = await api.chatsAppend(helpChatId, HELP_PROJECT_PATH, 'assistant', '')
  store.addHelpMessage({ role: 'assistant', content: '', dbId: assistantRow.id })
  store.setHelpStreaming(true)
  deps.getProjectState().setHelpAgentProgress(
    activateModelProgress(deps.getProjectState().help.agentProgress, providerLabel)
  )
  const allMessages = [...deps.getProjectState().help.messages].slice(0, -1)
  const skillsNow = deps.getSkillsState()
  const activeSkill = skillsNow.activeSkillId
    ? skillsNow.skills.find(s => s.id === skillsNow.activeSkillId)
    : null
  const helpOverrides: HelpSendOverrides = {
    ...HELP_CHAT_SEND_OVERRIDES,
  }
  if (activeSkill) {
    // Provider override — только при смене семейства (API↔CLI сохраняется);
    // model — и при том же семействе. См. lib/skill-override.
    const currentProvider = await api.getSetting('provider')
    const { providerId: overrideProvider, model: overrideModel } = resolveSkillOverride(activeSkill, currentProvider)
    Object.assign(helpOverrides, {
      systemPrompt: activeSkill.systemPrompt + ANTI_STALL_NUDGE,
      ...(overrideProvider ? { providerId: overrideProvider } : {}),
      ...(overrideModel ? { model: overrideModel } : {}),
      ...(activeSkill.tools_allow?.length ? { toolsAllow: activeSkill.tools_allow } : {}),
      ...(activeSkill.recipe ? { recipe: activeSkill.recipe } : {}),
      effortLevel: store.effortLevel,
    })
  } else if (store.effortLevel !== 'standard') {
    helpOverrides.effortLevel = store.effortLevel
  }
  const sendId = await api.sendWithOverrides(allMessages, null, helpOverrides, String(helpChatId))
  deps.setCurrentSendId(sendId)
  if (sendId <= 0) {
    const errorText = '\n\n[Ошибка: провайдер недоступен]'
    deps.getProjectState().updateHelpLastAssistant(errorText)
    void api.chatsUpdateMessage(assistantRow.id, errorText).catch(() => {})
    deps.getProjectState().applyEventToHelp({ type: 'error', message: 'Провайдер недоступен' })
    deps.getProjectState().setHelpStreaming(false)
    deps.setCurrentSendId(null)
    return { kind: 'send-failed' }
  }
  deps.getProjectState().setHelpAgentProgress(
    activateModelProgress(deps.getProjectState().help.agentProgress ?? [], providerLabel)
  )
  deps.registerChatSendOwner(sendId, helpChatId, true, null)
  deps.registerPersistedAssistant(sendId, assistantRow.id)
  return { kind: 'sent', sendId }
}
