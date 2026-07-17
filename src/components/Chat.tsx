import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ClipboardEvent, type PointerEvent as ReactPointerEvent, type SetStateAction } from 'react'
import { useProject, type PreflightCard, type SendOwner } from '../store/projectStore'
import { findRunForChat } from '../lib/own-run'
import { historyForSend } from '../lib/chat-messages'
import { activeScopeKey, ownerScopeKey } from '../lib/pending-scope'
import { useProvider } from '../hooks/useProvider'
import { estimateCost, costSeverity, costBreakdown } from '../lib/pricing'
import { Markdown } from './Markdown'
import { ModelPicker } from './ModelPicker'
import { PromptRouteControl } from './chat/PromptRouteControl'
import { ModePicker } from './ModePicker'
import { IntensityToggle } from './IntensityToggle'
import { VoiceInput } from './VoiceInput'
import { TimelineBar } from './TimelineBar'
import { AgentProgressPanel } from './AgentProgressPanel'
import { ReviewPanel } from './ReviewPills'
import { DevTaskBadge } from './DevTaskBadge'
import { ResumeBanner } from './ResumeBanner'
import { WorktreeBar } from './WorktreeBar'
import { PipelineWizard } from './PipelineWizard'
import { PipelineBanner } from './PipelineBanner'
import { ComposerToolsMenu } from './ComposerToolsMenu'
import { EffortPicker } from './EffortPicker'
import { SlashCommandPopup, type SlashCommand } from './SlashCommandPopup'
import { MentionPopup } from './MentionPopup'
import { MULTI_AGENT_TEMPLATES } from '../lib/multi-agent-templates'
import { extractMentions } from '../lib/mentions'
import { useSkills as useSkillsStore } from '../store/skillStore'
import { buildSkillIndex, suggestManyFromIndex, suggestScoredFromIndex } from '../lib/skill-suggest'
import { suggestRecipe, hasExplicitRecipeIntent } from '../lib/recipe-suggest'
import { modeModelsKey, parseModeModels, resolveModeModel } from '../lib/mode-model'
import { readAgentMode, useAgentMode } from '../hooks/useAgentMode'
import type { AgentMode } from './ModePicker'
import type { AppliedSkillRef, Attachment, ChatEvent, ChatMessage, Reminder, Skill, Suggestion } from '../types/api'
import iconUrl from '../assets/icon.png'
import { useT } from '../i18n'
import { notifyResponseReady } from '../lib/response-notify'
import { HELP_AGENT_MODE, HELP_CHAT_SEND_OVERRIDES, HELP_PROJECT_PATH } from '../lib/help-scope'
import { EMPTY_COMPOSER_DRAFT, resolveComposerDraftKey } from '../lib/composer-drafts'
import { formatDuration } from '../lib/format-duration'
import { VisionAttachmentBanner } from './VisionAttachmentBanner'
import { isImageAttachment, providerSupportsVision } from '../lib/vision-support'
import { resolveSkillOverride } from '../lib/skill-override'
import { buildPipelineSend, resolvePipelineRunId, resolveProofRunId, resolveReviewCandidateRunIds, reviewGateState, SAMPLE_BRIEF } from '../lib/pipeline-brief'
import { decidePipelineGate, type VerifyOutcome } from '../lib/pipeline-gate'
import { isCliProvider } from '../lib/model-catalog'
import { toProjectAbsPath } from '../lib/project-path'
import type { PipelineRun, PipelineStep, PipelineBrief, PipelineMode } from '../types/api'
import type { ProviderId } from '../hooks/useProvider'
import {
  formatChatDateDivider,
  formatMessageClock,
  formatMessageDateTitle,
  isSameLocalDay,
} from '../lib/chat-timestamps'
import { ComposerPendingBar } from './ComposerPendingBar'
import {
  CANCELLED_SUPPLEMENT_CONTENT,
  formatSupplementForAgent,
  nextComposerItemId,
  parseSupplementMessage,
  type PendingSupplement,
  type PendingSupplementStatus,
  type QueuedComposerMessage,
} from '../lib/composer-streaming'
import {
  blobToAttachment,
  CHAT_FILE_ACCEPT,
  isLegacyDoc,
} from '../lib/chat-attachments'
import { activateModelProgress, buildInitialAgentProgress, reduceAgentProgress, type AgentProgressEntry } from '../lib/agent-progress'

interface ComposerPendingState {
  queuedMessages: QueuedComposerMessage[]
  pendingSupplements: PendingSupplement[]
  pendingBarExpanded: boolean
}

const EMPTY_COMPOSER_PENDING_STATE: ComposerPendingState = {
  queuedMessages: [],
  pendingSupplements: [],
  pendingBarExpanded: false,
}

function normalizeProjectPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function projectNameForPath(projectPath: string | null | undefined): string | undefined {
  if (!projectPath) return undefined
  const norm = normalizeProjectPath(projectPath)
  const meta = useProject.getState().projectList.find(p => normalizeProjectPath(p.path) === norm)
  return meta?.name ?? projectPath.split(/[/\\]/).pop() ?? undefined
}

interface ReminderPinsPrefs {
  collapsed: boolean
  x: number
  y: number
}

const DEFAULT_REMINDER_PINS_PREFS: ReminderPinsPrefs = {
  collapsed: false,
  x: 10,
  y: 76,
}

function reminderPinsPrefsKey(projectPath: string): string {
  return `gg.chatReminderPins.panel.v2.${normalizeProjectPath(projectPath)}`
}

function readReminderPinsPrefs(projectPath: string): ReminderPinsPrefs {
  try {
    const raw = localStorage.getItem(reminderPinsPrefsKey(projectPath))
    const parsed = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object') return DEFAULT_REMINDER_PINS_PREFS
    return {
      collapsed: Boolean(parsed.collapsed),
      x: Number.isFinite(Number(parsed.x)) ? Number(parsed.x) : DEFAULT_REMINDER_PINS_PREFS.x,
      y: Number.isFinite(Number(parsed.y)) ? Number(parsed.y) : DEFAULT_REMINDER_PINS_PREFS.y,
    }
  } catch {
    return DEFAULT_REMINDER_PINS_PREFS
  }
}

function writeReminderPinsPrefs(projectPath: string, prefs: ReminderPinsPrefs): void {
  try {
    localStorage.setItem(reminderPinsPrefsKey(projectPath), JSON.stringify(prefs))
  } catch {
    /* ignore */
  }
}

function skillSuggestionsPrefsKey(projectPath: string): string {
  return `gg.skillSuggestions.enabled.${normalizeProjectPath(projectPath)}`
}

function readSkillSuggestionsEnabled(projectPath: string | null | undefined): boolean {
  if (!projectPath) return true
  try {
    return localStorage.getItem(skillSuggestionsPrefsKey(projectPath)) !== '0'
  } catch {
    return true
  }
}

function writeSkillSuggestionsEnabled(projectPath: string | null | undefined, enabled: boolean): void {
  if (!projectPath) return
  try {
    localStorage.setItem(skillSuggestionsPrefsKey(projectPath), enabled ? '1' : '0')
  } catch {
    /* ignore */
  }
}

function clampReminderPinsPrefs(prefs: ReminderPinsPrefs, host: HTMLElement | null): ReminderPinsPrefs {
  if (!host) return prefs
  const rect = host.getBoundingClientRect()
  const maxX = Math.max(8, rect.width - 260)
  const maxY = Math.max(44, rect.height - 150)
  return {
    ...prefs,
    x: Math.min(Math.max(8, prefs.x), maxX),
    y: Math.min(Math.max(44, prefs.y), maxY),
  }
}

function formatReminderPinTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function registerChatSendOwner(sendId: number, chatId: number, isHelp: boolean, projectPath?: string | null): void {
  useProject.getState().registerSendOwner(sendId, {
    kind: 'chat',
    chatId,
    ...(isHelp ? { isHelp: true } : {}),
    ...(projectPath ? { projectPath } : {})
  })
}

function notifyAgentFinished(
  owner: SendOwner | null,
  projectPath: string | null | undefined,
  isError?: boolean
): void {
  if (owner?.kind === 'chat' && owner.isHelp) {
    void notifyResponseReady({ isHelp: true, isError })
    return
  }
  void notifyResponseReady({
    projectName: projectNameForPath(projectPath),
    projectPath: projectPath ?? undefined,
    isError
  })
}

/** История для модели. Живёт в lib и СОХРАНЯЕТ dbId — по нему main режет историю по
 *  границе сжатого итога (ревью 2.0.11-B #4). Раньше была локальной копией и срезала его. */
const compactMessagesForSend = historyForSend

const MAX_BYTES_PER_FILE = 5 * 1024 * 1024  // 5 MB
const MAX_ATTACHMENTS = 8
const CHAT_AUTO_SCROLL_KEY = 'gg.chatAutoScroll'

function readAutoScrollPref(): boolean {
  try {
    const v = localStorage.getItem(CHAT_AUTO_SCROLL_KEY)
    if (v === '0') return false
    if (v === '1') return true
  } catch { /* private mode */ }
  return true
}

function buildInterruptedAnswerProgress(createdAt: number | undefined, providerLabel: string): AgentProgressEntry[] {
  const timestamp = createdAt ?? Date.now()
  return [
    {
      id: 'interrupted-answer',
      phase: 'final',
      title: 'Ответ прерван',
      detail: `${providerLabel} начал отвечать, но приложение было закрыто до сохранения видимого ответа. Запуск не удалось восстановить автоматически — если задача ещё актуальна, повтори запрос.`,
      status: 'error',
      timestamp
    }
  ]
}

type RightPanel = 'none' | 'terminal' | 'sidechat' | 'file-preview'

interface ChatProps {
  onOpenSettings: () => void
  rightPanel: RightPanel
  onSelectRightPanel: (panel: RightPanel) => void
  isSettingsOpen?: boolean
  /** Open the right-docked parallel chat (lazily created by App). */
  onOpenSideChat: () => void
  onOpenFilePreview: (path: string) => void

}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** Иконка-индикатор черновика: заливка растёт с объёмом текста (визуальный cap 32k). */
function TokenPreviewMeter({ tokens, exact, title }: { tokens: number; exact: boolean; title: string }) {
  const fill = Math.min(1, tokens / 32_000)
  const innerH = Math.max(1.2, fill * 9)
  const innerY = 13.2 - innerH
  return (
    <span className="gg-usage-pill is-preview" title={title}>
      <svg className="gg-usage-meter-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden>
        <rect x="3" y="2" width="10" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.15" opacity="0.38" />
        <rect x="3.6" y={innerY} width="8.8" height={innerH} rx="1.1" fill="currentColor" opacity="0.9" />
      </svg>
      <span className="gg-usage-meter-label">{exact ? '' : '≈'}{formatTokens(tokens)}</span>
    </span>
  )
}

/**
 * Goal-cycle prompt: композит из read_journal + project_map + create_plan.
 * Это конкретный "AI-Lab/Ideas cycle" внутри продукта — AI сам читает свою
 * историю, синтезирует идеи, предлагает план. Запускается кнопкой
 * "💡 Что улучшить" в пустом чате.
 */
const GOAL_CYCLE_PROMPT = `Запусти цикл self-improvement по этому проекту:

1. Вызови read_journal с limit=50 без фильтра — прочитай последние сессии, действия, ошибки
2. Вызови read_journal с limit=20, kind="note" — собери AI-ошибки и заметки отдельно
3. Вызови get_project_map с format=text — посмотри текущую структуру
4. На основе истории + структуры + git status (он уже в context_pack) сформулируй ровно 3 конкретных улучшения. Каждое:
   - что именно сделать (file:line если применимо)
   - почему это важно сейчас (с привязкой к найденному в журнале)
   - оценка усилия (small/medium/large)
5. Спроси какое из 3 запустить — я выберу одно, и ты создашь по нему create_plan.

Out of scope: общие best practices, рефакторинги ради красоты, изменения без обоснования в журнале.`

const SKILL_ANTI_STALL_NUDGE = '\n\n---\nВАЖНО (Verstak): если пользователь дал ясный прямой запрос — выполни его прямо в этом чате и выдай результат. Не зацикливайся, прося оформить «пакет задачи», «одну фразу цели» или ждать отдельного «ок», если намерение уже понятно.'

function skillDisplayName(skill: Pick<Skill, 'id' | 'name'> | AppliedSkillRef): string {
  return skill.name?.trim() || skill.id
}

function escapePromptAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function toAppliedSkillRef(skill: Skill): AppliedSkillRef {
  return {
    id: skill.id,
    ...(skill.name?.trim() ? { name: skill.name.trim() } : {}),
    ...(skill.icon?.trim() ? { icon: skill.icon.trim() } : {}),
    ...(skill.description?.trim() ? { description: skill.description.trim() } : {}),
  }
}

function resolveAppliedSkillDetails(applied: AppliedSkillRef[], skills: Skill[]): Skill[] {
  const byId = new Map(skills.map(skill => [skill.id, skill]))
  return applied.flatMap(ref => {
    const skill = byId.get(ref.id)
    return skill ? [skill] : []
  })
}

function uniqueSkills(skills: Array<Skill | null | undefined>): Skill[] {
  const seen = new Set<string>()
  const result: Skill[] = []
  for (const skill of skills) {
    if (!skill || seen.has(skill.id)) continue
    seen.add(skill.id)
    result.push(skill)
  }
  return result
}

function mergeToolAllow(skills: Array<Skill | null | undefined>): string[] | undefined {
  const merged = new Set<string>()
  for (const skill of skills) {
    for (const tool of skill?.tools_allow ?? []) {
      if (tool.trim()) merged.add(tool.trim())
    }
  }
  return merged.size ? [...merged] : undefined
}

function firstRecipe(skills: Array<Skill | null | undefined>) {
  return skills.find(skill => skill?.recipe)?.recipe
}

function buildAppliedSkillsSystemPrompt(appliedSkills: Skill[], userText: string): string {
  if (appliedSkills.length === 0) return ''
  const lines: string[] = [
    '## Скиллы, применённые к текущему пользовательскому сообщению',
    '',
    'Пользователь явно применил эти скиллы к последнему сообщению. Это не отдельные задачи и не глобальный режим чата.',
    'Используй инструкции скиллов строго для релевантных частей текущего запроса. Остальные части запроса не игнорируй: выполни их обычным способом или подбери подходящий общий подход.',
    'Если конкретный скилл не подходит к части запроса, коротко объясни почему и продолжай выполнять остальные части.',
    '',
    '<current_user_request>',
    userText.trim(),
    '</current_user_request>',
  ]

  appliedSkills.forEach((skill, index) => {
    lines.push(
      '',
      `<applied_skill index="${index + 1}" id="${escapePromptAttr(skill.id)}" name="${escapePromptAttr(skillDisplayName(skill))}">`,
      skill.description ? `Назначение: ${skill.description}` : 'Назначение: пользователь применил этот скилл к текущему сообщению.',
      'Инструкция: применяй этот регламент к той части пользовательского запроса, которая соответствует назначению скилла.',
      '<skill_instructions>',
      skill.systemPrompt.trim(),
      '</skill_instructions>',
      '</applied_skill>'
    )
  })

  return lines.join('\n')
}

const AUTO_BOUND_SKILL_MIN_SCORE = 14

function buildAutoBoundSkillsSystemPrompt(autoSkills: Skill[], userText: string): string {
  if (autoSkills.length === 0) return ''
  const lines: string[] = [
    '## Автоматически подобранные скиллы для текущего запроса',
    '',
    'Verstak уверенно сопоставил части текущего пользовательского запроса с этими скиллами. Это не справка и не рекомендация: для релевантных частей задачи считай эти скиллы обязательным рабочим протоколом.',
    'Если пользователь явно задал конкретный параметр (порог, период, список кампаний, формат, исключение), этот параметр пользователя сильнее дефолтного значения из скилла.',
    'Дефолты скилла используй только там, где пользователь не дал своё значение. Запреты и проверки безопасности из скилла не обходи молча: если пользователь просит нарушить запрет, сначала явно уточни/подтверди.',
    'Если в запросе несколько операций, сопоставь каждую операцию с подходящим auto-bound skill. Операции без подходящего скилла выполни обычным способом, не игнорируй их.',
    'Перед финальным ответом проверь: применимые обязательные пункты каждого auto-bound skill выполнены, пользовательские параметры учтены как overrides, пропусков без блокера нет.',
    '',
    '<current_user_request>',
    userText.trim(),
    '</current_user_request>',
  ]

  autoSkills.forEach((skill, index) => {
    lines.push(
      '',
      `<auto_bound_skill index="${index + 1}" id="${escapePromptAttr(skill.id)}" name="${escapePromptAttr(skillDisplayName(skill))}">`,
      skill.description ? `Назначение: ${skill.description}` : 'Назначение: Verstak автоматически сопоставил этот скилл с текущим запросом.',
      'Инструкция: применяй этот регламент к релевантной части пользовательского запроса как обязательный протокол.',
      '<skill_instructions>',
      skill.systemPrompt.trim(),
      '</skill_instructions>',
      '</auto_bound_skill>'
    )
  })

  return lines.join('\n')
}

function appliedSkillNames(appliedRefs: AppliedSkillRef[], detailedSkills: Skill[]): string {
  const byId = new Map(detailedSkills.map(skill => [skill.id, skill]))
  return appliedRefs
    .map(ref => {
      const skill = byId.get(ref.id)
      return skill ? skillDisplayName(skill) : skillDisplayName(ref)
    })
    .join(', ')
}

function buildAppliedSkillsTaskContract(
  appliedRefs: AppliedSkillRef[],
  detailedSkills: Skill[],
  currentMessage: boolean
): string {
  if (appliedRefs.length === 0) return ''
  const byId = new Map(detailedSkills.map(skill => [skill.id, skill]))
  const names = appliedSkillNames(appliedRefs, detailedSkills)
  if (!currentMessage) {
    return [
      '<historical_task_contract source="verstak_applied_skills">',
      `К предыдущему пользовательскому сообщению были применены скиллы: ${names}.`,
      'Это относится только к тому сообщению и помогает понять историю выполнения, но не включает эти скиллы как новый глобальный режим.',
      '</historical_task_contract>',
    ].join('\n')
  }

  const lines: string[] = [
    '<current_task_contract source="verstak_applied_skills" priority="required">',
    'ВАЖНО: это не справочный контекст и не внешняя заметка. Это часть текущего пользовательского запроса, созданная интерфейсом Verstak после явного нажатия пользователем "Применить скилл".',
    `Пользователь применил к текущему сообщению скиллы: ${names}.`,
    `Считай это эквивалентом прямой фразы пользователя: "Выполни текущую задачу с применением скиллов: ${names}".`,
    'Если пользователь просит сказать, что ты увидел в сообщении, обязательно назови эти применённые скиллы как часть задания.',
    'Не отвечай, что скиллы не указаны в сообщении или подключены "только через контекст". Они указаны через UI Verstak и являются обязательным регламентом для релевантных частей текущей задачи.',
    'Если в одном сообщении несколько операций, сопоставь каждую операцию с подходящим применённым скиллом; операции без подходящего скилла выполни обычным способом.',
    '<applied_skill_refs>',
  ]
  appliedRefs.forEach((ref, index) => {
    const skill = byId.get(ref.id)
    const name = skill ? skillDisplayName(skill) : skillDisplayName(ref)
    const description = skill?.description ?? ref.description ?? ''
    lines.push(
      `<skill index="${index + 1}" id="${escapePromptAttr(ref.id)}" name="${escapePromptAttr(name)}">`,
      description ? `Назначение: ${description}` : 'Назначение: пользователь применил этот скилл к текущему сообщению.',
      skill
        ? 'Полная инструкция этого скилла также передана в системном слое <skill_layer>.'
        : 'Полная инструкция скилла недоступна в текущем renderer-cache; ориентируйся на название и назначение.',
      '</skill>'
    )
  })
  lines.push('</applied_skill_refs>', '</current_task_contract>')
  return lines.join('\n')
}

function buildAutoBoundSkillsTaskContract(autoSkills: Skill[], userText: string): string {
  if (autoSkills.length === 0) return ''
  const names = autoSkills.map(skill => skillDisplayName(skill)).join(', ')
  const lines: string[] = [
    '<current_task_contract source="verstak_auto_bound_skills" priority="required">',
    `Verstak автоматически и с высокой уверенностью привязал к текущему запросу скиллы: ${names}.`,
    'Эти скиллы обязательны для тех частей текущей задачи, к которым они относятся. Не считай их необязательными подсказками.',
    'Раздели пользовательский запрос на операции и сопоставь каждую релевантную операцию с подходящим скиллом из списка.',
    'Явные параметры пользователя имеют приоритет над дефолтными параметрами скилла: суммы, периоды, списки, пороги, исключения и формат ответа бери из текущего запроса.',
    'Если параметр пользователя отличается от дефолта скилла, используй параметр пользователя и считай его override. Не возвращайся к дефолту скилла без причины.',
    'Обязательные проверки, запреты и критерии завершения из скилла не пропускай. Если выполнить пункт невозможно из-за доступа/данных/инструментов, назови это блокером.',
    'Перед финальным ответом сделай self-check по применимым пунктам auto-bound skills. Если что-то пропущено, сначала доделай или честно сообщи блокер.',
    '<current_user_request>',
    userText.trim(),
    '</current_user_request>',
    '<auto_bound_skill_refs>',
  ]
  autoSkills.forEach((skill, index) => {
    lines.push(
      `<skill index="${index + 1}" id="${escapePromptAttr(skill.id)}" name="${escapePromptAttr(skillDisplayName(skill))}">`,
      skill.description ? `Назначение: ${skill.description}` : 'Назначение: скилл автоматически выбран по смыслу текущего запроса.',
      'Полная инструкция этого скилла также передана в системном слое <skill_layer>.',
      '</skill>'
    )
  })
  lines.push('</auto_bound_skill_refs>', '</current_task_contract>')
  return lines.join('\n')
}

function buildSkillBindingProgressDetail(manualSkills: Skill[], autoSkills: Skill[]): string | undefined {
  const manualNames = manualSkills.map(skillDisplayName)
  const autoNames = autoSkills.map(skillDisplayName)
  const parts: string[] = []
  if (manualNames.length) {
    parts.push(`пользователь применил: ${manualNames.join(', ')}`)
  }
  if (autoNames.length) {
    parts.push(`Verstak подключил автоматически: ${autoNames.join(', ')}`)
  }
  if (parts.length === 0) return undefined
  return `К задаче подключены скиллы — ${parts.join('; ')}. Они будут использованы как рабочий протокол для подходящих частей запроса.`
}

