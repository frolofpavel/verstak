import { useEffect, useRef, useState, type DragEvent, type ClipboardEvent } from 'react'
import { useProject } from '../store/projectStore'
import { useProvider } from '../hooks/useProvider'
import { estimateCost, costSeverity, costBreakdown } from '../lib/pricing'
import { Markdown } from './Markdown'
import { ModelPicker } from './ModelPicker'
import { TierRecommendation } from './TierRecommendation'
import { ModePicker } from './ModePicker'
import { VoiceInput } from './VoiceInput'
import { TimelineBar } from './TimelineBar'
import { ReviewPanel } from './ReviewPills'
import { CheckpointButton } from './CheckpointButton'
import { ReviewButton } from './ReviewButton'
import { SkillPicker } from './SkillPicker'
import { SlashCommandPopup, type SlashCommand } from './SlashCommandPopup'
import { useSkills as useSkillsStore } from '../store/skillStore'
import { useAgentMode } from '../hooks/useAgentMode'
import type { Attachment, Suggestion } from '../types/api'
import iconUrl from '../assets/icon.png'
import { useT } from '../i18n'
import { notifyResponseReady } from '../lib/response-notify'


function chatLabel(chatId: number): string {
  const title = useProject.getState().chatSessions.find(s => s.id === chatId)?.title
  return title ? `Ответ готов — ${title}` : 'Ответ готов'
}

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

const ACCEPTED_MIME_PREFIXES = ['image/', 'text/', 'application/pdf', 'application/json']

type RightPanel = 'none' | 'terminal' | 'files' | 'sidechat'

