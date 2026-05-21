import { useEffect, useRef, useState, type DragEvent, type ClipboardEvent } from 'react'
import { useProject } from '../store/projectStore'
import { useProvider } from '../hooks/useProvider'
import { estimateCost } from '../lib/pricing'
import { Markdown } from './Markdown'
import { ModelPicker } from './ModelPicker'
import { ModePicker } from './ModePicker'
import { VoiceInput } from './VoiceInput'
import { useAgentMode } from '../hooks/useAgentMode'
import type { Attachment } from '../types/api'
import iconUrl from '../assets/icon.png'

const MAX_BYTES_PER_FILE = 5 * 1024 * 1024  // 5 MB
const MAX_ATTACHMENTS = 8

const ACCEPTED_MIME_PREFIXES = ['image/', 'text/', 'application/pdf', 'application/json']

interface ChatProps {
  onOpenSettings: () => void
  onToggleTerminal: () => void
  terminalOpen: boolean
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

export function Chat({ onOpenSettings, onToggleTerminal, terminalOpen }: ChatProps) {
  const { messages, addMessage, updateLastAssistant, isStreaming, setStreaming, activity, sessionUsage, path: activePath, chatSessions, activeChatId } = useProject()
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
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const screenshotCounter = useRef(0)
  const warningTimer = useRef<number | null>(null)
  const currentSendIdRef = useRef<number | null>(null)
  const [undoCount, setUndoCount] = useState(0)

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
      // Route background-project events to the snapshot store so they don't
      // mutate the currently-visible session.
      if (projectPath && projectPath !== store.path) {
        store.applyEventToSession(projectPath, event as unknown as { type: string; [k: string]: unknown })
        return
      }
      // Route background-chat events (same project, different chat) to the
      // chat snapshot so the user's stream survives chat-switching.
      const owningChatId = store.sendIdToChatId[id]
      if (owningChatId != null && owningChatId !== store.activeChatId) {
        store.applyEventToChat(owningChatId, event as unknown as { type: string; [k: string]: unknown })
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
      }
    })
    return off
  }, [updateLastAssistant, setStreaming])

  // Autoscroll on new content
  useEffect(() => {
    if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight
  }, [messages])

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

  // Cleanup warning timer on unmount
  useEffect(() => () => { if (warningTimer.current) window.clearTimeout(warningTimer.current) }, [])

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
    addMessage({ role: 'assistant', content: '' })
    setStreaming(true)
    // Send everything except the empty placeholder we just pushed
    const msgs = [...useProject.getState().messages].slice(0, -1)
    const sendId = await window.api.ai.sendWithBudget(msgs, store.path, newBudget)
    if (activeChatId != null) {
      useProject.getState().registerSend(sendId, activeChatId)
    }
  }

  async function send() {
    const text = input.trim()
    if (!text && attachments.length === 0) return
    if (isStreaming) return
    const store = useProject.getState()
    const path = store.path
    const userAttachments = attachments
    store.clearActivity()
    setExhausted(null)  // new send wipes any pending continue state
    setInput('')
    setAttachments([])
    const summary = userAttachments.length > 0
      ? `${text}${text ? '\n\n' : ''}📎 ${userAttachments.map(a => a.name).join(', ')}`
      : text
    addMessage({ role: 'user', content: text, attachments: userAttachments })
    const activeChatId = store.activeChatId
    if (path && activeChatId) {
      await window.api.chats.append(activeChatId, path, 'user', summary)
      // log the start of a session — title is the first 80 chars of the request
      const journalTitle = text.length > 80 ? text.slice(0, 80) + '…' : (text || 'Сообщение с вложением')
      void window.api.journal.append(path, 'session', journalTitle,
        userAttachments.length > 0 ? `Вложений: ${userAttachments.length} (${userAttachments.map(a => a.name).join(', ')})` : null)
    }
    addMessage({ role: 'assistant', content: '' })
    setStreaming(true)
    const allMessages = [...useProject.getState().messages].slice(0, -1)
    const sendId = await window.api.ai.send(allMessages, path)
    currentSendIdRef.current = sendId
    // Bind this send to the chat that initiated it — if user switches to
    // another chat mid-stream, the event handler will route events into
    // chatSnapshots[activeChatId] rather than corrupting the new active chat.
    if (activeChatId != null) {
      useProject.getState().registerSend(sendId, activeChatId)
    }
  }

  async function stop() {
    const id = currentSendIdRef.current
    if (id == null) return
    await window.api.ai.stop(id)
    setStreaming(false)
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
        </div>
      )}

      <div className="gg-chat-stream" ref={streamRef}>
        {!hasMessages && (
          <div className="gg-chat-empty">
            <img src={iconUrl} alt="GeminiGrok" className="gg-chat-empty-mark-img" />
            <div className="gg-chat-empty-title">Готов к работе</div>
            <div className="gg-chat-empty-hint">
              Открой проект слева и напиши задачу. Можно прикрепить файл, бросить скриншот через Ctrl+V или drag-and-drop.
            </div>
            {activePath && (
              <div className="gg-chat-empty-quick">
                <button
                  className="gg-quick-action"
                  onClick={() => setInput(GOAL_CYCLE_PROMPT)}
                  title="AI прочитает журнал работы, карту проекта и предложит 3 конкретных улучшения с планом"
                >
                  💡 Что улучшить в проекте?
                </button>
                <button
                  className="gg-quick-action"
                  onClick={() => setInput('Сделай аудит последних изменений за вчера-сегодня: вызови read_journal с kind="session" на 10 записей, выдели риски и регрессии. Используй get_project_map если нужен контекст.')}
                  title="AI прочитает свежие сессии и поищет регрессии"
                >
                  🔍 Аудит последних изменений
                </button>
                <button
                  className="gg-quick-action"
                  onClick={() => setInput('Покажи карту проекта: вызови get_project_map с format=text и кратко опиши главные каталоги + стек.')}
                  title="Быстрый обзор структуры проекта"
                >
                  🗺 Карта проекта
                </button>
              </div>
            )}
          </div>
        )}
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1
          const isStreamingAssistant = isLast && m.role === 'assistant' && isStreaming
          // Render activity rows just before the (last) assistant message
          const showActivity = isLast && m.role === 'assistant' && activity.length > 0
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
            </div>
          )
        })}
      </div>

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
          <textarea
            ref={textareaRef}
            className="gg-composer-textarea"
            value={input}
            rows={1}
            onChange={e => setInput(e.target.value)}
            onPaste={onPaste}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                e.preventDefault()
                void send()
              }
              if (e.key === 'Escape' && isStreaming) {
                e.preventDefault()
                void stop()
              }
            }}
            placeholder={isStreaming ? `${provider.label} отвечает… (Esc — остановить)` : 'Опиши задачу. Enter — отправить, Shift+Enter — новая строка. Ctrl+V — вставить скриншот.'}
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
              return (
                <span className="gg-usage-pill" title={`Токены в этом проекте\n↑ input: ${sessionUsage.inputTokens}\n↓ output: ${sessionUsage.outputTokens}\ncached: ${sessionUsage.cachedInputTokens}`}>
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
              className={`gg-terminal-toggle ${terminalOpen ? 'is-open' : ''}`}
              onClick={onToggleTerminal}
              title={terminalOpen ? 'Скрыть терминал' : 'Показать терминал'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
            </button>
            <ModePicker mode={agentMode} onChange={setAgentMode} />
            <ModelPicker onOpenSettings={onOpenSettings} />
          </div>
        </div>
      </div>
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