function withAppliedSkillContextForModel(messages: ChatMessage[], skills: Skill[], autoBoundSkills: Skill[] = []): ChatMessage[] {
  const lastUserIndex = messages.map(message => message.role).lastIndexOf('user')
  return messages.map((message, index) => {
    if (message.role !== 'user') return message
    if (message.content.includes('<current_task_contract') || message.content.includes('<historical_task_contract')) return message
    const isCurrent = index === lastUserIndex
    const payloads: string[] = []
    if (message.appliedSkills?.length) {
      const detailedSkills = resolveAppliedSkillDetails(message.appliedSkills, skills)
      payloads.push(buildAppliedSkillsTaskContract(message.appliedSkills, detailedSkills, isCurrent))
    }
    if (isCurrent && autoBoundSkills.length) {
      payloads.push(buildAutoBoundSkillsTaskContract(autoBoundSkills, message.content))
    }
    const payload = payloads.filter(Boolean).join('\n\n')
    if (!payload) return message
    return {
      ...message,
      content: `${message.content}\n\n---\n\n${payload}`,
    }
  })
}

function composeSkillSystemPrompt(activeSkill: Skill | null, appliedSkills: Skill[], userText: string, autoBoundSkills: Skill[] = []): string | undefined {
  const parts = [
    activeSkill ? activeSkill.systemPrompt : '',
    buildAppliedSkillsSystemPrompt(appliedSkills, userText),
    buildAutoBoundSkillsSystemPrompt(autoBoundSkills, userText),
  ].filter(part => part.trim())
  if (parts.length > 0) parts.push(SKILL_ANTI_STALL_NUDGE)
  return parts.length ? parts.join('\n\n---\n\n') : undefined
}