interface ChatProps {
  onOpenSettings: () => void
  rightPanel: RightPanel
  onSelectRightPanel: (panel: RightPanel) => void
  /** Open the right-docked parallel chat (lazily created by App). */
  onOpenSideChat: () => void

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

function isAcceptable(mime: string): boolean {
  return ACCEPTED_MIME_PREFIXES.some(p => mime.startsWith(p))
}

async function blobToAttachment(blob: Blob, fallbackName: string): Promise<Attachment | null> {
  if (blob.size > MAX_BYTES_PER_FILE) return null
  const mimeType = blob.type || 'application/octet-stream'
  if (!isAcceptable(mimeType)) return null
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  const data = btoa(binary)
  return {
    name: (blob as File).name || fallbackName,
    mimeType,
    data,
    size: blob.size
  }
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

export function Chat({ onOpenSettings, rightPanel, onSelectRightPanel, onOpenSideChat }: ChatProps) {
  const t = useT()
  // Codex-style right-panel menu anchored to the top-right header button.
  const [panelMenuOpen, setPanelMenuOpen] = useState(false)
  const panelMenuRef = useRef<HTMLDivElement>(null)
  const { messages, addMessage, updateLastAssistant, isStreaming, setStreaming, activity, preflights, subagentRuns, sessionUsage, path: activePath, chatSessions, activeChatId, effortLevel, setEffortLevel } = useProject()
  const { mode: agentMode, setMode: setAgentMode } = useAgentMode()
  const projectName = activePath ? activePath.replace(/^.*[\\/]/, '') : null
  const activeChatTitle = chatSessions.find(s => s.id === activeChatId)?.title ?? null
  const provider = useProvider()
  const [input, setInput] = useState('')
  /** Live token-count preview for whatever is in the composer right now. */
  const [previewTokens, setPreviewTokens] = useState<{ tokens: number; exact: boolean } | null>(null)
  /** If the agent loop exhausted its budget on the last send, the user can click "+N turns" to extend. */
  const [exhausted, setExhausted] = useState<{ used: number; suggestedAdd: number; maxBudget: number } | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)
  const streamRef = useRef<HTMLDivElement>(null)
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
  const currentSendIdRef = useRef<number | null>(null)
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

  async function addBlobs(blobs: Array<{ blob: Blob; nameHint: string }>) {
    const added: Attachment[] = []
    for (const { blob, nameHint } of blobs) {
      if (attachments.length + added.length >= MAX_ATTACHMENTS) {
        flashWarning(`Можно прикрепить максимум ${MAX_ATTACHMENTS} файлов`)
        break
      }
      if (blob.size > MAX_BYTES_PER_FILE) {
        flashWarning(`${nameHint}: больше ${formatSize(MAX_BYTES_PER_FILE)}, пропущен`)
        continue
      }
      const att = await blobToAttachment(blob, nameHint)
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
      const store = useProject.getState()
      // Routing через единый sendOwners реестр (был двойной мап:
      // sendIdToChatId + sendIdToReviewChatId — давало race-баги).
      // Owner определяет КУДА события идут:
      //  - 'review' → reviews state, не трогает main чат
      //  - 'chat' → если не активный, в chatSnapshots; если активный, в
      //             основное состояние ниже по логике
      const owner = store.lookupSendOwner(id)
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
      // Route background-project events to the snapshot store so they don't
      // mutate the currently-visible session.
      if (projectPath && projectPath !== store.path) {
        store.applyEventToSession(projectPath, event as unknown as { type: string; [k: string]: unknown })
        // sendOwners leak fix: stream завершается → удаляем owner, иначе
        // мапа растёт при каждом переключении проекта во время активного
        // стрима в фоне.
        if (event.type === 'done') {
          void notifyResponseReady({ body: 'Ответ готов — фоновый проект' })
        } else if (event.type === 'error') {
          void notifyResponseReady({ body: 'Ошибка в фоновом проекте', isError: true })
        }
        if (event.type === 'done' || event.type === 'error') store.forgetSendOwner(id)
        return
      }
      // Route background-chat events (same project, different chat) to the
      // chat snapshot so the user's stream survives chat-switching.
      if (owner?.kind === 'chat' && owner.chatId !== store.activeChatId) {
        store.applyEventToChat(owner.chatId, event as unknown as { type: string; [k: string]: unknown })
        if (event.type === 'done') {
          void notifyResponseReady({ body: chatLabel(owner.chatId) })
        } else if (event.type === 'error') {
          void notifyResponseReady({ body: `Ошибка — ${chatLabel(owner.chatId)}`, isError: true })
        }
        if (event.type === 'done' || event.type === 'error') store.forgetSendOwner(id)
        return
      }
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
        // Same relative→absolute conversion as for read_file (see tool-activity
        // handler below). Tools emit project-relative paths; tree keys by abs.
        if (event.path && store.path) {
          const clean = event.path.replace(/^\.[\\/]/, '')
          const sep = store.path.includes('\\') ? '\\' : '/'
          const abs = `${store.path}${sep}${clean.replace(/[\\/]/g, sep)}`
          store.markFileTouched(abs, 'write')
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
            // Strip any leading "./" so join doesn't double up
            const clean = rel.replace(/^\.[\\/]/, '')
            const sep = store.path.includes('\\') ? '\\' : '/'
            const abs = `${store.path}${sep}${clean.replace(/[\\/]/g, sep)}`
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
          cachedInputTokens: event.usage.cachedInputTokens
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
          result: event.result
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
        setStreaming(false)
        store.forgetSendOwner(id)
        const chatTitle = store.activeChatId != null ? chatLabel(store.activeChatId) : 'Ответ готов'
        void notifyResponseReady({ body: chatTitle })
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
        setStreaming(false)
        store.forgetSendOwner(id)
        const errChat = store.activeChatId != null ? chatLabel(store.activeChatId) : 'Ошибка ответа'
        void notifyResponseReady({ body: errChat, isError: true })
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
    if (!stickToBottomRef.current && !pendingPinToBottomRef.current) return
    pendingPinToBottomRef.current = false
    pinChatToBottom('auto')
  }, [messages, autoScrollEnabled])

  useEffect(() => {
    const el = streamRef.current
    if (!el) return
    function onScroll() {
      const atBottom = isNearBottom(el)
      if (pendingPinToBottomRef.current) {
        setShowScrollDown(!atBottom && messages.length > 0)
        return
      }
      if (autoScrollEnabled) stickToBottomRef.current = atBottom
      setShowScrollDown(!atBottom && messages.length > 0)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [messages.length, autoScrollEnabled])

  // Refresh undo count when project changes / after each assistant turn settles
  useEffect(() => {
    const path = useProject.getState().path
    if (!path) { setUndoCount(0); return }
    void window.api.undo.count(path).then(setUndoCount)
  }, [messages.length])

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

  // Auto-grow textarea
  function autoGrow() {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'
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

  // Cleanup warning timer on unmount
  useEffect(() => () => { if (warningTimer.current) window.clearTimeout(warningTimer.current) }, [])

  // Close the right-panel menu on outside click.
  useEffect(() => {
    if (!panelMenuOpen) return
    function onDown(e: MouseEvent) {
      if (panelMenuRef.current && !panelMenuRef.current.contains(e.target as Node)) {
        setPanelMenuOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [panelMenuOpen])

  // Live token preview: debounce text changes (400ms) and ask the main process
  // to count tokens for the current draft. Gemini API gives an exact count;
  // CLI / other providers get a rough 4-chars-per-token estimate.
  useEffect(() => {
    const text = input.trim()
    if (!text) { setPreviewTokens(null); return }
    const timer = window.setTimeout(async () => {
      try {
        const state = useProject.getState()
        const res = await window.api.ai.countTokens(text, state.path, state.messages)
        setPreviewTokens({ tokens: res.tokens, exact: res.exact })
      } catch { /* silent: it's only a preview */ }
    }, 400)
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
    addMessage({ role: 'assistant', content: '' })
    setStreaming(true)
    // Send everything except the empty placeholder we just pushed
    const msgs = [...useProject.getState().messages].slice(0, -1)
    const sendId = await window.api.ai.sendWithBudget(msgs, store.path, newBudget)
    if (activeChatId != null) {
      useProject.getState().registerSendOwner(sendId, { kind: 'chat', chatId: activeChatId })
    }
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

  async function send() {
    const text = input.trim()
    if (!text && attachments.length === 0) return
    if (isStreaming) return
    const store = useProject.getState()
    const ctx = await ensureProjectForChat()
    if (!ctx) {
      flashWarning('Сначала открой папку проекта слева — без неё переписка не сохраняется.')
      return
    }
    const path = ctx.path
    const userAttachments = attachments
    store.clearActivity()
    setExhausted(null)  // new send wipes any pending continue state
    setCrossVerify(null)  // сбрасываем предыдущий результат cross-verify
    setInput('')
    setAttachments([])
    const summary = userAttachments.length > 0
      ? `${text}${text ? '\n\n' : ''}📎 ${userAttachments.map(a => a.name).join(', ')}`
      : text
    // Context loaders: если активен скилл с frontmatter context_loaders —
    // запускаем их и подмешиваем результат в content user-message ПЕРЕД
    // отправкой. Это делает скиллы реально мощными — скилл может подгрузить
    // нужные данные (карточку, отчёт, контекст) автоматически.
    let enrichedText = text
    const activeSkillForLoad = useSkillsStore.getState().activeSkillId
      ? useSkillsStore.getState().skills.find(s => s.id === useSkillsStore.getState().activeSkillId)
      : null
    if (activeSkillForLoad?.context_loaders?.length) {
      const isFirstUserMsg = !useProject.getState().messages.some(m => m.role === 'user')
      const trigger: 'chat_open' | 'slash_arg' = isFirstUserMsg ? 'chat_open' : 'slash_arg'
      try {
        const loaded = await window.api.skills.runLoaders(activeSkillForLoad.id, {
          trigger,
          projectPath: path,
          arg: text.split(/\s+/)[0]  // первое слово как arg (для /dossier alfa-development)
        })
        if (loaded.context) {
          enrichedText = `${loaded.context}\n\n---\n\n${text}`
        }
      } catch (err) {
        console.warn('[chat] skill loaders failed:', err)
      }
    }
    armAutoScrollForOutgoing()
    addMessage({ role: 'user', content: enrichedText, attachments: userAttachments })
    const activeChatId = ctx.activeChatId
    if (path && activeChatId) {
      // В БД сохраняем оригинальный text пользователя (без loader-контекста),
      // чтобы при reload UI не показывал жирный системный блок.
      await window.api.chats.append(activeChatId, path, 'user', summary)
      // log the start of a session — title is the first 80 chars of the request
      const journalTitle = text.length > 80 ? text.slice(0, 80) + '…' : (text || 'Сообщение с вложением')
      void window.api.journal.append(path, 'session', journalTitle,
        userAttachments.length > 0 ? `Вложений: ${userAttachments.length} (${userAttachments.map(a => a.name).join(', ')})` : null)
    }
    addMessage({ role: 'assistant', content: '' })
    setStreaming(true)
    const allMessages = [...useProject.getState().messages].slice(0, -1)
    // Skill override: если активен скилл — system prompt берётся из его тела.
    // Provider/model берутся из скилла ТОЛЬКО если активный выбор пользователя
    // несовместим с тем что предлагает скилл. Например: скилл говорит 'claude'
    // (API), пользователь выбрал 'claude-cli' (CLI/подписка) — оба = Claude,
    // НЕ переключаем. Это сохраняет выбор пользователя по подписке/API.
    const activeSkill = useSkillsStore.getState().activeSkillId
      ? useSkillsStore.getState().skills.find(s => s.id === useSkillsStore.getState().activeSkillId)
      : null
    let sendId: number
    if (activeSkill) {
      // Узнаём текущий provider пользователя — чтобы решить override или нет
      const currentProvider = await window.api.settings.getKey('provider')
      const skillProvider = activeSkill.default_provider
      // «Семейство» провайдера — для совместимости (claude vs claude-cli — одно)
      const family = (p: string | null | undefined): string =>
        (p ?? '').replace(/-cli$|-api$/, '').replace(/^gemini.*$/, 'gemini')
            .replace(/^(claude|grok|openai|codex).*$/, '$1')
      const overrideProvider = skillProvider && family(skillProvider) !== family(currentProvider)
        ? skillProvider
        : undefined
      const overrideModel = overrideProvider ? (activeSkill.default_model ?? null) : null
      // Anti-stall guard: некоторые скиллы — оркестраторы/штабы (los-hq, bos-hq,
      // навигаторы) с протоколом «жди пакет задачи / маршрутизируй / ✋ СТОП».
      // Базовый system-layer теперь НАСЛАИВАЕТСЯ под скилл (ipc/ai.ts передаёт
      // skillPrompt в prepareSystemContext — см. <skill_layer>), так что протокол
      // выполнения восстановлен. Но тело таких скиллов всё равно может сильно
      // давить «жди ТЗ»; nudge — дешёвое подкрепление: ясный запрос = действуй.
      const antiStallNudge = '\n\n---\nВАЖНО (Verstak): если пользователь дал ясный прямой запрос — выполни его прямо в этом чате и выдай результат. Не зацикливайся, прося оформить «пакет задачи», «одну фразу цели» или ждать отдельного «ок», если намерение уже понятно.'
      sendId = await window.api.ai.sendWithOverrides(allMessages, path, {
        systemPrompt: activeSkill.systemPrompt + antiStallNudge,
        ...(overrideProvider ? { providerId: overrideProvider } : {}),
        ...(overrideModel !== null ? { model: overrideModel } : {}),
        effortLevel: useProject.getState().effortLevel
      })
    } else {
      const effort = useProject.getState().effortLevel
      if (effort !== 'standard') {
        sendId = await window.api.ai.sendWithOverrides(allMessages, path, { effortLevel: effort })
      } else {
        sendId = await window.api.ai.send(allMessages, path)
      }
    }
    currentSendIdRef.current = sendId
    // Bind this send to the chat that initiated it — if user switches to
    // another chat mid-stream, the event handler will route events into
    // chatSnapshots[activeChatId] rather than corrupting the new active chat.
    if (activeChatId != null) {
      useProject.getState().registerSendOwner(sendId, { kind: 'chat', chatId: activeChatId })
    }
  }

  async function stop() {
    const id = currentSendIdRef.current
    if (id == null) return
    await window.api.ai.stop(id)
    setStreaming(false)
    // sendOwners cleanup: stop() = главное место где renderer знает, что
    // больше событий по этому sendId не придёт. Без этого owner повисал бы
    // в мапе, потому что done event на abort иногда теряется.
    useProject.getState().forgetSendOwner(id)
    currentSendIdRef.current = null
  }

  const hasMessages = messages.length > 0
  const canSend = !isStreaming && (input.trim().length > 0 || attachments.length > 0)

  return (
    <div
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

      {projectName && (
        <div className="gg-chat-project-bar" title={activePath ?? ''}>
          <span className="gg-chat-project-icon">📁</span>
          <span className="gg-chat-project-name">{projectName}</span>
          {activeChatTitle && (
            <>
              <span className="gg-chat-project-sep">·</span>
              <span className="gg-chat-project-chat">{activeChatTitle}</span>
            </>
          )}
          <div className="gg-chat-project-actions">
          {/* Меню панелей — файлы / терминал / параллельный чат */}
          <div className="gg-panel-menu" ref={panelMenuRef}>
            <button
              type="button"
              className={`gg-terminal-toggle ${rightPanel !== 'none' ? 'is-open' : ''}`}
              onClick={() => setPanelMenuOpen(v => !v)}
              title="Панели — файлы, терминал, параллельный чат"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
            </button>
            {panelMenuOpen && (
              <div className="gg-panel-menu-pop">
                <button
                  type="button"
                  className="gg-panel-menu-item"
                  onClick={() => { onSelectRightPanel(rightPanel === 'files' ? 'none' : 'files'); setPanelMenuOpen(false) }}
                >
                  <span className="gg-panel-menu-icon">📁</span>
                  <span className="gg-panel-menu-label">Файлы</span>
                  {rightPanel === 'files' && <span className="gg-panel-menu-check">✓</span>}
                </button>
                <button
                  type="button"
                  className="gg-panel-menu-item"
                  onClick={() => { onSelectRightPanel(rightPanel === 'terminal' ? 'none' : 'terminal'); setPanelMenuOpen(false) }}
                >
                  <span className="gg-panel-menu-icon">▱</span>
                  <span className="gg-panel-menu-label">Терминал</span>
                  {rightPanel === 'terminal' && <span className="gg-panel-menu-check">✓</span>}
                </button>
                <button
                  type="button"
                  className="gg-panel-menu-item"
                  onClick={() => { onOpenSideChat(); setPanelMenuOpen(false) }}
                >
                  <span className="gg-panel-menu-icon">💬</span>
                  <span className="gg-panel-menu-label">Параллельный чат</span>
                  {rightPanel === 'sidechat' && <span className="gg-panel-menu-check">✓</span>}
                </button>
              </div>
            )}
          </div>
          </div>
        </div>
      )}

      <div className="gg-chat-stream-area">
        <div className="gg-chat-stream" ref={streamRef}>
        <div className="gg-chat-stream-inner">
        {!hasMessages && (
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
                <span><b>5</b> 🚀 Без подтверждений — для CI / опытных</span>
              </div>
              <div className="gg-chat-empty-modes-tip">
                <b>Shift+Esc</b> — экстренный стоп всех сессий. Кнопка <b>📍 Чекпоинт</b> внизу — запомнить состояние файлов и откатить одним кликом.
              </div>
            </div>
            {activePath && (
              <div className="gg-chat-empty-quick">
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
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1
          const isStreamingAssistant = isLast && m.role === 'assistant' && isStreaming
          // Render activity rows just before the (last) assistant message
          const showActivity = isLast && m.role === 'assistant' && activity.length > 0
          const showPreflights = isLast && m.role === 'assistant' && preflights.length > 0
          const showSubagents = isLast && m.role === 'assistant' && subagentRuns.length > 0
          const changedFiles = isLast && m.role === 'assistant' && !isStreaming
            ? activity.filter(a => a.kind === 'write' && a.status === 'ok').map(a => a.detail ?? '')
            : []
          return (
            <div key={i} className={`gg-msg ${m.role === 'user' ? 'gg-msg-user' : 'gg-msg-assistant'}`}>
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
              {m.role === 'assistant' && (
                <div className="gg-msg-meta">
                  <span className="gg-msg-author">{provider.label}</span>
                </div>
              )}
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
                        <Markdown text={m.thinking} />
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
                {m.content
                  ? (m.role === 'assistant'
                      ? <Markdown text={m.content} />
                      : <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>)
                  : isStreamingAssistant
                    ? <div className="gg-typing"><span /><span /><span /></div>
                    : null
                }
              </div>
              {m.content && !isStreamingAssistant && (
                <MessageActions text={m.content} />
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
          )
        })}
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
      </div>

      <TimelineBar />
      <ReviewPanel />

      <div className="gg-composer">
        {attachments.length > 0 && (
          <div className="gg-attach-row">
            {attachments.map((a, i) => (
              <AttachmentChip key={i} attachment={a} onRemove={() => removeAttachment(i)} />
            ))}
          </div>
        )}
        {warning && <div className="gg-composer-warning">{warning}</div>}
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
        <div className="gg-composer-inner">
          <SlashCommandPopup
            text={input}
            onClear={() => setInput('')}
            onInject={text => setInput(text)}
            projectPath={activePath}
            systemCommands={[
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
              if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                e.preventDefault()
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
            <VoiceInput onTranscript={chunk => setInput(prev => prev + chunk)} />
            {isStreaming ? (
              <button
                className="gg-send-btn gg-stop-btn"
                onClick={() => void stop()}
                title="Остановить (Esc)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="1.5" />
                </svg>
              </button>
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
            accept="image/*,application/pdf,text/*,.json,.md,.csv"
            onChange={onFilesPicked}
          />
        </div>
        <div className="gg-composer-hint">
          <div className="gg-composer-meta">
            {previewTokens && previewTokens.tokens > 0 && (() => {
              const cost = estimateCost(provider.id, provider.model, previewTokens.tokens, 0, 0)
              const exactBadge = previewTokens.exact ? '' : '≈'
              return (
                <span
                  className="gg-usage-pill is-preview"
                  title={previewTokens.exact
                    ? `Точная оценка от ${provider.label}: ${previewTokens.tokens} токенов на следующий запрос${cost.usd ? `, ~${cost.usd} (только input)` : ''}`
                    : `Грубая оценка (4 символа = 1 токен): ${previewTokens.tokens} токенов`}
                >
                  <span>📝 {exactBadge}{formatTokens(previewTokens.tokens)}</span>
                  {cost.usd && previewTokens.exact && (
                    <>
                      <span className="gg-usage-sep">·</span>
                      <span className="gg-usage-cost">~{cost.usd}</span>
                    </>
                  )}
                </span>
              )
            })()}
            {(sessionUsage.inputTokens > 0 || sessionUsage.outputTokens > 0) && (() => {
              const cost = estimateCost(provider.id, provider.model, sessionUsage.inputTokens, sessionUsage.outputTokens, sessionUsage.cachedInputTokens)
              const severity = costSeverity(cost.cents)
              const breakdown = costBreakdown(provider.id, provider.model, sessionUsage.inputTokens, sessionUsage.outputTokens, sessionUsage.cachedInputTokens)
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
            {undoCount > 0 && (
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
            <SkillPicker />
            <CheckpointButton />
            <ReviewButton />
            <div className="gg-effort-toggle" title="Уровень усилий модели">
              <button
                type="button"
                className={effortLevel === 'quick' ? 'active' : ''}
                onClick={() => setEffortLevel('quick')}
                title="Быстро — короткие ответы, дешевле"
              >💨</button>
              <button
                type="button"
                className={effortLevel === 'standard' ? 'active' : ''}
                onClick={() => setEffortLevel('standard')}
                title="Стандарт"
              >⚖️</button>
              <button
                type="button"
                className={effortLevel === 'deep' ? 'active' : ''}
                onClick={() => setEffortLevel('deep')}
                title="Глубоко — расширенное мышление"
              >🧠</button>
            </div>
            <ModePicker mode={agentMode} onChange={setAgentMode} />
            <ModelPicker onOpenSettings={onOpenSettings} />
            <TierRecommendation input={input} />
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
function MessageActions({ text }: { text: string }) {
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