export function Chat({ onOpenSettings, rightPanel, onSelectRightPanel, isSettingsOpen = false, onOpenSideChat, onOpenFilePreview }: ChatProps) {
  const t = useT()
  const {
    helpMode, help, helpChatId,
    messages: projectMessages, addMessage, insertMessageBeforeLast, updateLastAssistant,
    isStreaming: projectIsStreaming, setStreaming, streamStartedAt: projectStreamStartedAt,
    finalizeActiveStreamDuration, finalizeHelpStreamDuration,
    activity: projectActivity, preflights, subagentRuns,
    agentProgress: projectAgentProgress,
    sessionUsage: projectSessionUsage,
    path: activePath, chatSessions, activeChatId, resumableRuns,
    chatHasMoreBefore, chatTotalCount, loadOlderMessages,
    addHelpMessage, insertHelpMessageBeforeLast, updateHelpLastAssistant,
    setHelpStreaming, clearHelpActivity, pushHelpActivity, setHelpAgentProgress, addHelpUsage,
    appendHelpLastAssistantThinking,
    setAgentProgress,
    setComposerDraft,
    clearComposerDraft,
    setActiveView,
  } = useProject()
  const isHelpChat = helpMode
  const [skillSuggestionsEnabled, setSkillSuggestionsEnabled] = useState(() => readSkillSuggestionsEnabled(activePath))
  const messages = helpMode ? help.messages : projectMessages
  const hasOlderMessages = !helpMode && chatHasMoreBefore
  const isStreaming = helpMode ? help.isStreaming : projectIsStreaming
  const streamStartedAt = helpMode ? help.streamStartedAt : projectStreamStartedAt
  const activity = helpMode ? help.activity : projectActivity
  const agentProgress = helpMode ? help.agentProgress : projectAgentProgress
  const sessionUsage = helpMode ? help.sessionUsage : projectSessionUsage
  const [tickNow, setTickNow] = useState(() => Date.now())
  useEffect(() => {
    if (!isStreaming || streamStartedAt == null) return
    setTickNow(Date.now())
    const id = window.setInterval(() => setTickNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [isStreaming, streamStartedAt])

  const assistantAnimationScope = helpMode
    ? 'help'
    : activeChatId != null
      ? `chat:${activeChatId}`
      : activePath
        ? `path:${activePath}`
        : 'chat'
  const lastAssistantInfo = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role === 'assistant') {
        return {
          index: i,
          message,
          key: `${assistantAnimationScope}:${message.dbId ?? 'local'}:${message.createdAt ?? i}`
        }
      }
    }
    return null
  }, [messages, assistantAnimationScope])
  const lastAssistantMessage = lastAssistantInfo?.message ?? null
  const lastAssistantAnimationKey = lastAssistantInfo?.key ?? null
  const [animatedAssistantText, setAnimatedAssistantText] = useState<{ key: string; shown: string; target: string } | null>(null)
  const [chatWindowActive, setChatWindowActive] = useState(() => (
    typeof document === 'undefined'
      ? true
      : document.visibilityState === 'visible' && document.hasFocus()
  ))
  const [appearanceMotionOff, setAppearanceMotionOff] = useState(() => (
    typeof document !== 'undefined'
      && document.documentElement.getAttribute('data-motion') === 'off'
  ))
  const assistantAnimationSeenRef = useRef(false)
  const assistantAnimationPlayedKeysRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const root = document.documentElement
    const read = () => setAppearanceMotionOff(root.getAttribute('data-motion') === 'off')
    read()
    const observer = new MutationObserver(read)
    observer.observe(root, { attributes: true, attributeFilter: ['data-motion'] })
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    function refreshWindowActive() {
      setChatWindowActive(document.visibilityState === 'visible' && document.hasFocus())
    }
    refreshWindowActive()
    window.addEventListener('focus', refreshWindowActive)
    window.addEventListener('blur', refreshWindowActive)
    document.addEventListener('visibilitychange', refreshWindowActive)
    return () => {
      window.removeEventListener('focus', refreshWindowActive)
      window.removeEventListener('blur', refreshWindowActive)
      document.removeEventListener('visibilitychange', refreshWindowActive)
    }
  }, [])
  useEffect(() => {
    if (!lastAssistantAnimationKey || !lastAssistantMessage) {
      setAnimatedAssistantText(null)
      return
    }
    const target = lastAssistantMessage.content ?? ''
    const isFreshAssistant = typeof lastAssistantMessage.createdAt === 'number'
      ? Date.now() - lastAssistantMessage.createdAt < 60_000
      : false
    setAnimatedAssistantText(prev => {
      if (prev?.key === lastAssistantAnimationKey) {
        if (prev.shown && target && !target.startsWith(prev.shown)) {
          return { key: lastAssistantAnimationKey, shown: target, target }
        }
        if (target.length < prev.shown.length) {
          return { key: lastAssistantAnimationKey, shown: target, target }
        }
        return { ...prev, target }
      }
      const alreadyPlayed = assistantAnimationPlayedKeysRef.current.has(lastAssistantAnimationKey)
      const shouldAnimate = !alreadyPlayed
        && !appearanceMotionOff
        && chatWindowActive
        && !isSettingsOpen
        && isStreaming
        && isFreshAssistant
      if (shouldAnimate) assistantAnimationPlayedKeysRef.current.add(lastAssistantAnimationKey)
      return {
        key: lastAssistantAnimationKey,
        shown: shouldAnimate ? '' : target,
        target
      }
    })
    assistantAnimationSeenRef.current = true
  }, [lastAssistantAnimationKey, lastAssistantMessage?.content, lastAssistantMessage?.createdAt, isStreaming, chatWindowActive, isSettingsOpen, appearanceMotionOff])
  const assistantAnimationRafRef = useRef<number | null>(null)
  const assistantAnimationLastFrameRef = useRef<number | null>(null)
  const assistantAnimationCarryRef = useRef(0)
  useEffect(() => {
    if (appearanceMotionOff || isSettingsOpen || !chatWindowActive) {
      setAnimatedAssistantText(prev => prev ? { ...prev, shown: prev.target } : prev)
      return
    }
    if (!animatedAssistantText || animatedAssistantText.shown.length >= animatedAssistantText.target.length) return
    assistantAnimationLastFrameRef.current = null
    assistantAnimationCarryRef.current = 0
    let stopped = false
    const frame = (now: number) => {
      const lastFrame = assistantAnimationLastFrameRef.current
      if (lastFrame != null && now - lastFrame < 34) {
        assistantAnimationRafRef.current = window.requestAnimationFrame(frame)
        return
      }
      let keepGoing = true
      setAnimatedAssistantText(prev => {
        if (!prev || prev.shown.length >= prev.target.length) {
          keepGoing = false
          return prev
        }
        const last = assistantAnimationLastFrameRef.current ?? now
        const delta = Math.min(80, Math.max(0, now - last))
        assistantAnimationLastFrameRef.current = now
        const remaining = prev.target.length - prev.shown.length
        const charsPerSecond = remaining > 5000 ? 760 : remaining > 1800 ? 560 : remaining > 500 ? 390 : 260
        assistantAnimationCarryRef.current += (delta / 1000) * charsPerSecond
        const step = Math.min(18, Math.floor(assistantAnimationCarryRef.current))
        if (step < 1) return prev
        assistantAnimationCarryRef.current -= step
        const shown = prev.target.slice(0, Math.min(prev.target.length, prev.shown.length + step))
        if (shown.length >= prev.target.length) keepGoing = false
        return { ...prev, shown }
      })
      if (!stopped && keepGoing) {
        assistantAnimationRafRef.current = window.requestAnimationFrame(frame)
      }
    }
    assistantAnimationRafRef.current = window.requestAnimationFrame(frame)
    return () => {
      stopped = true
      if (assistantAnimationRafRef.current != null) window.cancelAnimationFrame(assistantAnimationRafRef.current)
      assistantAnimationRafRef.current = null
    }
  }, [animatedAssistantText?.key, animatedAssistantText?.target, isSettingsOpen, chatWindowActive, appearanceMotionOff])
  const agentProgressElapsedMs = isStreaming && streamStartedAt != null
    ? tickNow - streamStartedAt
    : null
  const agentProgressDurationMs = !isStreaming
    ? lastAssistantMessage?.responseDurationMs ?? null
    : null
  const agentProgressFinishedAt = !isStreaming && lastAssistantMessage?.createdAt != null && lastAssistantMessage.responseDurationMs != null
    ? lastAssistantMessage.createdAt + lastAssistantMessage.responseDurationMs
    : null
  // #2 per-session stats: персистентный агрегат cost/инструменты/файлы по всем
  // прогонам чата (переживает рестарт). Рефетч при смене чата и по завершении прогона.
  const [sessionStats, setSessionStats] = useState<{ runs: number; costCents: number; toolCount: number; filesCount: number; agentsCount: number; durationMs: number } | null>(null)
  useEffect(() => {
    if (helpMode || activeChatId == null) { setSessionStats(null); return }
    let cancelled = false
    void window.api.agentRuns.sessionStats(activeChatId).then(s => { if (!cancelled) setSessionStats(s) }).catch(() => {})
    return () => { cancelled = true }
  }, [activeChatId, isStreaming, helpMode])
  const { mode: agentMode, setMode: setAgentMode } = useAgentMode(activeChatId, helpMode)
  const projectName = activePath ? activePath.replace(/^.*[\\/]/, '') : null
  const activeChatTitle = isHelpChat
    ? t.help.emptyTitle
    : (chatSessions.find(s => s.id === activeChatId)?.title ?? null)
  const provider = useProvider()
  // ось 3 A: смена режима свопит модель по привязке mode_models_<provider> (plan →
  // reasoning-модель, act/auto → дешёвый кодер). Идёт через onChange ModePicker —
  // ловит И клики, И клавиши 1-5. Нет привязки для режима → модель не трогаем.
  const applyMode = useCallback(async (m: AgentMode) => {
    await setAgentMode(m)
    if (isHelpChat) return
    try {
      const raw = await window.api.settings.getKey(modeModelsKey(provider.id))
      const target = resolveModeModel(parseModeModels(raw), m)
      if (target && target !== provider.model && (provider.models.length === 0 || provider.models.includes(target))) {
        await provider.setModel(target)
        // Персист per-chat (как ModelPicker/switchVisionModel): иначе глобальный
        // model_<provider> откатится при возврате в чат (switchChatSession пишет его
        // из session.model) и протечёт в новые чаты (ревью HIGH).
        if (activeChatId != null) {
          try {
            await window.api.chatSessions.setModel(activeChatId, provider.id, target)
            await useProject.getState().refreshChatSessions()
          } catch { /* не блокируем UX */ }
        }
      }
    } catch { /* своп не критичен — режим уже применён */ }
  }, [setAgentMode, isHelpChat, provider, activeChatId])
  const [input, setInput] = useState('')
  const [suggestionInput, setSuggestionInput] = useState('')
  const [appliedSkills, setAppliedSkills] = useState<AppliedSkillRef[]>([])
  const appliedSkillIds = useMemo(() => new Set(appliedSkills.map(skill => skill.id)), [appliedSkills])
  // Авто-предложение скилла: матчим черновик к скиллам, предлагаем активацию (с апрувом).
  const allSkills = useSkillsStore(s => s.skills)
  const activeSkillId = useSkillsStore(s => s.activeSkillId)
  const activeSkillForComposer = useMemo(() => {
    if (!activeSkillId) return null
    return allSkills.find(skill => skill.id === activeSkillId) ?? null
  }, [activeSkillId, allSkills])
  const [dismissedSuggestIds, setDismissedSuggestIds] = useState<Set<string>>(() => new Set())
  // Индекс токенов скиллов — пересобирается только при смене списка скиллов (не на keystroke).
  const skillIndex = useMemo(() => buildSkillIndex(allSkills), [allSkills])
  const suggestedSkills = useMemo(() => {
    if (isHelpChat) return []
    if (!skillSuggestionsEnabled) return []
    if (suggestionInput.trim().startsWith('/')) return [] // слэш-команда — пользователь уже выбирает
    const excluded = new Set([...appliedSkillIds, ...dismissedSuggestIds])
    return suggestManyFromIndex(suggestionInput, skillIndex, activeSkillId, excluded, 4)
  }, [isHelpChat, skillSuggestionsEnabled, suggestionInput, skillIndex, activeSkillId, appliedSkillIds, dismissedSuggestIds])
  // Этап 4: детерминированное предложение coding-recipe по интенту задачи. Только
  // явный интент (не фоллбэк small-edit), только если такой recipe-скилл есть и не
  // активен. Чисто предложение через chip — без auto-run.
  const [dismissedRecipeId, setDismissedRecipeId] = useState<string | null>(null)
  const suggestedRecipe = useMemo(() => {
    if (isHelpChat) return null
    if (!skillSuggestionsEnabled) return null
    if (suggestionInput.trim().startsWith('/')) return null
    if (!hasExplicitRecipeIntent(suggestionInput)) return null
    const id = suggestRecipe(suggestionInput)
    if (id === activeSkillId || id === dismissedRecipeId) return null
    if (appliedSkillIds.has(id)) return null
    const skill = allSkills.find(s => s.id === id && s.recipe)
    return skill ?? null
  }, [isHelpChat, skillSuggestionsEnabled, suggestionInput, activeSkillId, dismissedRecipeId, appliedSkillIds, allSkills])
  // Сброс «скрыть»: композер очищен (после отправки) → следующее сообщение снова может предложить.
  useEffect(() => { if (!input.trim()) { setDismissedSuggestIds(new Set()); setDismissedRecipeId(null) } }, [input])
  const [chatReminderPins, setChatReminderPins] = useState<Reminder[]>([])
  const [reminderPinsPrefs, setReminderPinsPrefs] = useState<ReminderPinsPrefs>(DEFAULT_REMINDER_PINS_PREFS)
  const [skillSuggestionsToast, setSkillSuggestionsToast] = useState<number | null>(null)
  const visibleReminderPins = isHelpChat || reminderPinsPrefs.collapsed ? [] : chatReminderPins
  useEffect(() => {
    setSkillSuggestionsEnabled(readSkillSuggestionsEnabled(activePath))
  }, [activePath])
  useEffect(() => {
    if (skillSuggestionsToast == null) return
    const timer = window.setTimeout(() => setSkillSuggestionsToast(null), 5000)
    return () => window.clearTimeout(timer)
  }, [skillSuggestionsToast])
  function setProjectSkillSuggestionsEnabled(enabled: boolean) {
    setSkillSuggestionsEnabled(enabled)
    writeSkillSuggestionsEnabled(activePath, enabled)
    if (!enabled) {
      setDismissedRecipeId(null)
      setDismissedSuggestIds(new Set())
      setSkillSuggestionsToast(Date.now())
    } else {
      setSkillSuggestionsToast(null)
    }
  }
  /** Live token-count preview for whatever is in the composer right now. */
  const [previewTokens, setPreviewTokens] = useState<{ tokens: number; exact: boolean } | null>(null)
  /** If the agent loop exhausted its budget on the last send, the user can click "+N turns" to extend. */
  const [exhausted, setExhausted] = useState<{ used: number; suggestedAdd: number; maxBudget: number } | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const chatRootRef = useRef<HTMLDivElement | null>(null)
  const reminderPinsPrefsRef = useRef(reminderPinsPrefs)
  const reminderPanelDragRef = useRef<{
    pointerId: number
    projectPath: string
    startClientX: number
    startClientY: number
    startX: number
    startY: number
  } | null>(null)
  const composerDraftKeyRef = useRef<string | null>(null)
  const composerInputRef = useRef(input)
  const composerAttachmentsRef = useRef(attachments)
  const composerAppliedSkillsRef = useRef(appliedSkills)
  const composerDraftSaveTimerRef = useRef<number | null>(null)
  const lastComposerHeightRef = useRef(0)
  reminderPinsPrefsRef.current = reminderPinsPrefs
  composerInputRef.current = input
  composerAttachmentsRef.current = attachments
  composerAppliedSkillsRef.current = appliedSkills

  function resetComposerAfterSend() {
    const key = composerDraftKeyRef.current
    if (key) clearComposerDraft(key)
    setInput('')
    setSuggestionInput('')
    setAttachments([])
    setAppliedSkills([])
  }

  useEffect(() => {
    const prevKey = composerDraftKeyRef.current
    const nextKey = resolveComposerDraftKey({
      helpMode,
      projectPath: activePath,
      activeChatId,
    })

    if (prevKey && prevKey !== nextKey) {
      setComposerDraft(prevKey, {
        text: composerInputRef.current,
        attachments: composerAttachmentsRef.current,
        appliedSkills: composerAppliedSkillsRef.current,
      })
    }

    if (nextKey !== prevKey) {
      const loaded = nextKey
        ? useProject.getState().getComposerDraft(nextKey)
        : EMPTY_COMPOSER_DRAFT
      setInput(loaded.text)
      setSuggestionInput(loaded.text)
      setAttachments(loaded.attachments)
      setAppliedSkills(loaded.appliedSkills ?? [])
      composerDraftKeyRef.current = nextKey
    }
  }, [helpMode, activePath, activeChatId, setComposerDraft])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSuggestionInput(input)
    }, 140)
    return () => window.clearTimeout(timer)
  }, [input])

  useEffect(() => {
    const key = composerDraftKeyRef.current
    if (!key) return
    if (composerDraftSaveTimerRef.current != null) {
      window.clearTimeout(composerDraftSaveTimerRef.current)
    }
    composerDraftSaveTimerRef.current = window.setTimeout(() => {
      composerDraftSaveTimerRef.current = null
      setComposerDraft(key, { text: composerInputRef.current, attachments: composerAttachmentsRef.current, appliedSkills: composerAppliedSkillsRef.current })
    }, 220)
    return () => {
      if (composerDraftSaveTimerRef.current != null) {
        window.clearTimeout(composerDraftSaveTimerRef.current)
        composerDraftSaveTimerRef.current = null
      }
    }
  }, [input, attachments, appliedSkills, setComposerDraft])
  const [dragOver, setDragOver] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)
  const [queueNotice, setQueueNotice] = useState<string | null>(null)
  const [exportNotice, setExportNotice] = useState<{ title: string; detail: string; ok: boolean } | null>(null)
  const [handoffBusy, setHandoffBusy] = useState(false)
  const [contextCompactNotice, setContextCompactNotice] = useState<{ text: string; loading: boolean } | null>(null)
  const [visionBannerDismissed, setVisionBannerDismissed] = useState(false)
  const streamRef = useRef<HTMLDivElement>(null)
  const visibleDateRafRef = useRef<number | null>(null)
  const visibleDateLabelRef = useRef<string | null>(null)
  const [visibleDateLabel, setVisibleDateLabel] = useState<string | null>(null)
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(readAutoScrollPref)
  const autoScrollEnabledRef = useRef(autoScrollEnabled)
  /** Пока true и автопрокрутка вкл — новые сообщения тянут чат вниз. */
  const stickToBottomRef = useRef(true)
  /** Отправка своего сообщения — принудительно липнем к низу, onScroll не сбрасывает. */
  const pendingPinToBottomRef = useRef(false)
  const [showScrollDown, setShowScrollDown] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const screenshotCounter = useRef(0)
  const warningTimer = useRef<number | null>(null)
  const queueNoticeTimer = useRef<number | null>(null)
  const exportNoticeTimer = useRef<number | null>(null)
  const contextCompactTimer = useRef<number | null>(null)
  const currentSendIdRef = useRef<number | null>(null)
  const persistedAssistantBySendIdRef = useRef(new Map<number, {
    messageId: number
    content: string
    thinking: string
    timer: number | null
    thinkingTimer: number | null
  }>())
  // Одна формула на оба места (см. pendingScopeKeyFor): раньше ключ строился дважды, и это
  // расхождение и было дефектом №1 — не в формуле, а в источнике данных.
  const pendingScopeKey = activeScopeKey({ isHelpChat, helpChatId, activePath, activeChatId })
  const pendingScopeKeyRef = useRef(pendingScopeKey)
  const pendingStateByScopeRef = useRef(new Map<string, ComposerPendingState>())
  const queuedMessagesRef = useRef<QueuedComposerMessage[]>([])
  const [queuedMessages, setQueuedMessages] = useState<QueuedComposerMessage[]>([])
  const pendingSupplementsRef = useRef<PendingSupplement[]>([])
  const [pendingSupplements, setPendingSupplementsRaw] = useState<PendingSupplement[]>([])
  const pendingBarExpandedRef = useRef(false)
  const [pendingBarExpanded, setPendingBarExpandedRaw] = useState(false)
  const flushQueueRef = useRef<() => void>(() => {})
  // Resume задачи (Фаза 4): взводится при gg-resume-send, эффект ниже шлёт send().
  const resumeAutoSendRef = useRef(false)
  // Crash-resume Фаза 2: runId прерванного прогона для re-send с полным контекстом
  // (взводится из gg-resume-send с объектом-detail; консьюмится в send()).
  const resumeFromRunIdRef = useRef<string | null>(null)

  function persistPendingScope(key = pendingScopeKeyRef.current): void {
    pendingStateByScopeRef.current.set(key, {
      queuedMessages: queuedMessagesRef.current,
      pendingSupplements: pendingSupplementsRef.current,
      pendingBarExpanded: pendingBarExpandedRef.current,
    })
  }

  useEffect(() => {
    if (!activePath || isHelpChat) {
      setChatReminderPins([])
      setReminderPinsPrefs(DEFAULT_REMINDER_PINS_PREFS)
      return
    }

    let cancelled = false
    const projectPath = activePath
    setChatReminderPins([])
    setReminderPinsPrefs(clampReminderPinsPrefs(readReminderPinsPrefs(projectPath), chatRootRef.current))

    async function refreshReminders() {
      try {
        const list = await window.api.reminders.list(projectPath, 50)
        if (cancelled) return
        setChatReminderPins(
          list
            .filter(r => r.status === 'pending')
            .sort((a, b) => a.dueAt - b.dueAt)
        )
      } catch {
        if (!cancelled) setChatReminderPins([])
      }
    }

    function onChanged(event: Event) {
      const detail = (event as CustomEvent<{ projectPath?: string }>).detail
      if (!detail?.projectPath || normalizeProjectPath(detail.projectPath) === normalizeProjectPath(projectPath)) {
        void refreshReminders()
      }
    }
    const onFocus = () => { void refreshReminders() }

    void refreshReminders()
    const timer = window.setInterval(() => { void refreshReminders() }, 60_000)
    window.addEventListener('focus', onFocus)
    window.addEventListener('gg-reminders-changed', onChanged as EventListener)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('gg-reminders-changed', onChanged as EventListener)
    }
  }, [activePath, isHelpChat])

  function persistReminderPinsPrefs(next: ReminderPinsPrefs, projectPath = activePath): void {
    const clamped = clampReminderPinsPrefs(next, chatRootRef.current)
    setReminderPinsPrefs(clamped)
    if (projectPath) writeReminderPinsPrefs(projectPath, clamped)
  }

  function setReminderPinsCollapsed(collapsed: boolean): void {
    persistReminderPinsPrefs({ ...reminderPinsPrefsRef.current, collapsed })
  }

  function onReminderPinsDragStart(e: ReactPointerEvent<HTMLDivElement>): void {
    if (!activePath || e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('button')) return
    reminderPanelDragRef.current = {
      pointerId: e.pointerId,
      projectPath: activePath,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: reminderPinsPrefsRef.current.x,
      startY: reminderPinsPrefsRef.current.y,
    }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  function onReminderPinsDragMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const drag = reminderPanelDragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const next = clampReminderPinsPrefs({
      ...reminderPinsPrefsRef.current,
      x: drag.startX + e.clientX - drag.startClientX,
      y: drag.startY + e.clientY - drag.startClientY,
    }, chatRootRef.current)
    setReminderPinsPrefs(next)
  }

  function onReminderPinsDragEnd(e: ReactPointerEvent<HTMLDivElement>): void {
    const drag = reminderPanelDragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    writeReminderPinsPrefs(drag.projectPath, reminderPinsPrefsRef.current)
    reminderPanelDragRef.current = null
  }

  function applyPendingState(state: ComposerPendingState): void {
    queuedMessagesRef.current = state.queuedMessages
    pendingSupplementsRef.current = state.pendingSupplements
    pendingBarExpandedRef.current = state.pendingBarExpanded
    setQueuedMessages(state.queuedMessages)
    setPendingSupplementsRaw(state.pendingSupplements)
    setPendingBarExpandedRaw(state.pendingBarExpanded)
  }

  function pendingScopeKeyFor(owner: SendOwner | null): string | null {
    // ДЕФЕКТ №1 карты (§3.1): здесь брался helpChatId ИЗ ЗАМЫКАНИЯ. Роутер ai.onEvent —
    // замыкание ПЕРВОГО рендера (подписка ставится один раз), а справка открывается позже,
    // поэтому helpChatId навсегда оставался null → ключ выходил `help:global`, тогда как
    // живой ключ — `help:<id>`. Формула совпадала, значения нет: очистка чистила
    // несуществующий scope, флаш уходил в «чужой scope» и возвращал элемент в очередь —
    // очередь справки не отправлялась (маскировал страховочный эффект-флаш).
    // Берём свежее из стора — тем же способом, каким роутер живёт для всего остального.
    return ownerScopeKey(owner, useProject.getState().helpChatId)
  }

  function clearPendingSupplementsForScope(key: string | null): void {
    if (!key) return
    const current = pendingStateByScopeRef.current.get(key) ?? EMPTY_COMPOSER_PENDING_STATE
    const next: ComposerPendingState = {
      ...current,
      pendingSupplements: [],
      pendingBarExpanded: current.queuedMessages.length > 0 ? current.pendingBarExpanded : false,
    }
    pendingStateByScopeRef.current.set(key, next)
    if (key === pendingScopeKeyRef.current) applyPendingState(next)
  }

  function getPendingStateForScope(key: string): ComposerPendingState {
    if (key === pendingScopeKeyRef.current) {
      return {
        queuedMessages: queuedMessagesRef.current,
        pendingSupplements: pendingSupplementsRef.current,
        pendingBarExpanded: pendingBarExpandedRef.current,
      }
    }
    return pendingStateByScopeRef.current.get(key) ?? EMPTY_COMPOSER_PENDING_STATE
  }

  function setPendingStateForScope(key: string, state: ComposerPendingState): void {
    pendingStateByScopeRef.current.set(key, state)
    if (key === pendingScopeKeyRef.current) applyPendingState(state)
  }

  function setPendingSupplements(next: SetStateAction<PendingSupplement[]>): void {
    const value = typeof next === 'function'
      ? (next as (prev: PendingSupplement[]) => PendingSupplement[])(pendingSupplementsRef.current)
      : next
    pendingSupplementsRef.current = value
    setPendingSupplementsRaw(value)
    persistPendingScope()
  }

  function setPendingBarExpanded(next: SetStateAction<boolean>): void {
    const value = typeof next === 'function'
      ? (next as (prev: boolean) => boolean)(pendingBarExpandedRef.current)
      : next
    pendingBarExpandedRef.current = value
    setPendingBarExpandedRaw(value)
    persistPendingScope()
  }

  useEffect(() => {
    if (pendingScopeKeyRef.current === pendingScopeKey) return
    persistPendingScope()
    pendingScopeKeyRef.current = pendingScopeKey
    applyPendingState(pendingStateByScopeRef.current.get(pendingScopeKey) ?? EMPTY_COMPOSER_PENDING_STATE)
  }, [pendingScopeKey])
  // Pipeline (спек D5): авто-send шага. Держит желаемый режим — авто-send
  // срабатывает только когда agentMode реально применился (без race).
  const pipelineSendModeRef = useRef<'plan' | 'accept-edits' | null>(null)
  /** Шаг pipeline, для которого сейчас идёт авто-send (plan | execute). */
  const pipelineAutoSendStepRef = useRef<'plan' | 'execute' | null>(null)
  /** sendId Execute-шага — для точной привязки agentRunId. */
  const pipelineExecuteSendIdRef = useRef<number | null>(null)
  const [pipelineWizardOpen, setPipelineWizardOpen] = useState(false)
  const [pipelineInitialBrief, setPipelineInitialBrief] = useState<PipelineBrief | undefined>(undefined)
  const [pipelineWizardMode, setPipelineWizardMode] = useState<PipelineMode>('agency')
  const [composerSettingsOpen, setComposerSettingsOpen] = useState(false)
  const composerSettingsRef = useRef<HTMLDivElement | null>(null)
  const activePipeline = useProject(s => s.activePipeline)
  const [undoCount, setUndoCount] = useState(0)
  // Cross-verify: результат авто-ревью другим провайдером после изменения файлов.
  // null = ещё не было; object = последний результат (сбрасывается при новом send).
  const [crossVerify, setCrossVerify] = useState<{ result: string; provider: string; ok: boolean } | null>(null)
  const [cvExpanded, setCvExpanded] = useState(false)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])

  function flashWarning(msg: string) {
    setWarning(msg)
    if (warningTimer.current) window.clearTimeout(warningTimer.current)
    warningTimer.current = window.setTimeout(() => setWarning(null), 2500)
  }

  function flashQueueNotice(msg: string) {
    setQueueNotice(msg)
    if (queueNoticeTimer.current) window.clearTimeout(queueNoticeTimer.current)
    queueNoticeTimer.current = window.setTimeout(() => setQueueNotice(null), 5000)
  }

  function flashExportNotice(title: string, detail: string, ok = true) {
    setExportNotice({ title, detail, ok })
    if (exportNoticeTimer.current) window.clearTimeout(exportNoticeTimer.current)
    exportNoticeTimer.current = window.setTimeout(() => setExportNotice(null), 7000)
  }

  function flushPersistedAssistant(sendId: number, kind: 'content' | 'thinking' | 'both' = 'both') {
    const tracked = persistedAssistantBySendIdRef.current.get(sendId)
    if (!tracked) return
    if ((kind === 'content' || kind === 'both') && tracked.content) {
      void window.api.chats.updateMessage(tracked.messageId, tracked.content).catch(() => {})
    }
    if ((kind === 'thinking' || kind === 'both') && tracked.thinking) {
      void window.api.chats.updateThinking(tracked.messageId, tracked.thinking).catch(() => {})
    }
  }

  function schedulePersistedAssistantFlush(sendId: number, kind: 'content' | 'thinking') {
    const tracked = persistedAssistantBySendIdRef.current.get(sendId)
    if (!tracked) return
    if (kind === 'content') {
      if (tracked.timer) window.clearTimeout(tracked.timer)
      tracked.timer = window.setTimeout(() => flushPersistedAssistant(sendId, 'content'), 350)
    } else {
      if (tracked.thinkingTimer) window.clearTimeout(tracked.thinkingTimer)
      tracked.thinkingTimer = window.setTimeout(() => flushPersistedAssistant(sendId, 'thinking'), 350)
    }
  }

  function registerPersistedAssistant(sendId: number, messageId: number) {
    persistedAssistantBySendIdRef.current.set(sendId, {
      messageId,
      content: '',
      thinking: '',
      timer: null,
      thinkingTimer: null,
    })
  }

  function trackPersistedAssistantEvent(sendId: number, event: { type: string; text?: string }) {
    const tracked = persistedAssistantBySendIdRef.current.get(sendId)
    if (!tracked) return
    if (event.type === 'text' && typeof event.text === 'string') {
      tracked.content += event.text
      schedulePersistedAssistantFlush(sendId, 'content')
    } else if (event.type === 'thought' && typeof event.text === 'string') {
      tracked.thinking += event.text
      schedulePersistedAssistantFlush(sendId, 'thinking')
    } else if (event.type === 'done' || event.type === 'error') {
      finishPersistedAssistant(sendId)
    }
  }

  function finishPersistedAssistant(sendId: number) {
    const tracked = persistedAssistantBySendIdRef.current.get(sendId)
    if (!tracked) return
    if (tracked.timer) window.clearTimeout(tracked.timer)
    if (tracked.thinkingTimer) window.clearTimeout(tracked.thinkingTimer)
    flushPersistedAssistant(sendId, 'both')
    persistedAssistantBySendIdRef.current.delete(sendId)
  }

  async function saveHandoffToDownloads() {
    if (activeChatId == null || handoffBusy) return
    setHandoffBusy(true)
    try {
      const result = await window.api.handoff.saveToDownloads(activeChatId)
      if (!result.ok) {
        flashExportNotice('Контекст не сохранён', result.error, false)
        return
      }
      try {
        await navigator.clipboard.writeText(result.markdown)
        flashExportNotice('Контекст для передачи готов', `Файл сохранён: ${result.path}. Текст скопирован в буфер обмена.`)
      } catch {
        flashExportNotice('Контекст для передачи готов', `Файл сохранён: ${result.path}. Буфер обмена недоступен.`)
      }
    } catch (err) {
      flashExportNotice('Контекст не сохранён', err instanceof Error ? err.message : String(err), false)
    } finally {
      setHandoffBusy(false)
    }
  }

  async function exportTranscript() {
    if (activeChatId == null || handoffBusy) return
    setHandoffBusy(true)
    try {
      // 2.0.11-C: безопасный экспорт — путь выбирает пользователь в save-диалоге.
      const result = await window.api.handoff.exportTranscriptSafe(activeChatId)
      if (result.ok) {
        flashExportNotice('Экспорт чата готов', `Полная история сохранена: ${result.path}.`)
      } else if ('cancelled' in result) {
        // Человек передумал — это НЕ ошибка, молча выходим (карточка C).
      } else {
        flashExportNotice('Экспорт чата не сохранён', result.error, false)
      }
    } catch (err) {
      flashExportNotice('Экспорт чата не сохранён', err instanceof Error ? err.message : String(err), false)
    } finally {
      setHandoffBusy(false)
    }
  }

  const hasImageAttachments = attachments.some(a => isImageAttachment(a.mimeType))
  const showVisionBanner = hasImageAttachments
    && !providerSupportsVision(provider.id)
    && !visionBannerDismissed

  useEffect(() => {
    if (!composerSettingsOpen) return
    function onPointerDown(e: PointerEvent) {
      if (composerSettingsRef.current?.contains(e.target as Node)) return
      setComposerSettingsOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setComposerSettingsOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [composerSettingsOpen])

  useEffect(() => {
    if (!hasImageAttachments) setVisionBannerDismissed(false)
  }, [hasImageAttachments])

  useEffect(() => {
    if (providerSupportsVision(provider.id)) setVisionBannerDismissed(true)
  }, [provider.id])

  async function switchVisionModel(nextProviderId: ProviderId, model: string) {
    await provider.setProviderModel(nextProviderId, model)
    await provider.setProviderId(nextProviderId)
    if (activeChatId != null) {
      try {
        await window.api.chatSessions.setModel(activeChatId, nextProviderId, model)
        await useProject.getState().refreshChatSessions()
      } catch { /* don't block UX */ }
    }
    setVisionBannerDismissed(true)
  }

  async function addBlobs(blobs: Array<{ blob: Blob; nameHint: string }>) {
    const added: Attachment[] = []
    for (const { blob, nameHint } of blobs) {
      if (attachments.length + added.length >= MAX_ATTACHMENTS) {
        flashWarning(`Можно прикрепить максимум ${MAX_ATTACHMENTS} файлов`)
        break
      }
      if (isLegacyDoc(nameHint)) {
        flashWarning(`${nameHint}: старый .doc не поддерживается — сохраните как .docx`)
        continue
      }
      if (blob.size > MAX_BYTES_PER_FILE) {
        flashWarning(`${nameHint}: больше ${formatSize(MAX_BYTES_PER_FILE)}, пропущен`)
        continue
      }
      const att = await blobToAttachment(blob, nameHint, MAX_BYTES_PER_FILE)
      if (!att) {
        flashWarning(`${nameHint}: формат не поддерживается, пропущен`)
        continue
      }
      added.push(att)
    }
    if (added.length > 0) setAttachments(prev => [...prev, ...added])
  }

  useEffect(() => {
    const off = window.api.ai.onEvent(({ id, event, projectPath }) => {
      trackPersistedAssistantEvent(id, event as { type: string; text?: string })
      const store = useProject.getState()
      // Routing через единый sendOwners реестр (был двойной мап:
      // sendIdToChatId + sendIdToReviewChatId — давало race-баги).
      // Owner определяет КУДА события идут:
      //  - 'review' → reviews state, не трогает main чат
      //  - 'chat' → если не активный, в chatSnapshots; если активный, в
      //             основное состояние ниже по логике
      const owner = store.lookupSendOwner(id)
      if (owner?.kind === 'chat' && owner.isHelp) {
        store.applyEventToHelp(event as { type: string; [k: string]: unknown })
        if (event.type === 'done' || event.type === 'error') {
          notifyAgentFinished(owner, null, event.type === 'error')
          clearPendingSupplementsForScope(pendingScopeKeyFor(owner))
          store.forgetSendOwner(id)
          if (store.helpMode) {
            setHelpStreaming(false)
            if (currentSendIdRef.current === id) currentSendIdRef.current = null
          }
          void flushQueuedForOwner(owner)
        }
        return
      }
      if (owner?.kind === 'review') {
        const reviewChatId = owner.reviewChatId
        if (event.type === 'text' && typeof (event as { text?: string }).text === 'string') {
          store.appendReviewContent(reviewChatId, (event as { text: string }).text)
        } else if (event.type === 'done') {
          store.finalizeReview(reviewChatId)
          store.forgetSendOwner(id)
        } else if (event.type === 'error') {
          const msg = (event as { message?: string }).message ?? 'review failed'
          store.failReview(reviewChatId, msg)
          store.forgetSendOwner(id)
        }
        // Игнорируем все остальные event types для ревью (thought / usage /
        // tool-* — ревьюер работает в plain mode, тулзов не должно быть, а
        // thoughts нам в pill не нужны).
        return
      }
      const chatOwnerProjectPath = owner?.kind === 'chat' && !owner.isHelp
        ? (projectPath || owner.projectPath || null)
        : null
      if (
        owner?.kind === 'chat'
        && !owner.isHelp
        && chatOwnerProjectPath
        && event.type !== 'plan-approval'
        && (!store.path || normalizeProjectPath(chatOwnerProjectPath) !== normalizeProjectPath(store.path))
      ) {
        const routedEvent = {
          ...(event as unknown as { type: string; [k: string]: unknown }),
          projectPath: chatOwnerProjectPath,
          chatId: owner.chatId,
          persistedByChat: true
        }
        store.applyEventToSession(chatOwnerProjectPath, routedEvent)
        if (event.type === 'done') {
          notifyAgentFinished(owner, chatOwnerProjectPath)
        } else if (event.type === 'error') {
          notifyAgentFinished(owner, chatOwnerProjectPath, true)
        }
        if ((event.type === 'done' || event.type === 'error') && store.pendingPlan?.sendId === id) {
          store.setPendingPlan(null)
        }
        if (event.type === 'done' || event.type === 'error') {
          clearPendingSupplementsForScope(pendingScopeKeyFor(owner))
          store.forgetSendOwner(id)
          if (currentSendIdRef.current === id) currentSendIdRef.current = null
          void flushQueuedForOwner(owner)
        }
        return
      }
      // Route background-project events to the snapshot store so they don't
      // mutate the currently-visible session. НО: события чат-owner'а (даже при смене
      // проекта) НЕ сюда — иначе они (а) прилипали к чужому чату и (б) НЕ персистились
      // в БД (applyEventToSession не пишет chats.append) → тихая потеря ответа при reload
      // (ревью HIGH). Chat-owner всегда идёт в applyEventToChat ниже (персист по sessionId).
      if (projectPath && projectPath !== store.path && owner?.kind !== 'chat') {
        store.applyEventToSession(projectPath, event as unknown as { type: string; [k: string]: unknown })
        // sendOwners leak fix: stream завершается → удаляем owner, иначе
        // мапа растёт при каждом переключении проекта во время активного
        // стрима в фоне.
        if (event.type === 'done') {
          notifyAgentFinished(owner, projectPath)
        } else if (event.type === 'error') {
          notifyAgentFinished(owner, projectPath, true)
        }
        if (event.type === 'done' || event.type === 'error') {
          clearPendingSupplementsForScope(pendingScopeKeyFor(owner))
          store.forgetSendOwner(id)
          void flushQueuedForOwner(owner)
        }
        return
      }
      // #3 plan-gate: блокирующий plan-approval показываем ГЛОБАЛЬНО (модалка), даже
      // если прогон в фоновом чате — иначе агент висит в await навсегда (нет UI для
      // resolve → тихий дедлок). Решение маршрутизируется по sendId в нужный прогон.
      if (event.type === 'plan-approval') {
        store.setPendingPlan({ callId: event.callId, title: String(event.title ?? 'План'), stepCount: Number(event.stepCount ?? 0), sendId: id })
        return
      }
      // #3 plan-gate: прогон завершился/упал (gate был сдренен в main как reject) —
      // снимаем модалку плана, чтобы не висела ghost поверх завершённого прогона.
      if ((event.type === 'done' || event.type === 'error') && store.pendingPlan?.sendId === id) {
        store.setPendingPlan(null)
      }
      // Фоновый чат: другая ветка, экран справки ИЛИ другой проект (стрим начатый до
      // смены проекта). Персистим в БД по sessionId (applyEventToChat), атрибутируем
      // уведомление реальному проекту чата (projectPath), а не текущему store.path.
      if (
        owner?.kind === 'chat'
        && !owner.isHelp
        && (store.helpMode || owner.chatId !== store.activeChatId || (projectPath && projectPath !== store.path))
      ) {
        const chatProject = projectPath || owner.projectPath || store.path
        const routedEvent = {
          ...(event as unknown as { type: string; [k: string]: unknown }),
          ...(chatProject ? { projectPath: chatProject } : {}),
          chatId: owner.chatId,
          persistedByChat: true
        }
        store.applyEventToChat(owner.chatId, routedEvent)
        if (store.helpMode && chatProject) {
          store.applyEventToSession(chatProject, routedEvent)
        }
        if (event.type === 'done') {
          notifyAgentFinished(owner, chatProject)
        } else if (event.type === 'error') {
          notifyAgentFinished(owner, chatProject, true)
        }
        if (event.type === 'done' || event.type === 'error') {
          clearPendingSupplementsForScope(pendingScopeKeyFor(owner))
          store.forgetSendOwner(id)
          void flushQueuedForOwner(owner)
        }
        return
      }
      // Owner забыт (stop() или send уже завершён) → это трейлинг/устаревшее
      // событие. НЕ роутим его в активный чат: иначе done после stop() гасил бы
      // новый стрим активного чата (#17). registerSendOwner ставится синхронно
      // до событий, так что у живого активного send'а owner всегда есть.
      if (!owner) return
      store.applyAgentProgressEvent(event as unknown as { type: string; [k: string]: unknown })
      if (event.type === 'text') updateLastAssistant(event.text)
      else if (event.type === 'thought') store.appendLastAssistantThinking(event.text)
      else if (event.type === 'pending-write') {
        store.addPendingWrite({
          callId: event.callId,
          path: event.path,
          before: event.before,
          after: event.after,
          sendId: id  // pass through for strict resolve lookup in main
        })
        store.pushActivity({
          id: event.callId,
          kind: 'write',
          label: 'write_file',
          detail: event.path,
          status: 'pending',
          timestamp: Date.now()
        })
        // Tools emit project-relative paths; tree keys by abs (toProjectAbsPath).
        if (event.path && store.path) {
          store.markFileTouched(toProjectAbsPath(store.path, event.path), 'write')
        }
      }
      else if (event.type === 'pending-command') {
        store.setPendingCommand({ callId: event.callId, command: event.command, sendId: id })
        store.pushActivity({
          id: event.callId,
          kind: 'command',
          label: 'run_command',
          detail: event.command,
          status: 'pending',
          timestamp: Date.now()
        })
      }
      else if (event.type === 'command-result') {
        // Снять модалку CommandConfirm, если команда зарезолвлена НЕ кликом по модалке,
        // а извне (Stop/таймаут/ошибка) — иначе висит ghost-бэкдроп на завершённую
        // команду (ревью 24.06; фоновые чаты уже покрыты applySnapshotEvent).
        if (store.pendingCommand?.callId === event.callId) store.setPendingCommand(null)
        const status: 'ok' | 'error' | 'rejected' = event.status
        store.updateActivity(event.callId, {
          status,
          detail: status === 'error' ? event.error ?? event.command : event.command
        })
        // persist to project journal
        if (store.path && status === 'ok') {
          void window.api.journal.append(store.path, 'tool', `Команда: ${event.command}`,
            event.stdout ? event.stdout.slice(0, 500) : null)
        } else if (store.path && status === 'error') {
          void window.api.journal.append(store.path, 'tool', `Команда упала: ${event.command}`,
            event.error ?? null)
        }
      }
      else if (event.type === 'tool-activity') {
        // Read-only / pure-info tool just ran — show in activity stream
        const kind: 'read' | 'list' | 'command' = (event.name === 'read_file' || event.name === 'browser_read_page' || event.name === 'connector_query')
          ? 'read'
          : (event.name === 'list_directory' || event.name === 'list_connectors' || event.name === 'find_files' || event.name === 'search_project')
            ? 'list'
            : 'command'
        store.pushActivity({
          id: `${event.callId}-${event.name}`,
          kind,
          label: event.label,
          detail: event.detail,
          status: event.status,
          timestamp: Date.now()
        })
        // Tag the file in the Sidebar tree so the user sees where the AI
        // looked. Tools emit project-relative paths; the Sidebar tree keys
        // by absolute paths — so we join with the active project root.
        if (event.status === 'ok' && event.detail && store.path) {
          const rel = event.detail.split(' · ')[0]?.trim()
          if (rel) {
            const abs = toProjectAbsPath(store.path, rel)
            if (event.name === 'read_file') store.markFileTouched(abs, 'read')
            else if (event.name === 'list_directory') store.markFileTouched(abs, 'list')
          }
        }
        // Persist read-only tool calls to Journal too — это превращает
        // Journal в реальный audit trail 'что AI делал у меня в проекте'.
        // Безопасник/тимлид может выгрузить и посмотреть.
        // НЕ журналим browser_screenshot (data URL раздует журнал) и
        // успешные get_project_map/refresh_project_map (структура проекта
        // не интересна как individual event — она в session summary).
        if (store.path
            && event.status === 'ok'
            && event.name !== 'browser_screenshot'
            && event.name !== 'get_project_map'
            && event.name !== 'refresh_project_map') {
          void window.api.journal.append(store.path, 'tool', event.label,
            event.detail ? event.detail.slice(0, 300) : null)
        }
      }
      else if (event.type === 'artifact-created') {
        store.recordArtifact({
          kind: event.kind,
          filename: event.filename,
          path: event.path,
          sizeBytes: event.sizeBytes
        })
        if (store.path) {
          void window.api.journal.append(store.path, 'tool',
            `📄 Артефакт ${event.kind.toUpperCase()}: ${event.filename}`,
            `${event.path} (${event.sizeBytes} bytes)`)
        }
      }
      else if (event.type === 'verification-attested') {
        // DoD-бейдж прикрепляем к последнему verification-артефакту (artifact-created
        // пришёл синхронно перед этим событием). Pill окрасится по overall.
        store.setVerificationBadge({
          overall: event.overall,
          checksPassed: event.checksPassed,
          checksTotal: event.checksTotal
        })
      }
      else if (event.type === 'turns-exhausted') {
        // Budget hit. Remember so the UI can offer a "+N turns" button.
        if (event.canContinue) {
          setExhausted({ used: event.used, suggestedAdd: event.suggestedAdd, maxBudget: event.maxBudget })
        }
        store.pushActivity({
          id: `budget-${Date.now()}`,
          kind: 'blocked',
          label: `Бюджет ${event.used} ходов исчерпан`,
          detail: event.canContinue ? `Доступно +${event.suggestedAdd} (макс ${event.maxBudget})` : 'Достигнут потолок',
          status: 'blocked',
          timestamp: Date.now()
        })
      }
      else if (event.type === 'tool-blocked') {
        store.pushActivity({
          id: event.callId,
          kind: 'blocked',
          label: event.name + ' заблокирован',
          detail: `${event.command ?? ''} — ${event.reason}`,
          status: 'blocked',
          timestamp: Date.now()
        })
        if (store.path) {
          void window.api.journal.append(store.path, 'tool', `Заблокировано: ${event.command ?? event.name}`, event.reason)
        }
      }
      else if (event.type === 'info') {
        store.pushActivity({
          id: `info-${Date.now()}`,
          kind: 'read',
          label: event.text,
          detail: '',
          status: 'ok',
          timestamp: Date.now()
        })
      }
      else if (event.type === 'usage') {
        store.addUsage({
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          cachedInputTokens: event.usage.cachedInputTokens,
          // 2.0.8-E хвост: без семантики ценник считал по 'inclusive' и вычитал кэш
          // из input у Claude (exclusive) → занижал стоимость на больших cache-hit.
          inputAccounting: event.usage.inputAccounting
        })
      }
      else if (event.type === 'plan-created') {
        store.pushActivity({
          id: `plan-${event.planId}`,
          kind: 'write',
          label: `📋 План: ${event.title}`,
          detail: `${event.stepCount} шагов — открой вкладку Plan`,
          status: 'ok',
          timestamp: Date.now()
        })
        if (store.path) {
          void window.api.journal.append(store.path, 'tool',
            `Создан план: ${event.title}`,
            `${event.stepCount} шагов`)
        }
        // Pipeline (спек D5): план создан во время Plan-шага → привязываем planId
        // к активному прогону (шаг не двигаем — это сделает «План OK» в баннере).
        if (store.activePipeline?.step === 'plan') {
          void store.advancePipeline({ planId: event.planId })
        }
      }
      else if (event.type === 'preflight') {
        store.pushPreflight({
          callId: event.callId,
          summary: event.summary,
          affectedZones: event.affectedZones,
          risk: event.risk,
          riskReason: event.riskReason,
          verifyAfter: event.verifyAfter,
          outOfScope: event.outOfScope
        })
      }
      else if (event.type === 'subagent-run') {
        store.upsertSubagentRun({
          callId: event.callId,
          label: event.label,
          provider: event.provider,
          skill: event.skill,
          task: event.task,
          status: event.status,
          result: event.result,
          role: event.role,
          toolCount: event.toolCount
        })
      }
      else if (event.type === 'cross-verify') {
        // Результат авто-кросс-верификации — показываем pill под ответом агента
        setCrossVerify({ result: event.result, provider: event.provider, ok: event.ok })
        setCvExpanded(false)
      }
      else if (event.type === 'done') {
        const path = store.path
        const activeChatId = store.activeChatId
        const msgs = store.messages
        const lastAssistant = msgs[msgs.length - 1]
        if (path && activeChatId && lastAssistant?.role === 'assistant' && lastAssistant.content) {
          void window.api.chats.append(activeChatId, path, 'assistant', lastAssistant.content)
        }
        // If we were running a plan step, finalize it
        const running = store.runningPlanStep
        if (running) {
          const result = lastAssistant?.role === 'assistant' ? (lastAssistant.content || '') : ''
          void window.api.plans.updateStep(running.stepId, {
            status: 'done',
            result: result.length > 2000 ? result.slice(0, 2000) + '…' : result
          })
          store.setRunningPlanStep(null)
        }
        const pendingPipelineStep = pipelineAutoSendStepRef.current
        if (pendingPipelineStep === 'plan' || pendingPipelineStep === 'execute') {
          pipelineAutoSendStepRef.current = null
        }
        if (pendingPipelineStep === 'execute') {
          const execSendId = pipelineExecuteSendIdRef.current
          pipelineExecuteSendIdRef.current = null
          void finalizePipelineExecute(store, execSendId)
        }
        store.finalizeActiveStreamDuration()
        setStreaming(false)
        setPendingSupplements([])
        setPendingBarExpanded(false)
        if (currentSendIdRef.current === id) currentSendIdRef.current = null
        store.forgetSendOwner(id)
        notifyAgentFinished(owner, store.path)
        void flushQueuedForOwner(owner)
      }
      else if (event.type === 'error') {
        // If a plan step was running, mark it failed
        const running = store.runningPlanStep
        if (running) {
          void window.api.plans.updateStep(running.stepId, {
            status: 'failed',
            result: 'message' in event ? event.message : 'Ошибка выполнения'
          })
          store.setRunningPlanStep(null)
        }
        updateLastAssistant(`\n\n[Ошибка: ${event.message}]`)
        // Persist the error in the journal — otherwise you lose context once
        // you close the chat and can't tell why the answer failed.
        if (store.path) {
          void window.api.journal.append(store.path, 'note', 'AI-ошибка',
            ('message' in event ? event.message : '').slice(0, 600))
        }
        if (pipelineAutoSendStepRef.current === 'plan' || pipelineAutoSendStepRef.current === 'execute') {
          pipelineAutoSendStepRef.current = null
          pipelineExecuteSendIdRef.current = null
        }
        store.finalizeActiveStreamDuration()
        setStreaming(false)
        setPendingSupplements([])
        setPendingBarExpanded(false)
        if (currentSendIdRef.current === id) currentSendIdRef.current = null
        store.forgetSendOwner(id)
        notifyAgentFinished(owner, store.path, true)
        void flushQueuedForOwner(owner)
      }
    })
    return off
  }, [updateLastAssistant, setStreaming])

  useEffect(() => {
    autoScrollEnabledRef.current = autoScrollEnabled
  }, [autoScrollEnabled])

  const SCROLL_STICK_THRESHOLD = 72

  function isNearBottom(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_STICK_THRESHOLD
  }

  function refreshVisibleDateLabel() {
    const el = streamRef.current
    if (!el || messages.length === 0) {
      visibleDateLabelRef.current = null
      setVisibleDateLabel(null)
      return
    }
    const streamRect = el.getBoundingClientRect()
    const targetY = streamRect.top + 34
    const nodes = Array.from(el.querySelectorAll<HTMLElement>('.gg-msg[data-message-date-label]'))
    let nextLabel: string | null = null
    for (const node of nodes) {
      const rect = node.getBoundingClientRect()
      if (rect.bottom >= targetY && rect.top <= streamRect.bottom) {
        nextLabel = node.dataset.messageDateLabel ?? null
        break
      }
      if (rect.top < targetY) {
        nextLabel = node.dataset.messageDateLabel ?? nextLabel
      }
    }
    if (nextLabel !== visibleDateLabelRef.current) {
      visibleDateLabelRef.current = nextLabel
      setVisibleDateLabel(nextLabel)
    }
  }

  function scheduleVisibleDateRefresh() {
    if (visibleDateRafRef.current != null) return
    visibleDateRafRef.current = window.requestAnimationFrame(() => {
      visibleDateRafRef.current = null
      refreshVisibleDateLabel()
    })
  }

  function applyScrollToBottom(behavior: ScrollBehavior = 'auto') {
    const el = streamRef.current
    if (!el) return
    if (behavior === 'smooth') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    } else {
      el.scrollTop = el.scrollHeight
    }
  }

  /** После commit React — иначе scrollHeight ещё старый. */
  function pinChatToBottom(behavior: ScrollBehavior = 'auto') {
    stickToBottomRef.current = true
    setShowScrollDown(false)
    applyScrollToBottom(behavior)
    requestAnimationFrame(() => {
      applyScrollToBottom(behavior)
      requestAnimationFrame(() => applyScrollToBottom(behavior))
    })
  }

  function armAutoScrollForOutgoing() {
    if (!autoScrollEnabledRef.current) return
    stickToBottomRef.current = true
    pendingPinToBottomRef.current = true
    setShowScrollDown(false)
  }

  function scrollChatToBottom(behavior: ScrollBehavior = 'smooth') {
    if (autoScrollEnabledRef.current) stickToBottomRef.current = true
    setShowScrollDown(false)
    pinChatToBottom(behavior)
  }

  function handleAgentProgressToggle() {
    if (!autoScrollEnabledRef.current) return
    requestAnimationFrame(() => {
      pinChatToBottom('smooth')
      requestAnimationFrame(() => pinChatToBottom('smooth'))
    })
  }

  function toggleAutoScroll() {
    setAutoScrollEnabled(prev => {
      const next = !prev
      try { localStorage.setItem(CHAT_AUTO_SCROLL_KEY, next ? '1' : '0') } catch { /* ignore */ }
      if (!next) {
        stickToBottomRef.current = false
      } else {
        const el = streamRef.current
        stickToBottomRef.current = el ? isNearBottom(el) : true
      }
      return next
    })
  }

  useEffect(() => {
    if (autoScrollEnabled) {
      stickToBottomRef.current = true
      setShowScrollDown(false)
      const el = streamRef.current
      if (el) el.scrollTop = el.scrollHeight
    } else {
      stickToBottomRef.current = false
    }
  }, [activeChatId, activePath, autoScrollEnabled])

  useEffect(() => {
    if (!autoScrollEnabled) return
    if (pendingPinToBottomRef.current || stickToBottomRef.current) {
      pendingPinToBottomRef.current = false
      pinChatToBottom('auto')
    } else {
      setShowScrollDown(messages.length > 0)
    }
  }, [messages, autoScrollEnabled])

  const animatedAssistantShownLength = animatedAssistantText?.shown.length ?? 0
  useEffect(() => {
    if (!autoScrollEnabled || animatedAssistantShownLength <= 0) return
    if (pendingPinToBottomRef.current || stickToBottomRef.current) {
      pendingPinToBottomRef.current = false
      pinChatToBottom('auto')
    } else {
      setShowScrollDown(true)
    }
  }, [animatedAssistantShownLength, autoScrollEnabled])

  useEffect(() => {
    const el = streamRef.current
    if (!el) return
    function onScroll() {
      if (!el) return
      scheduleVisibleDateRefresh()
      const atBottom = isNearBottom(el)
      if (pendingPinToBottomRef.current) {
        if (!atBottom) pendingPinToBottomRef.current = false
        setShowScrollDown(!atBottom && messages.length > 0)
        return
      }
      if (autoScrollEnabled) stickToBottomRef.current = atBottom
      setShowScrollDown(!atBottom && messages.length > 0)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (visibleDateRafRef.current != null) {
        window.cancelAnimationFrame(visibleDateRafRef.current)
        visibleDateRafRef.current = null
      }
    }
  }, [messages.length, autoScrollEnabled])

  useEffect(() => {
    scheduleVisibleDateRefresh()
    if (messages.length === 0 && visibleDateLabelRef.current != null) {
      visibleDateLabelRef.current = null
      setVisibleDateLabel(null)
    }
  }, [messages.length])

  // Refresh undo count when project changes / after each assistant turn settles
  useEffect(() => {
    const path = useProject.getState().path
    if (!path) { setUndoCount(0); return }
    void window.api.undo.count(path).then(setUndoCount)
  }, [messages.length])

  // Ре-ревью honesty #4: undo-стек ключуется по ГЛАВНОМУ проекту, а изолированный чат
  // пишет в worktree. Кнопка ↩ здесь откатила бы чужую правку (параллельного чата) в
  // реальном проекте и отрапортовала успехом. В изоляции откат — только «✕ Отбросить»
  // (WorktreeBar), поэтому кнопку в изолированном чате прячем.
  const [chatIsolated, setChatIsolated] = useState(false)
  useEffect(() => {
    if (helpMode || activeChatId == null) { setChatIsolated(false); return }
    let cancelled = false
    void window.api.worktree.status(activeChatId)
      .then(s => { if (!cancelled) setChatIsolated(!!s?.active) })
      .catch(() => { if (!cancelled) setChatIsolated(false) })
    return () => { cancelled = true }
  }, [activeChatId, helpMode, isStreaming, messages.length])

  async function revertLastWrite() {
    const path = useProject.getState().path
    if (!path) return
    const result = await window.api.undo.revert(path)
    if (result.ok) {
      // Refresh file tree so sidebar shows the restored state
      const tree = await window.api.files.tree(path)
      useProject.setState({ tree })
      useProject.getState().pushActivity({
        id: `undo-${Date.now()}`,
        kind: 'write',
        label: 'undo write_file',
        detail: result.filePath,
        status: 'ok',
        timestamp: Date.now()
      })
      const newCount = await window.api.undo.count(path)
      setUndoCount(newCount)
    }
  }

  // Dev Task Flow (Фаза 2): открыть задачу из preflight-плана. Мягкое действие
  // по клику (НЕ авто-создание): main снимет checkpoint + зафиксирует git-базу,
  // store делает задачу активной и открывает вкладку «Задача».
  async function openTaskFromPreflight(pf: PreflightCard) {
    const store = useProject.getState()
    if (!store.path) return
    try {
      const task = await window.api.devtask.openFromPreflight({
        chatId: store.activeChatId,
        preflight: {
          summary: pf.summary,
          risk: pf.risk,
          riskReason: pf.riskReason,
          affectedZones: pf.affectedZones
        }
      })
      if (task) store.openDevTask(task)
    } catch { /* IPC недоступен в dev — тихо игнорируем */ }
  }

  // Auto-grow textarea
  function autoGrow() {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const nextHeight = Math.min(ta.scrollHeight, 220)
    ta.style.height = `${nextHeight}px`
    if (nextHeight !== lastComposerHeightRef.current) {
      lastComposerHeightRef.current = nextHeight
    }
  }
  useEffect(autoGrow, [input])

  // Composer должен быть готов к вводу сразу после открытия проекта/чата,
  // не дожидаясь гидратации тяжёлой истории из SQLite.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activePath, activeChatId])

  // Sidecar Terminal Intelligence inject — TerminalErrorToast диспатчит
  // CustomEvent('gg-inject-prompt') когда юзер жмёт «Fix in chat».
  useEffect(() => {
    function onInject(e: Event) {
      const ev = e as CustomEvent<string>
      if (typeof ev.detail === 'string') {
        setInput(ev.detail)
        textareaRef.current?.focus()
      }
    }
    window.addEventListener('gg-inject-prompt', onInject)
    return () => window.removeEventListener('gg-inject-prompt', onInject)
  }, [])

  // Crash-resume dispatches an internal prompt directly to the model. It must not
  // create a visible user bubble or reuse the normal composer auto-send path.
  useEffect(() => {
    function onResume(e: Event) {
      // detail: либо строка (legacy — AgentRunsPanel/PipelineBanner), либо объект
      // { text, resumeFromRunId } (ResumeBanner Фаза 2 — re-send с полным контекстом).
      const ev = e as CustomEvent<string | { text: string; resumeFromRunId?: string }>
      const d = ev.detail
      const text = typeof d === 'string' ? d : d?.text
      const resumeRunId = typeof d === 'string' ? null : (d?.resumeFromRunId ?? null)
      if (typeof text === 'string' && text.trim()) {
        setInput(text)
        resumeFromRunIdRef.current = resumeRunId
        resumeAutoSendRef.current = true
      }
    }
    window.addEventListener('gg-resume-send', onResume)
    return () => window.removeEventListener('gg-resume-send', onResume)
  }, [])

  // Pipeline auto-send (спек D5): PipelineBanner/визард диспатчат
  // CustomEvent('gg-pipeline-send', { text, mode }). Ставим режим + текст и
  // взводим ref; авто-send ниже ждёт, пока agentMode реально станет нужным.
  useEffect(() => {
    function onPipelineSend(e: Event) {
      const ev = e as CustomEvent<{ text: string; mode: 'plan' | 'accept-edits' }>
      const d = ev.detail
      if (d && typeof d.text === 'string' && d.text.trim()) {
        void setAgentMode(d.mode)
        setInput(d.text)
        pipelineSendModeRef.current = d.mode
      }
    }
    window.addEventListener('gg-pipeline-send', onPipelineSend)
    return () => window.removeEventListener('gg-pipeline-send', onPipelineSend)
  }, [setAgentMode])

  // First Win (спек D10): онбординг ставит флаг «попробовать Pipeline» —
  // на маунте открываем визард с демо-брифом (race-free через settings, не
  // зависим от того, смонтирован ли Chat в момент закрытия онбординга).
  useEffect(() => {
    void window.api.settings.getKey('pipeline_sample_pending').then(v => {
      if (v === '1') {
        void window.api.settings.setKey('pipeline_sample_pending', '')
        setPipelineInitialBrief(SAMPLE_BRIEF)
        setPipelineWizardMode('agency')
        setPipelineWizardOpen(true)
      }
    })
  }, [])

  // Pipeline-оркестрация (спек D5): запуск из визарда → активируем прогон + шлём
  // Plan-промпт; «План OK» в баннере → двигаем шаг + шлём Execute-промпт.
  function dispatchPipelineSend(step: PipelineStep, brief: PipelineRun['brief'], planId: number | null) {
    const mode = useProject.getState().activePipeline?.mode ?? 'dev'
    const params = buildPipelineSend(step, brief, planId, { requireReviewGate: mode === 'agency' })
    if (!params) return
    if (step === 'plan' || step === 'execute') pipelineAutoSendStepRef.current = step
    window.dispatchEvent(new CustomEvent('gg-pipeline-send', { detail: params }))
  }

  async function finalizePipelineExecute(store: ReturnType<typeof useProject.getState>, sendId: number | null) {
    const pipeline = store.activePipeline
    if (!pipeline || pipeline.step !== 'execute' || !store.path) return
    try {
      const runs = await window.api.agentRuns.list(store.path, { limit: 10 })
      const runId = resolvePipelineRunId(
        pipeline.agentRunId,
        sendId,
        pipeline.chatId ?? store.activeChatId,
        runs,
      )
      await store.advancePipeline({ step: 'verify', agentRunId: runId })
    } catch { /* best-effort */ }
  }
  function onPipelineStarted(run: PipelineRun) {
    useProject.getState().startPipeline(run)
    dispatchPipelineSend('plan', run.brief, run.planId)
  }
  async function onPipelinePrimary(step: PipelineStep) {
    const store = useProject.getState()
    const pipeline = store.activePipeline
    if (!pipeline) return
    if (step === 'plan') {
      void store.advancePipeline({ step: 'execute' })
      dispatchPipelineSend('execute', pipeline.brief, pipeline.planId)
    } else if (step === 'execute') {
      void store.advancePipeline({ step: 'verify' })  // Verify-панель — D6
    } else if (step === 'verify') {
      // Ядро надёжности v3 (Шаг A): модель НЕ вправе сказать «готово» — решает
      // verify. pass → proof; провал → авто-возврат на execute (само-починка);
      // лимит попыток → честный стоп 'blocked', а не тихое 'completed'.
      const v = pipeline.agentRunId
        ? await window.api.verifications.latestByRunId(pipeline.projectPath, pipeline.agentRunId).catch(() => null)
        : await window.api.verifications.latest(pipeline.projectPath, pipeline.chatId ?? null).catch(() => null)
      const outcome: VerifyOutcome =
        v == null || v.overall === 'not_run' ? 'unknown'
          : v.overall === 'passed' ? 'pass' : 'fail'
      const thisAttempt = pipeline.verifyAttempts + 1
      const decision = decidePipelineGate(outcome, thisAttempt)
      if (decision.action === 'proof') {
        void store.advancePipeline({ step: pipeline.mode === 'agency' ? 'review' : 'proof' })
      } else if (decision.action === 'retry') {
        // Авто-починка: назад на execute (счётчик попытки) + повторный Execute-промпт.
        await store.advancePipeline({ step: 'execute', verifyAttempts: thisAttempt })
        dispatchPipelineSend('execute', pipeline.brief, pipeline.planId)
      } else {
        void store.advancePipeline({ step: 'blocked' }) // честный стоп
      }
    } else if (step === 'review') {
      const runs = await window.api.agentRuns.list(pipeline.projectPath, { limit: 10 })
      const candidateRunIds = resolveReviewCandidateRunIds(pipeline.agentRunId, pipeline.chatId, runs)
      for (const runId of candidateRunIds) {
        const detail = await window.api.agentRuns.get(runId).catch(() => null)
        const gate = reviewGateState(detail?.events ?? [])
        if (gate.state === 'passed') {
          void store.advancePipeline({ step: 'proof', agentRunId: pipeline.agentRunId ?? runId })
          return
        }
      }
      window.dispatchEvent(new CustomEvent('gg-resume-send', {
        detail: 'Вызови review_before_commit перед финальным ответом. Передай task_brief и verify_commands из DoD; продолжать к Proof Pack можно только после "REVIEW GATE: ПРОЙДЕНО".',
      }))
    } else if (step === 'proof') {
      // Собрать Proof Pack: нужен точный runId. Без него не завершаем pipeline,
      // иначе можно получить красивый Proof по чужому/случайному прогону.
      const runs = pipeline.agentRunId ? [] : await window.api.agentRuns.list(pipeline.projectPath, { limit: 5 })
      const runId = resolveProofRunId(pipeline.agentRunId, pipeline.chatId, runs)
      if (!runId) {
        void store.advancePipeline({ step: 'blocked' })
        return
      }
      try {
        const res = await window.api.proof.generate(runId)
        if (!res.ok || !res.htmlPath) {
          void store.advancePipeline({ step: 'blocked' })
          return
        }
        store.recordArtifact({ kind: 'html', filename: 'proof.html', path: res.htmlPath, sizeBytes: 0 })
        store.setPreviewArtifact(res.htmlPath)
      } catch {
        void store.advancePipeline({ step: 'blocked' })
        return
      }
      void store.advancePipeline({ step: 'completed' })
    }
  }

  // Автоотправка после resume: когда input обновился из gg-resume-send и взведён
  // флаг — шлём ровно как при ручной отправке (через send()). Флаг гасим сразу,
  // чтобы обычный ввод пользователя не уезжал в авто-send.
  useEffect(() => {
    if (
      pipelineSendModeRef.current && input.trim() && !isStreaming
      && agentMode === pipelineSendModeRef.current
    ) {
      // Pipeline-send: ждём пока agentMode применился к нужному режиму, потом шлём.
      pipelineSendModeRef.current = null
      void send()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, isStreaming, agentMode])

  // Автоотправка после resume (ревью-фикс): resumeAutoSendRef взводится в onResume
  // (gg-resume-send из ResumeBanner/AgentRunsPanel), но раньше НИКЕМ не читался —
  // input заполнялся, а send не срабатывал (юзер жал Enter сам). Читаем флаг:
  // как только input появился и не стримим — шлём через send() (он подхватит
  // resumeFromRunIdRef). Флаг гасим сразу, чтобы обычный ввод не уезжал в авто-send.
  useEffect(() => {
    if (resumeAutoSendRef.current && input.trim() && !isStreaming) {
      resumeAutoSendRef.current = false
      void send()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, isStreaming])

  // Cleanup warning / queue notice timers on unmount
  useEffect(() => () => {
    if (warningTimer.current) window.clearTimeout(warningTimer.current)
    if (queueNoticeTimer.current) window.clearTimeout(queueNoticeTimer.current)
    if (exportNoticeTimer.current) window.clearTimeout(exportNoticeTimer.current)
    if (contextCompactTimer.current) window.clearTimeout(contextCompactTimer.current)
    for (const [sendId] of persistedAssistantBySendIdRef.current) {
      finishPersistedAssistant(sendId)
    }
  }, [])

  // Keep the live preview cheap while typing. Exact provider-side token counts
  // can touch project context and message history, so they do not belong in the
  // composer hot path.
  useEffect(() => {
    const text = input.trim()
    if (!text) { setPreviewTokens(null); return }
    const timer = window.setTimeout(() => {
      setPreviewTokens({ tokens: Math.max(1, Math.ceil(text.length / 4)), exact: false })
    }, 120)
    return () => window.clearTimeout(timer)
  }, [input])

  // Proactive suggestions — загружаем при открытии проекта / смене чата
  useEffect(() => {
    if (!activePath || messages.length > 0) { setSuggestions([]); return }
    void window.api.suggestions.get(activePath).then(setSuggestions).catch(() => setSuggestions([]))
  }, [activePath, activeChatId, messages.length])

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items
    if (!items) return
    const blobs: Array<{ blob: Blob; nameHint: string }> = []
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) {
          const ext = (file.type.split('/')[1] ?? 'bin').replace('jpeg', 'jpg')
          const name = file.name && file.name !== 'image.png'
            ? file.name
            : `Скриншот ${++screenshotCounter.current}.${ext}`
          blobs.push({ blob: file, nameHint: name })
        }
      }
    }
    if (blobs.length > 0) {
      e.preventDefault()
      void addBlobs(blobs)
    }
  }

  function onFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files
    if (!list) return
    const arr: Array<{ blob: Blob; nameHint: string }> = []
    for (let i = 0; i < list.length; i++) {
      const f = list[i]
      arr.push({ blob: f, nameHint: f.name })
    }
    if (arr.length > 0) void addBlobs(arr)
    e.target.value = ''  // reset so same file can be re-picked
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    if (e.dataTransfer?.types.includes('Files')) setDragOver(true)
  }
  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    if (e.currentTarget === e.target) setDragOver(false)
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return
    const arr: Array<{ blob: Blob; nameHint: string }> = []
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      arr.push({ blob: f, nameHint: f.name })
    }
    void addBlobs(arr)
  }

  function removeAttachment(idx: number) {
    setAttachments(prev => prev.filter((_, i) => i !== idx))
  }

  /**
   * Continue an agent loop that hit the turns budget. Re-sends the current
   * message list with a larger budget — the model picks up where it stopped.
   */
  async function continueWithMoreTurns() {
    if (!exhausted || isStreaming) return
    const store = useProject.getState()
    const newBudget = Math.min(exhausted.maxBudget, exhausted.used + exhausted.suggestedAdd)
    setExhausted(null)
    armAutoScrollForOutgoing()
    if (store.helpMode) {
      const assistantRow = store.helpChatId != null
        ? await window.api.chats.append(store.helpChatId, HELP_PROJECT_PATH, 'assistant', '')
        : null
      addHelpMessage({ role: 'assistant', content: '', ...(assistantRow ? { dbId: assistantRow.id } : {}) })
      setHelpStreaming(true)
      const msgs = [...store.help.messages].slice(0, -1)
      const sendId = await window.api.ai.sendWithBudget(msgs, null, newBudget, store.helpChatId != null ? String(store.helpChatId) : undefined)
      if (store.helpChatId != null) registerChatSendOwner(sendId, store.helpChatId, true, null)
      if (assistantRow && sendId > 0) registerPersistedAssistant(sendId, assistantRow.id)
      return
    }
    const assistantRow = store.path && activeChatId != null
      ? await window.api.chats.append(activeChatId, store.path, 'assistant', '')
      : null
    addMessage({ role: 'assistant', content: '', ...(assistantRow ? { dbId: assistantRow.id } : {}) })
    setStreaming(true)
    const msgs = [...useProject.getState().messages].slice(0, -1)
    // chatId обязателен и здесь: «Продолжить ходы» — тот же чат, те же компакция/pin/worktree.
    const sendId = await window.api.ai.sendWithBudget(msgs, store.path, newBudget, activeChatId != null ? String(activeChatId) : undefined)
    // sendId<=0 = прогон не стартовал (нет ключа, недоступен провайдер, закреплённый
    // аккаунт удалён). Без этого гарда спиннер, включённый выше, висел бы ВЕЧНО и
    // человек ждал бы ответа, которого не будет (ре-ревью B, #5). Основной send()
    // так и делает — здесь ветка про это не знала.
    if (sendId <= 0) {
      const errorText = '\n\n[Ошибка: провайдер недоступен]'
      updateLastAssistant(errorText)
      if (assistantRow) void window.api.chats.updateMessage(assistantRow.id, errorText).catch(() => {})
      setStreaming(false)
      return
    }
    if (activeChatId != null) registerChatSendOwner(sendId, activeChatId, false, store.path)
    if (assistantRow) registerPersistedAssistant(sendId, assistantRow.id)
  }

  async function ensureProjectForChat(): Promise<{ path: string; activeChatId: number } | null> {
    const store = useProject.getState()
    if (store.path && store.activeChatId != null) {
      return { path: store.path, activeChatId: store.activeChatId }
    }
    try {
      const last = await window.api.settings.getKey('last_project_path')
      const home = await window.api.app.getHomeDir()
      const target = (last && last.length > 0) ? last : home
      await store.setProject(target)
    } catch {
      return null
    }
    const next = useProject.getState()
    if (!next.path || next.activeChatId == null) return null
    return { path: next.path, activeChatId: next.activeChatId }
  }

  function setQueuedMessagesState(items: QueuedComposerMessage[]) {
    queuedMessagesRef.current = items
    setQueuedMessages(items)
    persistPendingScope()
  }

  async function startQueuedBackgroundChatMessage(owner: SendOwner, text: string): Promise<boolean> {
    if (owner.kind !== 'chat' || owner.isHelp || !owner.projectPath || owner.chatId == null) return false

    const projectPath = owner.projectPath
    const chatId = owner.chatId
    let store = useProject.getState()
    const sameProject = !!store.path && normalizeProjectPath(store.path) === normalizeProjectPath(projectPath)
    const isActiveTarget = sameProject && !store.helpMode && store.activeChatId === chatId
    if (isActiveTarget) {
      await send({ text, fromQueue: true })
      return true
    }

    let priorMessages: ChatMessage[] | undefined = sameProject
      ? store.chatSnapshots[chatId]?.messages
      : undefined

    if (!priorMessages) {
      const history = await window.api.chats.list(chatId)
      priorMessages = history.map(m => ({ role: m.role, content: m.content, thinking: m.thinking, appliedSkills: m.appliedSkills, createdAt: m.createdAt, dbId: m.id }))
      if (sameProject) {
        useProject.getState().seedChatSnapshot(chatId, priorMessages)
      }
    }

    const history = compactMessagesForSend(priorMessages)
    const userMsg: ChatMessage = { role: 'user', content: text }
    const isFirstUserMessage = !priorMessages.some(m => m.role === 'user' && m.content.trim())

    await window.api.chats.append(chatId, projectPath, 'user', text)
    const assistantRow = await window.api.chats.append(chatId, projectPath, 'assistant', '')

    store = useProject.getState()
    const stillSameProject = !!store.path && normalizeProjectPath(store.path) === normalizeProjectPath(projectPath)
    const stillActiveTarget = stillSameProject && !store.helpMode && store.activeChatId === chatId
    if (stillActiveTarget) {
      store.clearActivity()
      setExhausted(null)
      setCrossVerify(null)
      armAutoScrollForOutgoing()
      store.addMessage(userMsg)
      store.addMessage({ role: 'assistant', content: '', dbId: assistantRow.id })
      store.setStreaming(true)
    } else if (stillSameProject) {
      store.pushUserToChatSnapshot(chatId, text, undefined, assistantRow.id)
    }

    if (isFirstUserMessage) {
      void useProject.getState().autoTitleChatSession(chatId, text)
    }

    let targetSession = sameProject
      ? useProject.getState().chatSessions.find(c => c.id === chatId) ?? null
      : null
    if (!targetSession) {
      try {
        targetSession = (await window.api.chatSessions.list(projectPath)).find(c => c.id === chatId) ?? null
      } catch {
        targetSession = null
      }
    }

    const effort = useProject.getState().effortLevel
    let sendId = 0
    try {
      sendId = await window.api.ai.sendWithOverrides(
        [...history, userMsg],
        projectPath,
        {
          ...(targetSession?.providerId ? { providerId: targetSession.providerId } : {}),
          ...(targetSession?.model ? { model: targetSession.model } : {}),
          ...(effort !== 'standard' ? { effortLevel: effort } : {}),
          agentMode: await readAgentMode(chatId, false)
        },
        String(chatId)
      )
    } catch (err) {
      console.error('[chat] failed to start queued background message:', err)
    }

    if (sendId > 0) {
      useProject.getState().registerSendOwner(sendId, { kind: 'chat', chatId, projectPath })
      registerPersistedAssistant(sendId, assistantRow.id)
      const activeAfterSend = (() => {
        const current = useProject.getState()
        return !!current.path
          && normalizeProjectPath(current.path) === normalizeProjectPath(projectPath)
          && !current.helpMode
          && current.activeChatId === chatId
      })()
      if (activeAfterSend) {
        currentSendIdRef.current = sendId
      }
      return true
    }

    const errorText = '\n\n[Ошибка: провайдер недоступен]'
    await window.api.chats.updateMessage(assistantRow.id, errorText).catch(() => {})
    store = useProject.getState()
    const activeAfterFailure = !!store.path
      && normalizeProjectPath(store.path) === normalizeProjectPath(projectPath)
      && !store.helpMode
      && store.activeChatId === chatId
    if (activeAfterFailure) {
      store.updateLastAssistant(errorText)
      store.setStreaming(false)
      currentSendIdRef.current = null
    } else if (!!store.path && normalizeProjectPath(store.path) === normalizeProjectPath(projectPath)) {
      store.applyEventToChat(chatId, {
        type: 'error',
        message: 'Провайдер недоступен',
        persistedByChat: true
      })
    }
    return true
  }

  async function flushQueuedForOwner(owner: SendOwner | null): Promise<void> {
    const key = pendingScopeKeyFor(owner)
    if (!key) return

    if (key === pendingScopeKeyRef.current) {
      await flushMessageQueue()
      return
    }

    const state = getPendingStateForScope(key)
    if (state.queuedMessages.length === 0) return
    const [next, ...rest] = state.queuedMessages
    setPendingStateForScope(key, {
      ...state,
      queuedMessages: rest,
      pendingBarExpanded: rest.length > 0 ? state.pendingBarExpanded : false,
    })

    let started = false
    try {
      started = await startQueuedBackgroundChatMessage(owner!, next.text)
    } catch (err) {
      console.error('[chat] failed to flush queued message:', err)
    }
    if (!started) {
      const latest = getPendingStateForScope(key)
      setPendingStateForScope(key, {
        ...latest,
        queuedMessages: [next, ...latest.queuedMessages],
        pendingBarExpanded: true,
      })
    }
  }

  async function flushMessageQueue() {
    if (queuedMessagesRef.current.length === 0) return
    const st = useProject.getState()
    if (st.helpMode ? st.help.isStreaming : st.isStreaming) return
    const [next, ...rest] = queuedMessagesRef.current
    setQueuedMessagesState(rest)
    await send({ text: next.text, fromQueue: true })
  }

  flushQueueRef.current = () => { void flushMessageQueue() }

  useEffect(() => {
    if (isStreaming || queuedMessages.length === 0) return
    const timer = window.setTimeout(() => flushQueueRef.current(), 0)
    return () => window.clearTimeout(timer)
  }, [isStreaming, queuedMessages.length, pendingScopeKey])

  function queueFollowUp(text: string) {
    const item: QueuedComposerMessage = { id: nextComposerItemId(), text, at: Date.now() }
    setQueuedMessagesState([...queuedMessagesRef.current, item])
    setInput('')
    setPendingBarExpanded(true)
    flashQueueNotice(t.chat.streamingQueueAdded)
    armAutoScrollForOutgoing()
  }

  function removeQueuedMessage(id: string) {
    setQueuedMessagesState(queuedMessagesRef.current.filter(m => m.id !== id))
  }

  async function removePendingSupplement(id: string) {
    const item = pendingSupplementsRef.current.find(s => s.id === id)
    if (!item) return
    const nextSupplements = pendingSupplementsRef.current.filter(s => s.id !== id)
    setPendingSupplements(nextSupplements)
    if (queuedMessagesRef.current.length === 0 && nextSupplements.length === 0) {
      setPendingBarExpanded(false)
    }

    if (item.messageId) {
      void window.api.chats.updateMessage(item.messageId, CANCELLED_SUPPLEMENT_CONTENT).catch(() => {})
      useProject.setState(state => ({
        messages: state.messages.map(message =>
          message.dbId === item.messageId
            ? { ...message, content: CANCELLED_SUPPLEMENT_CONTENT }
            : message
        )
      }))
    }
    flashQueueNotice(t.chat.pendingBarSupplementRemoved)
  }

  async function appendTextToCurrentContext(text: string): Promise<boolean> {
    const clean = text.trim()
    if (!clean || !isStreaming) return false
    // ДЕФЕКТ №2 карты (§3.2): раньше брали currentSendIdRef — ОДИН слот на все чаты. Чат A
    // стримит → ушли в B → отправили → ref перезаписан прогоном B → вернулись в A и дописали
    // контекст → дополнение уезжало в ЧУЖОЙ прогон, молча. Спрашиваем реестр владельцев: он
    // уже знает, чей прогон какой, и в отличие от единственного слота — не врёт.
    const st = useProject.getState()
    const sendId = findRunForChat(st.sendOwners, st.helpMode ? st.helpChatId : st.activeChatId, { help: st.helpMode })
    const ctx = await ensureProjectForChat()
    const formatted = formatSupplementForAgent(clean)
    let messageId: number | undefined
    if (ctx?.path && ctx.activeChatId) {
      try {
        const row = await window.api.chats.append(ctx.activeChatId, ctx.path, 'user', formatted)
        messageId = row.id
      } catch {
        messageId = undefined
      }
    }
    insertMessageBeforeLast({ role: 'user', content: formatted, ...(messageId ? { dbId: messageId } : {}) })
    armAutoScrollForOutgoing()

    let status: PendingSupplementStatus = 'deferred'
    if (sendId != null) {
      const res = await window.api.ai.appendContext(sendId, clean)
      if (res.ok) {
        status = res.mode
        if (res.mode === 'deferred') {
          flashQueueNotice(t.chat.streamingAppendCliNote)
        } else {
          flashQueueNotice(t.chat.streamingAppendAccepted)
        }
      } else if (isCliProvider(provider.id)) {
        flashQueueNotice(t.chat.streamingAppendCliNote)
      }
    }

    setPendingSupplements(prev => [...prev, {
      id: nextComposerItemId(),
      text: clean,
      at: Date.now(),
      status,
      ...(messageId ? { messageId } : {}),
    }])
    setPendingBarExpanded(true)
    return true
  }

  async function appendToCurrentContext() {
    const text = input.trim()
    if (await appendTextToCurrentContext(text)) {
      setInput('')
    }
  }

  async function moveQueuedMessageToContext(id: string) {
    const index = queuedMessagesRef.current.findIndex(m => m.id === id)
    const item = index >= 0 ? queuedMessagesRef.current[index] : null
    if (!item) return
    setQueuedMessagesState(queuedMessagesRef.current.filter(m => m.id !== id))
    const moved = await appendTextToCurrentContext(item.text)
    if (!moved) {
      const restored = [...queuedMessagesRef.current]
      restored.splice(Math.max(0, Math.min(index, restored.length)), 0, item)
      setQueuedMessagesState(restored)
    }
  }

  function editQueuedMessage(id: string) {
    const item = queuedMessagesRef.current.find(m => m.id === id)
    if (!item) return
    setQueuedMessagesState(queuedMessagesRef.current.filter(m => m.id !== id))
    setInput(item.text)
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
      autoGrow()
    })
  }

  function applySkillToCurrentMessage(skill: Skill) {
    setAppliedSkills(prev => (
      prev.some(item => item.id === skill.id)
        ? prev
        : [...prev, toAppliedSkillRef(skill)]
    ))
    setDismissedSuggestIds(new Set())
    setDismissedRecipeId(null)
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }

  function removeAppliedSkill(id: string) {
    setAppliedSkills(prev => prev.filter(skill => skill.id !== id))
  }

  async function send(opts?: { text?: string; modelText?: string; displayText?: string; internalResume?: boolean; fromQueue?: boolean }) {
    const text = (opts?.text ?? input).trim()
    const modelText = (opts?.modelText ?? text).trim()
    const displayText = (opts?.displayText ?? text).trim()
    if (!text && attachments.length === 0) return
    if (!opts?.fromQueue && isStreaming) {
      if (text) queueFollowUp(text)
      return
    }
    const store = useProject.getState()
    const messageAppliedSkills = (!opts?.text && !opts?.internalResume && !opts?.fromQueue)
      ? appliedSkills
      : []
    const skillCatalog = useSkillsStore.getState().skills
    const messageAppliedSkillDetails = resolveAppliedSkillDetails(messageAppliedSkills, skillCatalog)
    const activeSkillIdForSend = useSkillsStore.getState().activeSkillId
    const autoBoundSkillDetails = !opts?.internalResume
      ? suggestScoredFromIndex(
          modelText,
          buildSkillIndex(skillCatalog),
          activeSkillIdForSend,
          new Set(messageAppliedSkills.map(skill => skill.id)),
          4
        )
          .filter(item => item.score >= AUTO_BOUND_SKILL_MIN_SCORE)
          .map(item => item.skill)
      : []

    if (store.helpMode) {
      const helpChatId = store.helpChatId
      if (helpChatId == null) return
      if (!opts?.fromQueue && store.hasActiveChatLane(helpChatId, true)) {
        queueFollowUp(text)
        return
      }
      const userAttachments = attachments
      store.clearHelpActivity()
      store.setHelpAgentProgress(buildInitialAgentProgress(displayText || text || 'Новый запрос', provider.label))
      setExhausted(null)
      setCrossVerify(null)
      if (!opts?.text) {
        resetComposerAfterSend()
      }
      const summary = userAttachments.length > 0
        ? `${text}${text ? '\n\n' : ''}📎 ${userAttachments.map(a => a.name).join(', ')}`
        : text
      let enrichedText = text
      const activeSkillForLoad = useSkillsStore.getState().activeSkillId
        ? useSkillsStore.getState().skills.find(s => s.id === useSkillsStore.getState().activeSkillId)
        : null
      if (activeSkillForLoad?.context_loaders?.length) {
        try {
          const loaded = await window.api.skills.runLoaders(activeSkillForLoad.id, {
            trigger: !store.help.messages.some(m => m.role === 'user') ? 'chat_open' : 'slash_arg',
            projectPath: null,
          arg: modelText.split(/\s+/)[0]
          })
          if (loaded.context) enrichedText = `${loaded.context}\n\n---\n\n${text}`
        } catch (err) {
          console.warn('[help] skill loaders failed:', err)
        }
      }
      armAutoScrollForOutgoing()
      addHelpMessage({ role: 'user', content: enrichedText, attachments: userAttachments })
      await window.api.chats.append(helpChatId, HELP_PROJECT_PATH, 'user', summary)
      const assistantRow = await window.api.chats.append(helpChatId, HELP_PROJECT_PATH, 'assistant', '')
      addHelpMessage({ role: 'assistant', content: '', dbId: assistantRow.id })
      setHelpStreaming(true)
      setHelpAgentProgress(activateModelProgress(useProject.getState().help.agentProgress, provider.label))
      const allMessages = [...useProject.getState().help.messages].slice(0, -1)
      const activeSkill = useSkillsStore.getState().activeSkillId
        ? useSkillsStore.getState().skills.find(s => s.id === useSkillsStore.getState().activeSkillId)
        : null
      let sendId: number
      const antiStallNudge = '\n\n---\nВАЖНО (Verstak): если пользователь дал ясный прямой запрос — выполни его прямо в этом чате и выдай результат. Не зацикливайся, прося оформить «пакет задачи», «одну фразу цели» или ждать отдельного «ок», если намерение уже понятно.'
      const helpOverrides: Parameters<typeof window.api.ai.sendWithOverrides>[2] = {
        ...HELP_CHAT_SEND_OVERRIDES,
      }
      if (activeSkill) {
        const currentProvider = await window.api.settings.getKey('provider')
        const { providerId: overrideProvider, model: overrideModel } = resolveSkillOverride(activeSkill, currentProvider)
        Object.assign(helpOverrides, {
          systemPrompt: activeSkill.systemPrompt + antiStallNudge,
          ...(overrideProvider ? { providerId: overrideProvider } : {}),
          ...(overrideModel ? { model: overrideModel } : {}),
          ...(activeSkill.tools_allow?.length ? { toolsAllow: activeSkill.tools_allow } : {}),
          ...(activeSkill.recipe ? { recipe: activeSkill.recipe } : {}),
          effortLevel: store.effortLevel,
        })
      } else if (store.effortLevel !== 'standard') {
        helpOverrides.effortLevel = store.effortLevel
      }
      sendId = await window.api.ai.sendWithOverrides(allMessages, null, helpOverrides, String(helpChatId))
      currentSendIdRef.current = sendId
      if (sendId <= 0) {
        const errorText = '\n\n[Ошибка: провайдер недоступен]'
        updateHelpLastAssistant(errorText)
        void window.api.chats.updateMessage(assistantRow.id, errorText).catch(() => {})
        useProject.getState().applyEventToHelp({ type: 'error', message: 'Провайдер недоступен' })
        setHelpStreaming(false)
        currentSendIdRef.current = null
        return
      }
      useProject.getState().setHelpAgentProgress(activateModelProgress(useProject.getState().help.agentProgress ?? [], provider.label))
      registerChatSendOwner(sendId, helpChatId, true, null)
      if (sendId > 0) registerPersistedAssistant(sendId, assistantRow.id)
      return
    }

    const ctx = await ensureProjectForChat()
    if (!ctx) {
      flashWarning('Сначала открой папку проекта слева — без неё переписка не сохраняется.')
      return
    }
    const path = ctx.path
    const userAttachments = attachments
    if (!opts?.fromQueue && ctx.activeChatId != null && store.hasActiveChatLane(ctx.activeChatId, false)) {
      queueFollowUp(text)
      return
    }
    store.clearActivity()
    store.setAgentProgress(buildInitialAgentProgress(displayText || text || 'Новый запрос', provider.label))
    const skillBindingProgressDetail = buildSkillBindingProgressDetail(messageAppliedSkillDetails, autoBoundSkillDetails)
    if (skillBindingProgressDetail) {
      setAgentProgress(reduceAgentProgress(useProject.getState().agentProgress, {
        type: 'agent-progress',
        id: 'skills-bound',
        phase: 'context',
        title: 'Подключаю скиллы',
        detail: skillBindingProgressDetail,
        status: 'done'
      }))
    }
    setExhausted(null)  // new send wipes any pending continue state
    setCrossVerify(null)  // сбрасываем предыдущий результат cross-verify
    if (!opts?.text || opts?.modelText) {
      resetComposerAfterSend()
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
      ? useSkillsStore.getState().skills.find(s => s.id === activeSkillIdForSend)
      : null
    const loaderSkill = uniqueSkills([activeSkillForLoad, ...messageAppliedSkillDetails, ...autoBoundSkillDetails])
      .find(skill => skill.context_loaders?.length)
    if (loaderSkill?.context_loaders?.length) {
      const isFirstUserMsg = !useProject.getState().messages.some(m => m.role === 'user')
      const trigger: 'chat_open' | 'slash_arg' = isFirstUserMsg ? 'chat_open' : 'slash_arg'
      try {
        const loaded = await window.api.skills.runLoaders(loaderSkill.id, {
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
        const block = await window.api.files.resolveMentions(path, mentions)
        if (block) enrichedText = `${block}\n\n---\n\n${enrichedText}`
      }
    } catch (err) {
      console.warn('[chat] @-mentions resolve failed:', err)
    }
    const isFirstUserMessage = !store.messages.some(m => m.role === 'user')
    armAutoScrollForOutgoing()
    if (!opts?.internalResume) {
      addMessage({
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
      await window.api.chats.append(
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
      ? await window.api.chats.append(activeChatId, path, 'assistant', '')
      : null
    addMessage({ role: 'assistant', content: '', ...(assistantRow ? { dbId: assistantRow.id } : {}) })
    setStreaming(true)
    setAgentProgress(activateModelProgress(useProject.getState().agentProgress, provider.label))
    const allMessages = [...useProject.getState().messages].slice(0, -1)
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
    const sendAgentMode = await readAgentMode(activeChatId, false)
    // Skill override: если активен скилл — system prompt берётся из его тела.
    // Provider/model берутся из скилла ТОЛЬКО если активный выбор пользователя
    // несовместим с тем что предлагает скилл. Например: скилл говорит 'claude'
    // (API), пользователь выбрал 'claude-cli' (CLI/подписка) — оба = Claude,
    // НЕ переключаем. Это сохраняет выбор пользователя по подписке/API.
    const activeSkill = activeSkillIdForSend
      ? useSkillsStore.getState().skills.find(s => s.id === activeSkillIdForSend)
      : null
    const skillSystemPrompt = composeSkillSystemPrompt(activeSkill ?? null, messageAppliedSkillDetails, modelText, autoBoundSkillDetails)
    const toolsAllow = mergeToolAllow([activeSkill, ...messageAppliedSkillDetails, ...autoBoundSkillDetails])
    const recipe = firstRecipe([activeSkill, ...messageAppliedSkillDetails, ...autoBoundSkillDetails])
    let sendId: number
    // Crash-resume Фаза 2: re-send прерванного прогона → прокидываем runId, чтобы
    // ai:send продолжил с накопленным контекстом из чекпойнта. Консьюмим ref однократно.
    const resumeFromRunId = resumeFromRunIdRef.current
    resumeFromRunIdRef.current = null
    // 2.0.7-F: маршрут модели на ОДИН prompt. Берём из store, наслаиваем на overrides всех
    // веток (побеждает дефолт чата и skill-override — самый явный выбор пользователя), и
    // СРАЗУ снимаем после отправки (one-shot). requested пишется в agent_run (main).
    const oneShotRoute = useProject.getState().promptRouteOverride
    const routeOverride = oneShotRoute ? { promptRoute: oneShotRoute } : {}
    // Хвост ревью 2.0.11-B: chatId ОБЯЗАН доехать до ai:send. От него в main зависят три
    // вещи разом: компакция контекста (2.0.11-B), закреплённый за чатом аккаунт (2.0.8-D2)
    // и изоляция worktree. Фоновые пути его передавали, главный — забывал, и все три
    // молча не работали в основном чате. Страж: tests/contracts/chat-send-chatid-contract.
    const sendChatId = activeChatId != null ? String(activeChatId) : undefined
    if (activeSkill || skillSystemPrompt) {
      // Узнаём текущий provider пользователя — чтобы решить override или нет
      const currentProvider = activeSkill ? await window.api.settings.getKey('provider') : null
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
      sendId = await window.api.ai.sendWithOverrides(modelMessages, path, {
        ...(skillSystemPrompt ? { systemPrompt: skillSystemPrompt } : {}),
        ...(overrideProvider ? { providerId: overrideProvider } : {}),
        ...(overrideModel ? { model: overrideModel } : {}),
        // Аудит M4: tools_allow скилла → agent-loop ограничивает инструменты модели.
        ...(toolsAllow?.length ? { toolsAllow } : {}),
        // Этап 4: recipe скилла → main наслаивает workflow-протокол на skill-промпт.
        ...(recipe ? { recipe } : {}),
        effortLevel: useProject.getState().effortLevel,
        agentMode: sendAgentMode,
        ...(resumeFromRunId ? { resumeFromRunId } : {}),
        ...routeOverride
      }, sendChatId)
    } else if (resumeFromRunId) {
      // Возобновление вне скилла: всё равно прокидываем resumeFromRunId (+ effort).
      const effort = useProject.getState().effortLevel
      sendId = await window.api.ai.sendWithOverrides(modelMessages, path, {
        resumeFromRunId,
        agentMode: sendAgentMode,
        ...(effort !== 'standard' ? { effortLevel: effort } : {}),
        ...routeOverride
      }, sendChatId)
    } else {
      const effort = useProject.getState().effortLevel
      sendId = await window.api.ai.sendWithOverrides(modelMessages, path, {
        ...(effort !== 'standard' ? { effortLevel: effort } : {}),
        agentMode: sendAgentMode,
        ...routeOverride
      }, sendChatId)
    }
    // one-shot: маршрут действовал только на эту отправку — снимаем.
    if (oneShotRoute) useProject.getState().setPromptRouteOverride(null)
    currentSendIdRef.current = sendId
    if (sendId <= 0) {
      const errorText = '\n\n[Ошибка: провайдер недоступен]'
      updateLastAssistant(errorText)
      if (assistantRow) void window.api.chats.updateMessage(assistantRow.id, errorText).catch(() => {})
      useProject.getState().applyAgentProgressEvent({ type: 'error', message: 'Провайдер недоступен' })
      setStreaming(false)
      currentSendIdRef.current = null
      return
    }
    if (pipelineAutoSendStepRef.current === 'execute') {
      pipelineExecuteSendIdRef.current = sendId
    }
    useProject.getState().setAgentProgress(activateModelProgress(useProject.getState().agentProgress ?? [], provider.label))
    // Bind this send to the chat that initiated it — if user switches to
    // another chat mid-stream, the event handler will route events into
    // chatSnapshots[activeChatId] rather than corrupting the new active chat.
    if (activeChatId != null) {
      registerChatSendOwner(sendId, activeChatId, false, path)
      if (assistantRow && sendId > 0) registerPersistedAssistant(sendId, assistantRow.id)
    }
  }

  useEffect(() => {
    const off = window.api.notify.onSendChatReminder((payload) => {
      void (async () => {
        const text = payload.text?.trim()
        if (!text || !payload.projectPath || !payload.chatId) return

        try {
          let store = useProject.getState()
          if (!store.path || normalizeProjectPath(store.path) !== normalizeProjectPath(payload.projectPath)) {
            await store.setProject(payload.projectPath)
          }

          store = useProject.getState()
          if (!store.chatSessions.some(c => c.id === payload.chatId)) {
            await store.refreshChatSessions()
          }

          store = useProject.getState()
          if (!store.chatSessions.some(c => c.id === payload.chatId)) {
            console.warn('[reminders] target chat not found:', payload.chatId)
            return
          }

          const isActiveTarget = !store.helpMode && store.activeChatId === payload.chatId
          let priorMessages: ChatMessage[] | undefined = isActiveTarget
            ? store.messages
            : store.chatSnapshots[payload.chatId]?.messages

          if (!priorMessages) {
            const history = await window.api.chats.list(payload.chatId)
            priorMessages = history.map(m => ({ role: m.role, content: m.content, thinking: m.thinking, appliedSkills: m.appliedSkills, createdAt: m.createdAt, dbId: m.id }))
            useProject.getState().seedChatSnapshot(payload.chatId, priorMessages)
          }

          const isFirstUserMessage = !priorMessages.some(m => m.role === 'user' && m.content.trim())
          const history = compactMessagesForSend(priorMessages)
          const userMsg: ChatMessage = { role: 'user', content: text, source: 'reminder' }

          await window.api.chats.append(payload.chatId, payload.projectPath, 'user', text)
          const assistantRow = await window.api.chats.append(payload.chatId, payload.projectPath, 'assistant', '')
          await window.api.reminders.markChatDelivered(payload.reminderId).catch(err => {
            console.warn('[reminders] failed to ack chat delivery:', err)
          })
          window.dispatchEvent(new CustomEvent('gg-reminders-changed', { detail: { projectPath: payload.projectPath } }))

          store = useProject.getState()
          // ДЕФЕКТ №3 карты (§3.3): здесь стоял isActiveTarget, посчитанный ВЫШЕ — ДО трёх
          // await'ов (история, две записи в БД, ack). Стор рядом перечитывался, а производный
          // флаг — нет. Если человек за это время переключил чат, сообщение напоминания
          // всплывало в ЧУЖОМ видимом чате (addMessage) вместо снапшота своего.
          // Близнец startQueuedBackgroundChatMessage (≈2367) перепроверяет активность после
          // КАЖДОГО await — берём его, более строгий, вариант.
          const stillActiveTarget = !store.helpMode && store.activeChatId === payload.chatId
          if (stillActiveTarget) {
            store.clearActivity()
            setExhausted(null)
            setCrossVerify(null)
            armAutoScrollForOutgoing()
            store.addMessage(userMsg)
            store.addMessage({ role: 'assistant', content: '', dbId: assistantRow.id })
            store.setStreaming(true)
          } else {
            store.pushUserToChatSnapshot(payload.chatId, text, { source: 'reminder' }, assistantRow.id)
          }

          if (isFirstUserMessage) {
            void useProject.getState().autoTitleChatSession(payload.chatId, text)
          }

          const effort = useProject.getState().effortLevel
          const sendId = await window.api.ai.sendWithOverrides(
            [...history, userMsg],
            payload.projectPath,
            {
              ...(effort !== 'standard' ? { effortLevel: effort } : {}),
              agentMode: await readAgentMode(payload.chatId, false)
            },
            String(payload.chatId)
          )

          // Ещё один await позади (сама отправка) — активность снова могла смениться.
          // Близнец в этой точке считает activeAfterSend; здесь стоял всё тот же флаг
          // из начала обработчика. Пересчитываем (дефект №3, продолжение).
          const activeAfterSend = (() => {
            const s = useProject.getState()
            return !s.helpMode && s.activeChatId === payload.chatId
          })()
          if (sendId > 0) {
            useProject.getState().registerSendOwner(sendId, { kind: 'chat', chatId: payload.chatId, projectPath: payload.projectPath })
            registerPersistedAssistant(sendId, assistantRow.id)
            if (activeAfterSend) {
              currentSendIdRef.current = sendId
            }
          } else if (activeAfterSend) {
            useProject.getState().updateLastAssistant('\n\n[Ошибка: провайдер недоступен]')
            useProject.getState().setStreaming(false)
          } else {
            useProject.getState().applyEventToChat(payload.chatId, {
              type: 'error',
              message: 'Провайдер недоступен'
            })
          }

        } catch (err) {
          console.error('[reminders] failed to send chat reminder:', err)
        }
      })()
    })
    return off
  }, [])

  async function stop(asSuspend = false) {
    const id = currentSendIdRef.current
    if (id == null) return
    // #4 suspend: та же очистка, что Stop, но прогон помечается 'suspended' с
    // сохранённым чекпойнтом для ↻ Продолжить (резюм через resumeFromRunId).
    if (asSuspend) await window.api.ai.suspend(id)
    else await window.api.ai.stop(id)
    const st = useProject.getState()
    if (st.helpMode) {
      st.finalizeHelpStreamDuration()
      setHelpStreaming(false)
    } else {
      st.finalizeActiveStreamDuration()
      setStreaming(false)
    }
    setPendingSupplements([])
    setPendingBarExpanded(false)
    // sendOwners cleanup: stop() = главное место где renderer знает, что
    // больше событий по этому sendId не придёт. Без этого owner повисал бы
    // в мапе, потому что done event на abort иногда теряется.
    finishPersistedAssistant(id)
    useProject.getState().forgetSendOwner(id)
    // Снять висящую модалку CommandConfirm этого прогона: Stop во время ожидания
    // подтверждения команды → main зарезолвил pendingCommand в false, но command-result
    // мог дропнуться (owner забыт выше) → модалка осталась бы (ревью 24.06).
    const cur = useProject.getState()
    if (cur.pendingCommand?.sendId === id) cur.setPendingCommand(null)
    if (cur.pendingPlan?.sendId === id) cur.setPendingPlan(null) // #3 plan-gate: снять модалку плана при Stop
    currentSendIdRef.current = null
    flushQueueRef.current()
  }

  /**
   * Вставить шаблон в композер и сфокусировать textarea (курсор в конце —
   * пользователь сразу дописывает цель). Используется мультиагентными
   * slash-командами и кнопкой «Мультиагент». setTimeout(0) — чтобы значение
   * не было перетёрто onClear() из SlashCommandPopup.execute() (см. там).
   */
  function injectTemplate(template: string) {
    window.setTimeout(() => {
      setInput(template)
      const ta = textareaRef.current
      if (ta) {
        ta.focus()
        ta.setSelectionRange(template.length, template.length)
      }
    }, 0)
  }

  const hasMessages = messages.length > 0
  const canSend = !isStreaming && (input.trim().length > 0 || attachments.length > 0)

  return (
    <div
      ref={chatRootRef}
      className={`gg-chat ${dragOver ? 'is-drag-over' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="gg-drop-overlay">
          <div className="gg-drop-overlay-inner">
            <div className="gg-drop-icon">📎</div>
            <div>Брось файлы сюда — изображения, PDF, текст</div>
          </div>
        </div>
      )}

      {isHelpChat ? (
        <div className="gg-chat-project-bar gg-chat-project-bar-help" role="note">
          <span className="gg-chat-project-icon" aria-hidden>❓</span>
          <span className="gg-chat-project-name">{t.help.emptyTitle}</span>
        </div>
      ) : projectName ? (
        <div className="gg-chat-project-bar" title={activePath ?? ''}>
          <span className="gg-chat-project-icon gg-folder-icon" aria-hidden="true" />
          <span className="gg-chat-project-name">{projectName}</span>
          {activeChatTitle && (
            <>
              <span className="gg-chat-project-sep">·</span>
              <span className="gg-chat-project-chat">{activeChatTitle}</span>
            </>
          )}
          {activePath && (
            <div className="gg-chat-project-actions">
              <button
                type="button"
                className={`gg-terminal-bar-btn ${rightPanel === 'terminal' ? 'is-open' : ''}`}
                onClick={() => onSelectRightPanel(rightPanel === 'terminal' ? 'none' : 'terminal')}
                title={t.chat.dockTerminal}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" y1="19" x2="20" y2="19" />
                </svg>
                <span>{t.chat.dockTerminal}</span>
              </button>
              <button
                type="button"
                className={`gg-terminal-bar-btn gg-terminal-bar-btn-sidechat ${rightPanel === 'sidechat' ? 'is-open' : ''}`}
                onClick={() => {
                  if (rightPanel === 'sidechat') onSelectRightPanel('none')
                  else onOpenSideChat()
                }}
                title={t.chat.dockSideChat}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="3" y="4" width="8" height="16" rx="1.5" />
                  <path d="M13 8h6a2 2 0 0 1 2 2v8l-3-2.5H13a2 2 0 0 1-2-2V8z" />
                </svg>
                <span>{t.chat.dockSideChat}</span>
              </button>
            </div>
          )}
        </div>
      ) : null}

      {!isHelpChat && chatReminderPins.length > 0 && (
        <div
          className={`gg-chat-reminder-pins ${reminderPinsPrefs.collapsed ? 'is-collapsed' : ''}`}
          aria-label="Напоминания проекта"
          style={{ left: reminderPinsPrefs.x, top: reminderPinsPrefs.y }}
        >
          <div
            className="gg-chat-reminder-pins-head"
            onPointerDown={onReminderPinsDragStart}
            onPointerMove={onReminderPinsDragMove}
            onPointerUp={onReminderPinsDragEnd}
            onPointerCancel={onReminderPinsDragEnd}
          >
            <button
              type="button"
              className="gg-chat-reminder-pins-toggle"
              onClick={() => setReminderPinsCollapsed(!reminderPinsPrefs.collapsed)}
              title={reminderPinsPrefs.collapsed ? 'Развернуть напоминания' : 'Свернуть напоминания'}
            >
              {reminderPinsPrefs.collapsed ? '+' : '-'}
            </button>
            <span className="gg-chat-reminder-pins-grip" aria-hidden>::</span>
            <button
              type="button"
              className="gg-chat-reminder-pins-title"
              onClick={() => setActiveView('reminders')}
              title="Открыть напоминания"
            >
              <span>Напоминания</span>
              <span className="gg-chat-reminder-pins-count">{chatReminderPins.length}</span>
            </button>
          </div>
          {!reminderPinsPrefs.collapsed && (
            <div className="gg-chat-reminder-pins-list">
              {visibleReminderPins.map(reminder => (
                <div key={reminder.id} className="gg-chat-reminder-pin">
                  <button
                    type="button"
                    className="gg-chat-reminder-pin-body"
                    onClick={() => setActiveView('reminders')}
                    title="Открыть напоминания"
                  >
                    <span className="gg-chat-reminder-pin-kicker">Напоминание</span>
                    <span className="gg-chat-reminder-pin-title">{reminder.title}</span>
                    <span className="gg-chat-reminder-pin-time">{formatReminderPinTime(reminder.dueAt)}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className={`gg-chat-stream-area ${visibleDateLabel ? 'has-visible-date' : ''}`}>
        {visibleDateLabel ? (
          <div className="gg-chat-visible-date" aria-hidden="true">
            {visibleDateLabel}
          </div>
        ) : null}
        <div className="gg-chat-stream" ref={streamRef}>
        <div className="gg-chat-stream-inner">
        {isHelpChat && (
          <div className="gg-help-chat-banner" role="note">
            <span className="gg-help-chat-banner-icon" aria-hidden>❓</span>
            <span>{t.help.banner}</span>
          </div>
        )}
        {!hasMessages && isHelpChat && (
          <div className="gg-chat-empty gg-chat-empty-help">
            <div className="gg-chat-empty-title">{t.help.emptyTitle}</div>
            <div className="gg-chat-empty-hint">{t.help.emptyHint}</div>
            <div className="gg-chat-empty-quick">
              {['Как устроен сайдбар?', 'Чем чеклист отличается от прогонов?', 'Как поставить задачу в очередь?'].map(q => (
                <button key={q} type="button" className="gg-quick-action" onClick={() => setInput(q)}>{q}</button>
              ))}
            </div>
          </div>
        )}
        {!hasMessages && !isHelpChat && (
          <div className="gg-chat-empty">
            <img src={iconUrl} alt="Verstak" className="gg-chat-empty-mark-img" />
            <div className="gg-chat-empty-title">Готов к работе</div>
            <div className="gg-chat-empty-hint">
              Открой проект слева и напиши задачу. Можно прикрепить файл, бросить скриншот через Ctrl+V или drag-and-drop.
            </div>
            <div className="gg-chat-empty-modes">
              <div className="gg-chat-empty-modes-title">5 режимов агента — переключаются цифрами 1-5</div>
              <div className="gg-chat-empty-modes-row">
                <span><b>1</b> 🛡 Запрос — каждый шаг через подтверждение</span>
                <span><b>2</b> ✏ Принимать правки — файлы авто, команды спрашивает</span>
                <span><b>3</b> 📋 План — только чтение и план, без правок</span>
                <span><b>4</b> ⚡ Авто — всё авто-принимается</span>
                <span><b>5</b> 🚀 Без подтверждения — для CI / опытных</span>
              </div>
              <div className="gg-chat-empty-modes-tip">
                <b>Shift+Esc</b> — экстренный стоп всех сессий. Кнопка <b>📍 Чекпоинт</b> внизу — запомнить состояние файлов и откатить одним кликом.
              </div>
            </div>
            {activePath && (
              <div className="gg-chat-empty-quick">
                <button
                  className="gg-quick-action"
                  onClick={() => { setPipelineWizardMode('agency'); setPipelineWizardOpen(true) }}
                  disabled={isCliProvider(provider.id)}
                  title={isCliProvider(provider.id) ? t.pipeline.cliGate : t.pipeline.title}
                >
                  ▶ Agency task
                </button>
                <button
                  className="gg-quick-action"
                  onClick={() => setInput('/code-review')}
                  title="Запустить скилл «Code Review» — анализ изменений, поиск багов и регрессий"
                >
                  🔍 {t.chat.codeReview}
                </button>
                <button
                  className="gg-quick-action"
                  onClick={() => setInput('/git-summary')}
                  title="Запустить скилл «Git Summary» — краткая сводка последних коммитов"
                >
                  📝 {t.chat.gitSummary}
                </button>
                <button
                  className="gg-quick-action"
                  onClick={() => setInput('/explain')}
                  title="Запустить скилл «Explain Code» — объяснение выбранного кода"
                >
                  💡 {t.chat.explainCode}
                </button>
                <button
                  className="gg-quick-action"
                  onClick={() => setInput(GOAL_CYCLE_PROMPT)}
                  title="AI прочитает журнал работы, карту проекта и предложит 3 конкретных улучшения с планом"
                >
                  💡 {t.chat.whatToImprove}
                </button>
                <button
                  className="gg-quick-action"
                  onClick={() => setInput('Сделай аудит последних изменений за вчера-сегодня: вызови read_journal с kind="session" на 10 записей, выдели риски и регрессии.')}
                  title="AI прочитает свежие сессии и поищет регрессии"
                >
                  🔍 Аудит изменений
                </button>
                <button
                  className="gg-quick-action"
                  onClick={() => setInput('Покажи карту проекта: вызови get_project_map с format=text.')}
                  title="Быстрый обзор структуры проекта"
                >
                  🗺 Карта проекта
                </button>
                {/* Мультиагент (orchestrate/swarm) — НЕ кнопки. Агент сам решает
                    разбить многогранную задачу на параллельные подзадачи и
                    вызывает delegate_parallel/orchestrate/swarm (см. промпт-правило
                    fan-out в compose-system). Юзер описывает результат, не стратегию. */}
              </div>
            )}
            {suggestions.length > 0 && (
              <div className="gg-suggestions">
                <div className="gg-suggestions-title">💡 Suggestions</div>
                {suggestions.map((s, i) => (
                  <button key={i} className="gg-suggestion-card" onClick={() => setInput(s.title)}>
                    <span className="gg-suggestion-priority" data-priority={s.priority} />
                    <div>
                      <div className="gg-suggestion-title">{s.title}</div>
                      {s.description && <div className="gg-suggestion-desc">{s.description}</div>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {hasOlderMessages && (
          <div className="gg-chat-history-more">
            <button className="gg-btn gg-btn-ghost" type="button" onClick={() => void loadOlderMessages()}>
              Показать ранние сообщения
              {chatTotalCount > messages.length ? ` (${messages.length}/${chatTotalCount})` : ''}
            </button>
          </div>
        )}
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1
          const isStreamingAssistant = isLast && m.role === 'assistant' && isStreaming
          const hasAgentProgress = isLast && m.role === 'assistant' && agentProgress.length > 0
          const showInlineAgentProgress = hasAgentProgress && !isStreamingAssistant
          // Render activity rows just before the (last) assistant message
          const showActivity = isLast && m.role === 'assistant' && activity.length > 0
          const showPreflights = isLast && m.role === 'assistant' && preflights.length > 0
          const showSubagents = isLast && m.role === 'assistant' && subagentRuns.length > 0
          const changedFiles = isLast && m.role === 'assistant' && !isStreaming
            ? activity.filter(a => a.kind === 'write' && a.status === 'ok').map(a => a.detail ?? '')
            : []
          const prevMsg = i > 0 ? messages[i - 1] : null
          const showDateDivider = m.createdAt != null
            && (prevMsg?.createdAt == null || !isSameLocalDay(prevMsg.createdAt, m.createdAt))
          const messageDateLabel = m.createdAt != null ? formatChatDateDivider(m.createdAt) : undefined
          const messageDay = m.createdAt != null ? new Date(m.createdAt).toLocaleDateString('en-CA') : undefined
          const supplement = m.role === 'user' && m.content ? parseSupplementMessage(m.content) : null
          const hideProgressMeta = m.role === 'assistant' && hasAgentProgress
          const hideStreamingProgressPlaceholder = isStreamingAssistant
            && hasAgentProgress
            && !m.content?.trim()
            && !m.thinking
            && !m.attachments?.length
            && changedFiles.length === 0
          const isAnimatedAssistant = m.role === 'assistant'
            && i === lastAssistantInfo?.index
            && animatedAssistantText?.key === lastAssistantAnimationKey
          const renderedContent = isAnimatedAssistant
            ? (animatedAssistantText?.shown ?? m.content)
            : m.content
          const isEmptyInterruptedAssistant = m.role === 'assistant'
            && !isStreamingAssistant
            && !renderedContent?.trim()
            && !m.thinking?.trim()
            && !m.attachments?.length
            && !showInlineAgentProgress
            && !showActivity
            && !showPreflights
            && !showSubagents
          if (isEmptyInterruptedAssistant) {
            if (resumableRuns.length > 0) return null
            return (
              <Fragment key={i}>
                {showDateDivider && (
                  <div className="gg-chat-date-divider" role="separator" aria-label={formatChatDateDivider(m.createdAt!)}>
                    <span className="gg-chat-date-divider-label">{formatChatDateDivider(m.createdAt!)}</span>
                  </div>
                )}
                <div
                  className="gg-msg gg-msg-assistant gg-msg-agent-progress-standalone"
                  data-message-day={messageDay}
                  data-message-date-label={messageDateLabel}
                >
                  <div className="gg-agent-progress-inline is-standalone">
                    <AgentProgressPanel
                      entries={buildInterruptedAnswerProgress(m.createdAt, provider.label)}
                      isStreaming={false}
                      finishedAt={m.createdAt ?? null}
                      onToggleOpen={handleAgentProgressToggle}
                    />
                  </div>
                </div>
              </Fragment>
            )
          }
          return (
            <Fragment key={i}>
            {showDateDivider && (
              <div className="gg-chat-date-divider" role="separator" aria-label={formatChatDateDivider(m.createdAt!)}>
                <span className="gg-chat-date-divider-label">{formatChatDateDivider(m.createdAt!)}</span>
              </div>
            )}
            <div
              className={`gg-msg ${m.role === 'user' ? 'gg-msg-user' : 'gg-msg-assistant'}${supplement ? ' is-supplement' : ''}`}
              data-message-day={messageDay}
              data-message-date-label={messageDateLabel}
            >
              {showInlineAgentProgress && (
                <div className="gg-agent-progress-inline">
                  <AgentProgressPanel
                    entries={agentProgress}
                    isStreaming={false}
                    durationMs={agentProgressDurationMs}
                    finishedAt={agentProgressFinishedAt}
                    onToggleOpen={handleAgentProgressToggle}
                  />
                </div>
              )}
              {showActivity && (
                <div className="gg-activity-list">
                  {activity.map(a => (
                    <div key={a.id} className={`gg-activity-row is-${a.status}`}>
                      <span className="gg-activity-icon" />
                      <span className="gg-activity-label">{a.label}</span>
                      {a.detail && <span className="gg-activity-detail">{a.detail.length > 80 ? a.detail.slice(0, 80) + '…' : a.detail}</span>}
                    </div>
                  ))}
                </div>
              )}
              {showPreflights && preflights.map(pf => {
                const riskLabel = pf.risk === 'high' ? 'высокий риск' : pf.risk === 'medium' ? 'средний риск' : 'низкий риск'
                return (
                  <div key={pf.callId} className={`gg-preflight is-${pf.risk}`}>
                    <div className="gg-preflight-head">
                      <span className="gg-preflight-title">🛫 План перед действием</span>
                      <span className={`gg-preflight-pill is-${pf.risk}`}>{riskLabel}</span>
                    </div>
                    <div className="gg-preflight-summary">{pf.summary}</div>
                    {pf.riskReason && <div className="gg-preflight-reason">{pf.riskReason}</div>}
                    {pf.affectedZones.length > 0 && (
                      <div className="gg-preflight-section">
                        <div className="gg-preflight-label">Затронутые зоны</div>
                        <ul className="gg-preflight-ul">
                          {pf.affectedZones.map((z, zi) => <li key={zi}>{z}</li>)}
                        </ul>
                      </div>
                    )}
                    {pf.verifyAfter.length > 0 && (
                      <div className="gg-preflight-section">
                        <div className="gg-preflight-label">Проверить после</div>
                        <ul className="gg-preflight-ul">
                          {pf.verifyAfter.map((v, vi) => <li key={vi}>{v}</li>)}
                        </ul>
                      </div>
                    )}
                    {pf.outOfScope.length > 0 && (
                      <div className="gg-preflight-section">
                        <div className="gg-preflight-label">Вне scope / запреты</div>
                        <ul className="gg-preflight-ul">
                          {pf.outOfScope.map((o, oi) => <li key={oi}>{o}</li>)}
                        </ul>
                      </div>
                    )}
                    {/* Dev Task Flow (Фаза 2): мягкое предложение открыть задачу из
                        плана — НЕ авто-создание. Снимет checkpoint + зафиксирует
                        git-базу, появится вкладка «Задача» с откатом. */}
                    <div className="gg-preflight-section gg-preflight-devtask">
                      <button
                        type="button"
                        className="gg-preflight-opentask"
                        onClick={() => void openTaskFromPreflight(pf)}
                        title="Открыть задачу из этого плана — снимет чекпоинт и покажет вкладку «Задача» с откатом"
                      >
                        🗂️ Открыть задачу из этого плана
                      </button>
                    </div>
                  </div>
                )
              })}
              {showSubagents && subagentRuns.map(sa => {
                const statusLabel = sa.status === 'running' ? 'выполняется' : sa.status === 'done' ? 'готово' : 'ошибка'
                return (
                  <div key={sa.callId} className={`gg-subagent is-${sa.status}`}>
                    <div className="gg-subagent-head">
                      <span className="gg-subagent-title">🤖 Sub-agent: {sa.label}</span>
                      <span className={`gg-subagent-pill is-${sa.status}`}>{statusLabel}</span>
                    </div>
                    <div className="gg-subagent-meta">
                      {sa.skill && <span className="gg-subagent-tag">скилл: {sa.skill}</span>}
                      {sa.provider && <span className="gg-subagent-tag">провайдер: {sa.provider}</span>}
                      {sa.role && <span className="gg-subagent-tag">роль: {sa.role}</span>}
                      {typeof sa.toolCount === 'number' && sa.toolCount > 0 && (
                        <span className="gg-subagent-tag">🔧 {sa.toolCount} tool-вызовов</span>
                      )}
                    </div>
                    <div className="gg-subagent-task">{sa.task}</div>
                    {sa.result && (
                      <details className="gg-subagent-result">
                        <summary>{sa.status === 'error' ? 'Ошибка' : 'Результат'}</summary>
                        <div className="gg-subagent-result-body">{sa.result}</div>
                      </details>
                    )}
                  </div>
                )
              })}
              {(m.role === 'assistant' || m.role === 'user') && !hideProgressMeta && (
                <div className="gg-msg-meta">
                  {m.role === 'assistant' && (
                    <span className="gg-msg-author">{provider.label}</span>
                  )}
                  {m.createdAt != null && (
                    <time
                      className="gg-msg-time"
                      dateTime={new Date(m.createdAt).toISOString()}
                      title={formatMessageDateTitle(m.createdAt)}
                    >
                      {formatMessageClock(m.createdAt)}
                    </time>
                  )}
                  {isStreamingAssistant && streamStartedAt != null && !hasAgentProgress && (
                    <span className="gg-msg-duration is-live" title={t.chat.responseRunningTitle}>
                      {t.chat.responseRunning.replace('{duration}', formatDuration(tickNow - streamStartedAt))}
                    </span>
                  )}
                  {!isStreamingAssistant && m.responseDurationMs != null && (
                    <span className="gg-msg-duration" title={t.chat.responseDoneTitle}>
                      {t.chat.responseDone.replace('{duration}', formatDuration(m.responseDurationMs))}
                    </span>
                  )}
                </div>
              )}
              {!hideStreamingProgressPlaceholder && (
              <div className="gg-msg-bubble">
                {m.role === 'assistant' && m.thinking && (() => {
                  // Edge case: модель эмитнула ТОЛЬКО thinking без видимого
                  // ответа (короткий запрос → длинное рассуждение → done без
                  // финального текста). Чтобы пузырь не казался пустым —
                  // автоматически разворачиваем блок и показываем подпись.
                  const hasVisibleAnswer = !!(m.content && m.content.trim())
                  const isFinal = !isStreamingAssistant
                  const onlyThinking = !hasVisibleAnswer && isFinal
                  return (
                    <details className="gg-thinking" open={onlyThinking || undefined}>
                      <summary className="gg-thinking-summary">
                        <span>💭</span>
                        <span>{onlyThinking ? 'Только размышление, без видимого ответа' : 'Размышление модели'}</span>
                        <span className="gg-thinking-len">{m.thinking.length} симв.</span>
                      </summary>
                      <div className="gg-thinking-body">
                        <Markdown text={m.thinking} onOpenFile={onOpenFilePreview} />
                      </div>
                    </details>
                  )
                })()}
                {changedFiles.length > 0 && (
                  <div className="gg-changed-files">
                    <div className="gg-changed-files-title">✓ Изменены файлы ({changedFiles.length})</div>
                    {changedFiles.map((f, ci) => (
                      <div key={ci} className="gg-changed-files-row">{f}</div>
                    ))}
                  </div>
                )}
                {m.attachments?.length ? (
                  <div className="gg-msg-attachments">
                    {m.attachments.map((a, ai) => (
                      <AttachmentPreview key={ai} attachment={a} compact />
                    ))}
                  </div>
                ) : null}
                {renderedContent
                  ? (m.role === 'assistant'
                      ? <Markdown text={renderedContent} onOpenFile={onOpenFilePreview} />
                      : supplement
                        ? (
                          <>
                            <div className="gg-msg-supplement-tag">{supplement.tag}</div>
                            <span style={{ whiteSpace: 'pre-wrap' }}>{supplement.body}</span>
                          </>
                        )
                        : <span style={{ whiteSpace: 'pre-wrap' }}>{renderedContent}</span>)
                  : isStreamingAssistant
                    ? <div className="gg-typing"><span /><span /><span /></div>
                    : null
                }
              </div>
              )}
              {m.role === 'user' && m.source === 'reminder' && (
                <div className="gg-msg-source-note">Отправлено автоматически из раздела Напоминания</div>
              )}
              {m.role === 'user' && !!m.appliedSkills?.length && (
                <div className="gg-msg-skill-note" title="Эти скиллы были применены только к этому сообщению">
                  <span className="gg-msg-skill-note-label">
                    {m.appliedSkills.length === 1 ? 'Применён скилл' : 'Применены скиллы'}
                  </span>
                  <span className="gg-msg-skill-note-list">
                    {m.appliedSkills.map(skill => (
                      <span key={skill.id} className="gg-msg-skill-note-pill">
                        {skill.icon && <span aria-hidden>{skill.icon}</span>}
                        <span>{skillDisplayName(skill)}</span>
                      </span>
                    ))}
                  </span>
                </div>
              )}
              {m.content && !isStreamingAssistant && (
                <MessageActions
                  text={m.content}
                  // «Править» — только на своём (user) сообщении, записанном в БД (есть dbId).
                  // Ведёт в ветку через editViaFork: оригинальный чат остаётся нетронутым.
                  onEdit={m.role === 'user' && typeof m.dbId === 'number' && activeChatId != null
                    ? () => { void useProject.getState().editViaFork(activeChatId, m.dbId!) }
                    : undefined}
                />
              )}
              {/* Cross-verify pill: показываем под последним assistant-сообщением */}
              {isLast && m.role === 'assistant' && !isStreaming && crossVerify && (
                <div
                  className={`gg-cross-verify ${crossVerify.ok ? 'is-ok' : 'is-warn'}`}
                  onClick={() => setCvExpanded(v => !v)}
                  title={cvExpanded ? 'Свернуть' : 'Развернуть результат ревью'}
                >
                  <span className="gg-cv-badge">
                    {crossVerify.ok ? '✅' : '⚠️'} Проверено {crossVerify.provider}
                    <span className="gg-cv-chevron">{cvExpanded ? '▴' : '▾'}</span>
                  </span>
                  {cvExpanded && (
                    <div className="gg-cv-detail">{crossVerify.result}</div>
                  )}
                </div>
              )}
            </div>
            </Fragment>
          )
        })}
        {/* Crash-resume: keep it next to the latest interrupted answer, not above the scrolled history. */}
        <ResumeBanner />
        </div>
        </div>
        {showScrollDown && (
          <button
            type="button"
            className="gg-chat-scroll-down"
            onClick={() => scrollChatToBottom('smooth')}
            title={t.chat.scrollToBottom}
            aria-label={t.chat.scrollToBottom}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}
        {queueNotice && (
          <div className="gg-chat-queue-notice-anchor">
            <div className="gg-chat-queue-notice" role="status" aria-live="polite">
              <span className="gg-chat-queue-notice-text">{queueNotice}</span>
              <span className="gg-chat-queue-notice-arrow" aria-hidden>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </span>
            </div>
          </div>
        )}
        {exportNotice && (
          <div className="gg-chat-export-notice-anchor">
            <div className={`gg-chat-export-notice ${exportNotice.ok ? 'is-ok' : 'is-error'}`} role="status" aria-live="polite">
              <div className="gg-chat-export-notice-icon" aria-hidden>{exportNotice.ok ? '✓' : '!'}</div>
              <div className="gg-chat-export-notice-copy">
                <div className="gg-chat-export-notice-title">{exportNotice.title}</div>
                <div className="gg-chat-export-notice-detail">{exportNotice.detail}</div>
              </div>
              <button
                type="button"
                className="gg-chat-export-notice-close"
                onClick={() => setExportNotice(null)}
                aria-label="Закрыть уведомление"
              >
                ×
              </button>
            </div>
          </div>
        )}
        {(queuedMessages.length > 0 || (isStreaming && pendingSupplements.length > 0)) && (
          <ComposerPendingBar
            queueItems={queuedMessages}
            supplements={pendingSupplements}
            expanded={pendingBarExpanded}
            onToggle={() => setPendingBarExpanded(v => !v)}
            onRemoveQueueItem={removeQueuedMessage}
            onRemoveSupplement={id => void removePendingSupplement(id)}
            onMoveQueueItemToContext={id => void moveQueuedMessageToContext(id)}
            onEditQueueItem={editQueuedMessage}
          />
        )}
      </div>

      <TimelineBar />
      <ReviewPanel />
      <PipelineBanner onPrimary={step => { void onPipelinePrimary(step) }} />
      {pipelineWizardOpen && (
        <PipelineWizard
          mode={pipelineWizardMode}
          chatId={activeChatId}
          initialBrief={pipelineInitialBrief}
          onClose={() => { setPipelineWizardOpen(false); setPipelineInitialBrief(undefined); setPipelineWizardMode('agency') }}
          onStarted={onPipelineStarted}
        />
      )}

      {isStreaming && agentProgress.length > 0 && (
        <div className="gg-agent-progress-host">
          <AgentProgressPanel
            entries={agentProgress}
            isStreaming={isStreaming}
            elapsedMs={agentProgressElapsedMs}
            durationMs={agentProgressDurationMs}
            finishedAt={agentProgressFinishedAt}
            onToggleOpen={handleAgentProgressToggle}
          />
        </div>
      )}

      <div className="gg-composer">
        <WorktreeBar />
        {attachments.length > 0 && (
          <div className="gg-attach-row">
            {attachments.map((a, i) => (
              <AttachmentChip key={i} attachment={a} onRemove={() => removeAttachment(i)} />
            ))}
          </div>
        )}
        {showVisionBanner && (
          <VisionAttachmentBanner
            currentProviderId={provider.id}
            currentProviderLabel={provider.label}
            onSwitch={switchVisionModel}
            onOpenSettings={onOpenSettings}
            onDismiss={() => setVisionBannerDismissed(true)}
          />
        )}
        {warning && <div className="gg-composer-warning">{warning}</div>}
        {contextCompactNotice && (
          <div className={`gg-context-compact-toast ${contextCompactNotice.loading ? 'is-loading' : 'is-done'}`} role="status" aria-live="polite">
            <span className="gg-context-compact-spinner" aria-hidden />
            <span>{contextCompactNotice.text}</span>
          </div>
        )}
        {exhausted && !isStreaming && (
          <div className="gg-budget-bar">
            <span>⏸ Бюджет {exhausted.used} ходов исчерпан — задача не завершена.</span>
            <div className="gg-budget-actions">
              <button
                className="gg-btn gg-btn-primary"
                onClick={() => void continueWithMoreTurns()}
                title={`Продолжить с тем же контекстом, +${exhausted.suggestedAdd} ходов`}
              >+{exhausted.suggestedAdd} ходов</button>
              <button
                className="gg-btn gg-btn-ghost"
                onClick={() => setExhausted(null)}
              >Закрыть</button>
            </div>
          </div>
        )}
        {appliedSkills.length > 0 && (
          <div className="gg-applied-skills-draft" aria-label="Скиллы, применённые к текущему сообщению">
            <span className="gg-applied-skills-draft-label">К сообщению применено</span>
            <div className="gg-applied-skills-draft-list">
              {appliedSkills.map(skill => (
                <span key={skill.id} className="gg-applied-skill-chip">
                  {skill.icon && <span aria-hidden>{skill.icon}</span>}
                  <span>{skillDisplayName(skill)}</span>
                  <button
                    type="button"
                    onClick={() => removeAppliedSkill(skill.id)}
                    title={`Убрать скилл ${skillDisplayName(skill)} из этого сообщения`}
                    aria-label={`Убрать скилл ${skillDisplayName(skill)} из этого сообщения`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
        {!isHelpChat && activeSkillForComposer && (
          <div className="gg-active-skill-bar">
            <div className="gg-active-skill-main">
              <span className="gg-active-skill-dot" aria-hidden />
              <span className="gg-active-skill-kicker">Активен скилл</span>
              <strong>{skillDisplayName(activeSkillForComposer)}</strong>
              <span className="gg-active-skill-detail">следующее сообщение пойдёт по его инструкции</span>
            </div>
            <button
              type="button"
              className="gg-active-skill-clear"
              onClick={() => useSkillsStore.getState().setActiveSkill(null)}
            >
              Снять
            </button>
          </div>
        )}
        {!isHelpChat && skillSuggestionsToast != null && (
          <div className="gg-skill-suggest-toast" role="status" aria-live="polite">
            Рекомендации скиллов скрыты. Вернуть их можно в «Инструментах чата».
          </div>
        )}
        {suggestedRecipe && (
          <div className="gg-skill-suggest is-recipe">
            <div className="gg-skill-suggest-icon" aria-hidden>{suggestedRecipe.icon ?? '◎'}</div>
            <div className="gg-skill-suggest-main">
              <div className="gg-skill-suggest-kicker">Рекомендованный workflow</div>
              <div className="gg-skill-suggest-title">{skillDisplayName(suggestedRecipe)}</div>
              <div className="gg-skill-suggest-detail">
                Применится только к этому сообщению и даст модели строгий порядок работы.
              </div>
            </div>
            <button
              type="button"
              className="gg-skill-suggest-accept"
              onClick={() => applySkillToCurrentMessage(suggestedRecipe)}
            >Применить</button>
            <button
              type="button"
              className="gg-skill-suggest-project-off"
              onClick={() => setProjectSkillSuggestionsEnabled(false)}
              title="Отключить рекомендации скиллов в этом проекте"
            >Не показывать</button>
            <button
              type="button"
              className="gg-skill-suggest-dismiss"
              onClick={() => setDismissedRecipeId(suggestedRecipe.id)}
              title="Скрыть предложение"
            >×</button>
          </div>
        )}
        {suggestedSkills.length > 0 && !suggestedRecipe && (
          <div className="gg-skill-suggest">
            <div className="gg-skill-suggest-icon" aria-hidden>{suggestedSkills.length === 1 ? (suggestedSkills[0].icon ?? '◎') : '＋'}</div>
            <div className="gg-skill-suggest-main">
              <div className="gg-skill-suggest-kicker">
                {suggestedSkills.length === 1 ? 'Рекомендованный скилл' : 'Рекомендованные скиллы'}
              </div>
              <div className="gg-skill-suggest-title">
                {suggestedSkills.length === 1 ? skillDisplayName(suggestedSkills[0]) : `${suggestedSkills.length} регламента под задачу`}
              </div>
              <div className="gg-skill-suggest-detail">
                Подключаются только к текущему сообщению и передаются модели как прямое указание.
              </div>
              <div className="gg-skill-suggest-chips" aria-label="Подходящие скиллы">
                {suggestedSkills.map(skill => (
                  <span key={skill.id} className="gg-skill-suggest-chip">
                    {skill.icon && <span aria-hidden>{skill.icon}</span>}
                    <span>{skillDisplayName(skill)}</span>
                    <button
                      type="button"
                      onClick={() => applySkillToCurrentMessage(skill)}
                      title={`Применить ${skillDisplayName(skill)} к текущему сообщению`}
                    >+</button>
                  </span>
                ))}
              </div>
            </div>
            <button
              type="button"
              className="gg-skill-suggest-accept"
              onClick={() => suggestedSkills.forEach(skill => applySkillToCurrentMessage(skill))}
            >{suggestedSkills.length === 1 ? 'Применить' : 'Применить все'}</button>
            <button
              type="button"
              className="gg-skill-suggest-project-off"
              onClick={() => setProjectSkillSuggestionsEnabled(false)}
              title="Отключить рекомендации скиллов в этом проекте"
            >Не показывать</button>
            <button
              type="button"
              className="gg-skill-suggest-dismiss"
              onClick={() => setDismissedSuggestIds(prev => {
                const next = new Set(prev)
                suggestedSkills.forEach(skill => next.add(skill.id))
                return next
              })}
              title="Скрыть предложение"
            >×</button>
          </div>
        )}
        <div className="gg-composer-inner">
          {!isHelpChat && (
            <MentionPopup
              text={input}
              projectPath={activePath}
              onReplace={next => setInput(next)}
            />
          )}
          <SlashCommandPopup
            text={input}
            onClear={() => setInput('')}
            onInject={text => setInput(text)}
            projectPath={activePath}
            helpScope={isHelpChat}
            systemCommands={isHelpChat ? [] : [
              {
                kind: 'system',
                trigger: 'new',
                label: 'Новый чат',
                description: 'Создать новый чат в проекте',
                icon: '➕',
                action: () => { void useProject.getState().newChatSession() }
              },
              {
                kind: 'system',
                trigger: 'clear',
                label: 'Очистить контекст',
                description: 'Снять активный скилл (сообщения остаются)',
                icon: '∅',
                action: () => { useSkillsStore.getState().setActiveSkill(null) }
              },
              // Мультиагент: системные команды инжектят шаблон в композер. Сам
              // execute() в popup после action() зовёт onClear() (= setInput('')),
              // поэтому ставим значение в следующий тик, иначе очистка перетрёт
              // шаблон. Курсор остаётся в textarea — пользователь дописывает цель.
              {
                kind: 'system',
                trigger: MULTI_AGENT_TEMPLATES.orchestrate.trigger,
                label: MULTI_AGENT_TEMPLATES.orchestrate.label,
                description: 'Оркестратор — разбить цель на подзадачи по ролям',
                icon: MULTI_AGENT_TEMPLATES.orchestrate.icon,
                action: () => injectTemplate(MULTI_AGENT_TEMPLATES.orchestrate.template)
              },
              {
                kind: 'system',
                trigger: MULTI_AGENT_TEMPLATES.swarm.trigger,
                label: MULTI_AGENT_TEMPLATES.swarm.label,
                description: 'Рой — N агентов разными стратегиями + арбитр',
                icon: MULTI_AGENT_TEMPLATES.swarm.icon,
                action: () => injectTemplate(MULTI_AGENT_TEMPLATES.swarm.template)
              },
              {
                kind: 'system',
                trigger: MULTI_AGENT_TEMPLATES.parallel.trigger,
                label: MULTI_AGENT_TEMPLATES.parallel.label,
                description: 'Параллельно — пакет независимых задач суб-агентам',
                icon: MULTI_AGENT_TEMPLATES.parallel.icon,
                action: () => injectTemplate(MULTI_AGENT_TEMPLATES.parallel.template)
              }
            ]}
          />
          <textarea
            ref={textareaRef}
            className="gg-composer-textarea"
            value={input}
            rows={1}
            onChange={e => setInput(e.target.value)}
            onPaste={onPaste}
            onKeyDown={e => {
              // SlashCommandPopup глобально обрабатывает Enter/Esc когда
              // текст начинается с "/". Не отправляем сообщение в этом случае.
              const slashOpen = input.startsWith('/') && !input.includes('\n')
              if (slashOpen && (e.key === 'Enter' || e.key === 'Escape' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                return  // popup сам всё обработает
              }
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && isStreaming && input.trim()) {
                e.preventDefault()
                void appendToCurrentContext()
                return
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                e.preventDefault()
                if (isStreaming && input.trim()) {
                  queueFollowUp(input.trim())
                  return
                }
                void send()
              }
              if (e.key === 'Escape' && isStreaming) {
                e.preventDefault()
                void stop()
              }
            }}
            placeholder={isStreaming ? `${provider.label} ${t.chat.streamingPlaceholder}` : t.chat.placeholder}
          />
          <div className="gg-composer-actions">
            <button
              type="button"
              className="gg-attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={isStreaming}
              title="Прикрепить файл"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 11.5a8.38 8.38 0 0 1 -8.5 8.5 8.5 8.5 0 0 1 -8.5 -8.5 8.5 8.5 0 0 1 17 0z" style={{ display: 'none' }} />
                <path d="m21.44 11.05 -9.19 9.19a6 6 0 0 1 -8.49 -8.49l9.19 -9.19a4 4 0 0 1 5.66 5.66L9.41 17.41a2 2 0 0 1 -2.83 -2.83l8.49 -8.48" />
              </svg>
            </button>
            <VoiceInput
              disabled={isStreaming}
              onTranscript={chunk => setInput(prev => prev + chunk)}
            />
            <EffortPicker />
            {isStreaming ? (
              <>
              {/* ⏸ только для API-провайдеров с проектом: только этот путь пишет чекпойнт
                  (runApiConversation). CLI/справка не чекпойнтят → ⏸ был бы молча=⏹. */}
              {provider.supportsTools && !helpMode && (
              <button
                className="gg-send-btn gg-pause-btn"
                onClick={() => void stop(true)}
                title="Приостановить — сохранить прогресс и продолжить позже (↻)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="5" width="4" height="14" rx="1" />
                  <rect x="14" y="5" width="4" height="14" rx="1" />
                </svg>
              </button>
              )}
              <button
                className="gg-send-btn gg-stop-btn"
                onClick={() => void stop()}
                title="Остановить (Esc)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="1.5" />
                </svg>
              </button>
              </>
            ) : (
              <button
                className="gg-send-btn"
                onClick={() => void send()}
                disabled={!canSend}
                title="Отправить (Enter)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12l14 -8l-4 16l-4 -6l-6 -2z" />
                </svg>
              </button>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            accept={CHAT_FILE_ACCEPT}
            onChange={onFilesPicked}
          />
        </div>
        <div className="gg-composer-hint">
          {isStreaming && input.trim() ? (
            <div className="gg-composer-insights">
              {isStreaming && input.trim() && (
                <div className="gg-composer-streaming-hint">
                  <span>
                    <kbd className="gg-kbd">Ctrl+Enter</kbd>
                    {' - '}
                    {t.chat.streamingAppendHint}
                    {' / '}
                    <kbd className="gg-kbd">Enter</kbd>
                    {' - '}
                    {t.chat.streamingQueueHint}
                  </span>
                </div>
              )}
            </div>
          ) : null}
          {false && isStreaming && input.trim() && (
            <div className="gg-composer-streaming-hint">
              <span>
                <kbd className="gg-kbd">Ctrl+Enter</kbd>
                {' - '}
                {t.chat.streamingAppendHint}
                {' / '}
                <kbd className="gg-kbd">Enter</kbd>
                {' - '}
                {t.chat.streamingQueueHint}
              </span>
            </div>
          )}
          <div className="gg-composer-meta">
            <div className="gg-composer-meta-cluster">
              {previewTokens && previewTokens.tokens > 0 && (() => {
                const cost = estimateCost(provider.id, provider.model, previewTokens.tokens, 0, 0)
                const title = previewTokens.exact
                  ? `Точная оценка от ${provider.label}: ${previewTokens.tokens} токенов на следующий запрос${cost.usd ? `, ~${cost.usd} (только input)` : ''}`
                  : `Грубая оценка (4 символа = 1 токен): ${previewTokens.tokens} токенов`
                return (
                  <>
                    <TokenPreviewMeter tokens={previewTokens.tokens} exact={previewTokens.exact} title={title} />
                    {cost.usd && previewTokens.exact && (
                      <span className="gg-usage-pill is-preview is-cost-hint" title={title}>
                        <span className="gg-usage-cost">~{cost.usd}</span>
                      </span>
                    )}
                  </>
                )
              })()}
              {(sessionUsage.inputTokens > 0 || sessionUsage.outputTokens > 0) && (() => {
                // 2.0.8-E хвост: передаём семантику провайдера — иначе у Claude (exclusive)
                // из input повторно вычитался кэш и ценник занижал реальную стоимость (дефект B).
                const cost = estimateCost(provider.id, provider.model, sessionUsage.inputTokens, sessionUsage.outputTokens, sessionUsage.cachedInputTokens, sessionUsage.inputAccounting)
                const severity = costSeverity(cost.cents)
                const breakdown = costBreakdown(provider.id, provider.model, sessionUsage.inputTokens, sessionUsage.outputTokens, sessionUsage.cachedInputTokens, sessionUsage.inputAccounting)
                return (
                  <span className={`gg-usage-pill ${severity}`} title={breakdown}>
                    <span>↑{formatTokens(sessionUsage.inputTokens)}</span>
                    <span className="gg-usage-sep">·</span>
                    <span>↓{formatTokens(sessionUsage.outputTokens)}</span>
                    {sessionUsage.cachedInputTokens > 0 && (
                      <>
                        <span className="gg-usage-sep">·</span>
                        <span title="Cached input">⟲{formatTokens(sessionUsage.cachedInputTokens)}</span>
                      </>
                    )}
                    {cost.usd && (
                      <>
                        <span className="gg-usage-sep">·</span>
                        <span className="gg-usage-cost">{cost.usd}</span>
                      </>
                    )}
                  </span>
                )
              })()}
              {sessionStats && sessionStats.runs > 0 && (
                <span
                  className="gg-usage-pill"
                  title={`Σ за всю сессию (${sessionStats.runs} прогон(ов)${sessionStats.durationMs > 1000 ? ` · ${Math.max(1, Math.round(sessionStats.durationMs / 60000))} мин` : ''}) — переживает рестарт`}
                >
                  <span>Σ ${(sessionStats.costCents / 100).toFixed(2)}</span>
                  {sessionStats.toolCount > 0 && (<><span className="gg-usage-sep">·</span><span>🔧{sessionStats.toolCount}</span></>)}
                  {sessionStats.filesCount > 0 && (<><span className="gg-usage-sep">·</span><span>📄{sessionStats.filesCount}</span></>)}
                </span>
              )}
              {undoCount > 0 && !chatIsolated && (
                <button
                  type="button"
                  className="gg-undo-btn"
                  onClick={() => void revertLastWrite()}
                  title="Откатить последнюю правку файла"
                >
                  <span>↶</span>
                  <span className="gg-undo-count">{undoCount}</span>
                </button>
              )}
              <button
                type="button"
                className={`gg-auto-scroll-btn ${autoScrollEnabled ? 'is-on' : 'is-off'}`}
                onClick={toggleAutoScroll}
                title={autoScrollEnabled ? t.chat.autoScrollOn : t.chat.autoScrollOff}
                aria-pressed={autoScrollEnabled}
              >
                {autoScrollEnabled ? t.chat.autoScrollLabelOn : t.chat.autoScrollLabelOff}
              </button>
              <DevTaskBadge />
            </div>
            <div className="gg-composer-meta-cluster gg-composer-meta-cluster--end">
              <div className="gg-chat-settings-wrap" ref={composerSettingsRef}>
                <button
                  type="button"
                  className={`gg-chat-settings-btn ${composerSettingsOpen ? 'is-active' : ''}`}
                  onClick={() => setComposerSettingsOpen(v => !v)}
                  title="Инструменты чата"
                  aria-expanded={composerSettingsOpen}
                >
                  <span>Инструменты чата</span>
                </button>
                {composerSettingsOpen && (
                  <div className="gg-chat-settings-popover">
                    <div className="gg-chat-settings-grid">
                      <div className="gg-chat-settings-item gg-chat-settings-item--model">
                        <span className="gg-chat-settings-label">Модель</span>
                        <div className="gg-chat-settings-model-control">
                          <ModelPicker onOpenSettings={onOpenSettings} />
                          <span className={`gg-chat-settings-model-kind ${isCliProvider(provider.id) ? 'is-cli' : 'is-api'}`}>
                            {isCliProvider(provider.id) ? 'CLI' : 'API'}
                          </span>
                        </div>
                      </div>
                      <div className="gg-chat-settings-item gg-chat-settings-item--mode">
                        <span className="gg-chat-settings-label">Режим</span>
                        <ModePicker
                          mode={isHelpChat ? HELP_AGENT_MODE : agentMode}
                          onChange={m => { void applyMode(m) }}
                          locked={isHelpChat}
                        />
                      </div>
                      {!isHelpChat && (
                        <div className="gg-chat-settings-item">
                          <span className="gg-chat-settings-label">Инструменты</span>
                          <ComposerToolsMenu
                            onInject={injectTemplate}
                            onSaveHandoff={saveHandoffToDownloads}
                            onExportTranscript={exportTranscript}
                            exportBusy={handoffBusy}
                          />
                        </div>
                      )}
                      {!isHelpChat && (
                        <div className="gg-chat-settings-item">
                          <span className="gg-chat-settings-label">Скиллы</span>
                          <button
                            type="button"
                            className="gg-chat-settings-toggle-control"
                            onClick={() => setProjectSkillSuggestionsEnabled(!skillSuggestionsEnabled)}
                            title="Показывать автоматические рекомендации скиллов в этом проекте"
                          >
                            <span className="gg-chat-settings-toggle-text">Рекомендации скиллов</span>
                            <span className={`gg-toggle ${skillSuggestionsEnabled ? 'is-on' : ''}`} aria-hidden>
                              <span className="gg-toggle-knob" />
                            </span>
                          </button>
                        </div>
                      )}
                      {!isHelpChat && !activePipeline && (
                        <div className="gg-chat-settings-item">
                          <span className="gg-chat-settings-label">Pipeline</span>
                          <button
                            type="button"
                            className="gg-btn gg-btn-ghost gg-btn-xs gg-pipeline-entry"
                            onClick={() => {
                              setComposerSettingsOpen(false)
                              setPipelineWizardMode('agency')
                              setPipelineWizardOpen(true)
                            }}
                            disabled={isCliProvider(provider.id)}
                            title={isCliProvider(provider.id) ? t.pipeline.cliGate : t.pipeline.title}
                          >
                            ▶ Agency task
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <button
                type="button"
                className={`gg-chat-turbo-btn ${agentMode === 'auto' || agentMode === 'bypass' ? 'is-turbo' : 'is-simple'}`}
                onClick={() => { void setAgentMode(agentMode === 'auto' || agentMode === 'bypass' ? 'ask' : 'auto') }}
                disabled={isHelpChat}
                title={
                  isHelpChat
                    ? 'В справке режим зафиксирован'
                    : agentMode === 'auto' || agentMode === 'bypass'
                      ? 'Турбо-режим включён. Нажмите, чтобы вернуться в простой режим.'
                      : 'Включить турбо-режим: агент будет выполнять действия быстрее и принимать правки автоматически.'
                }
                aria-label={agentMode === 'auto' || agentMode === 'bypass' ? 'Выключить турбо-режим' : 'Включить турбо-режим'}
                aria-pressed={agentMode === 'auto' || agentMode === 'bypass'}
              >
                <span aria-hidden>🔥</span>
              </button>
              {!isHelpChat && !activePipeline && (
                <button
                  type="button"
                  className="gg-btn gg-btn-ghost gg-btn-xs gg-pipeline-entry"
                  onClick={() => { setPipelineWizardMode('agency'); setPipelineWizardOpen(true) }}
                  disabled={isCliProvider(provider.id)}
                  title={isCliProvider(provider.id) ? t.pipeline.cliGate : t.pipeline.title}
                >
                  ▶ Agency task
                </button>
              )}
              {!isHelpChat && (
                <ComposerToolsMenu
                  onInject={injectTemplate}
                  onSaveHandoff={saveHandoffToDownloads}
                  onExportTranscript={exportTranscript}
                  exportBusy={handoffBusy}
                />
              )}
              <ModePicker
                mode={isHelpChat ? HELP_AGENT_MODE : agentMode}
                onChange={m => { void applyMode(m) }}
                locked={isHelpChat}
              />
              {!isHelpChat && <IntensityToggle />}
              <ModelPicker onOpenSettings={onOpenSettings} />
              {!isHelpChat && <PromptRouteControl />}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Hover toolbar shown under every message — copy-to-clipboard for now.
 * Hidden by default; fades in on .gg-msg:hover (см. layout.css).
 * При наведении появляется кнопка копирования.
 */
function MessageActions({ text, onEdit }: { text: string; onEdit?: () => void }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch { /* clipboard может быть запрещён — молча игнорим */ }
  }
  return (
    <div className="gg-msg-actions">
      {/* 2.0.11-D: «править» доступна только на своих сообщениях. Правка не меняет
          оригинал — создаёт ветку с этого места, текст ждёт черновиком в композере. */}
      {onEdit && (
        <button
          type="button"
          className="gg-msg-action"
          onClick={onEdit}
          title="Править в новой ветке (оригинал не меняется)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
          <span>править</span>
        </button>
      )}
      <button
        type="button"
        className="gg-msg-action"
        onClick={() => void copy()}
        title="Скопировать текст сообщения"
      >
        {copied ? (
          <>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>скопировано</span>
          </>
        ) : (
          <>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            <span>копировать</span>
          </>
        )}
      </button>
    </div>
  )
}

function AttachmentChip({ attachment, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  const isImage = attachment.mimeType.startsWith('image/')
  const src = isImage ? `data:${attachment.mimeType};base64,${attachment.data}` : null
  return (
    <div className="gg-attach-chip">
      {src ? <img src={src} alt={attachment.name} className="gg-attach-thumb" /> : <div className="gg-attach-icon">📄</div>}
      <div className="gg-attach-meta">
        <div className="gg-attach-name" title={attachment.name}>{attachment.name}</div>
        <div className="gg-attach-size">{formatSize(attachment.size)}</div>
      </div>
      <button className="gg-attach-remove" onClick={onRemove} title="Убрать">×</button>
    </div>
  )
}

function AttachmentPreview({ attachment, compact }: { attachment: Attachment; compact?: boolean }) {
  const isImage = attachment.mimeType.startsWith('image/')
  if (isImage) {
    return (
      <img
        src={`data:${attachment.mimeType};base64,${attachment.data}`}
        alt={attachment.name}
        className={compact ? 'gg-msg-image' : ''}
        style={{ maxWidth: compact ? 360 : '100%', maxHeight: compact ? 280 : '100%', borderRadius: 8, display: 'block', marginBottom: 6 }}
      />
    )
  }
  return (
    <div className="gg-attach-chip" style={{ marginBottom: 6 }}>
      <div className="gg-attach-icon">📄</div>
      <div className="gg-attach-meta">
        <div className="gg-attach-name">{attachment.name}</div>
        <div className="gg-attach-size">{formatSize(attachment.size)}</div>
      </div>
    </div>
  )
}
