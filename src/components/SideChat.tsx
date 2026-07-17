import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useProject } from '../store/projectStore'
import { historyForSend } from '../lib/chat-messages'
import { useProvider } from '../hooks/useProvider'
import type { ProviderDescriptorDTO } from '../types/api'
import { Markdown } from './Markdown'
import { useT } from '../i18n'
import { readAgentMode } from '../hooks/useAgentMode'

interface SideChatProps {
  /** Set after the first user message creates a chat session in the sidebar. */
  sideChatId: number | null
  width: number
  onResizeStart: (e: ReactMouseEvent<HTMLDivElement>) => void
  onSessionCreated: (id: number) => void
  onSessionSelected: (id: number | null) => void
  onClose: () => void
}

function SideChatPanelIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="8" height="16" rx="1.5" />
      <path d="M13 8h6a2 2 0 0 1 2 2v8l-3-2.5H13a2 2 0 0 1-2-2V8z" />
    </svg>
  )
}

/**
 * Параллельный чат — второй чат-поток, пристыкованный справа.
 * Работает параллельно основному чату в том же окне: свой стрим
 * сообщений + свой composer.
 */
export function SideChat({ sideChatId, width, onResizeStart, onSessionCreated, onSessionSelected, onClose }: SideChatProps) {
  const t = useT()
  const provider = useProvider()
  const patchChatSession = useProject(s => s.patchChatSession)
  const refreshChatSessions = useProject(s => s.refreshChatSessions)
  const chatSessions = useProject(s => s.chatSessions)
  const snapshot = useProject(s => sideChatId != null ? s.chatSnapshots[sideChatId] : undefined)
  const path = useProject(s => s.path)
  const [draftMessages, setDraftMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const messages = sideChatId != null ? (snapshot?.messages ?? []) : draftMessages
  const isStreaming = snapshot?.isStreaming ?? false
  const hasUserMessages = messages.some(m => m.role === 'user' && m.content.trim().length > 0)

  const [input, setInput] = useState('')
  const streamRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sendIdRef = useRef<number | null>(null)

  const [sideProviderId, setSideProviderId] = useState<string | null>(null)
  const [sideModel, setSideModel] = useState<string | null>(null)
  const [providers, setProviders] = useState<ProviderDescriptorDTO[]>([])
  const [configuredIds, setConfiguredIds] = useState<Set<string>>(new Set())
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (sideChatId == null) {
        setSideProviderId(provider.id)
        setSideModel(provider.model ?? null)
        return
      }
      await refreshChatSessions()
      if (cancelled) return
      const session = useProject.getState().chatSessions.find(c => c.id === sideChatId)
      if (session?.providerId) {
        setSideProviderId(session.providerId)
        setSideModel(session.model ?? null)
        return
      }
      setSideProviderId(provider.id)
      setSideModel(provider.model ?? null)
    })()
    return () => { cancelled = true }
    // Existing side-chat sessions keep their own saved model; new side chats mirror the main chat.
  }, [sideChatId, provider.id, provider.model, refreshChatSessions])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      textareaRef.current?.focus({ preventScroll: true })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [sideChatId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await window.api.providers.list()
        if (cancelled) return
        setProviders(list)
        const configured = new Set<string>(list.filter(p => p.secretKey === null).map(p => p.id))
        const withKey = list.filter(p => p.secretKey !== null)
        const keyVals = await Promise.all(withKey.map(p => window.api.settings.getKey(p.secretKey as string)))
        if (cancelled) return
        withKey.forEach((p, i) => { if (keyVals[i]) configured.add(p.id) })
        setConfiguredIds(configured)
      } catch { /* IPC недоступен */ }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!pickerOpen) return
    function onDown(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [pickerOpen])

  const sideProvider = providers.find(p => p.id === sideProviderId)
  const sideLabel = sideProvider?.shortLabel ?? sideProvider?.name ?? (sideProviderId ?? '—')
  const sideModelLabel = sideModel ?? sideProvider?.defaultModel ?? 'auto'

  async function ensureSideChatSession(opts: { providerId?: string | null; model?: string | null } = {}): Promise<number | null> {
    if (sideChatId != null) return sideChatId
    if (!path) return null
    try {
      const created = await window.api.chatSessions.create(path, {
        title: 'Параллельный чат',
        providerId: opts.providerId ?? sideProviderId,
        model: opts.model ?? sideModel,
      })
      onSessionCreated(created.id)
      await refreshChatSessions()
      return created.id
    } catch {
      return null
    }
  }

  async function persistSideModel(nextProviderId: string | null, nextModel: string | null) {
    const chatId = await ensureSideChatSession({ providerId: nextProviderId, model: nextModel })
    if (chatId == null) return
    try {
      await window.api.chatSessions.setModel(chatId, nextProviderId, nextModel)
      patchChatSession(chatId, { providerId: nextProviderId, model: nextModel })
    } catch { /* keep the picker responsive if persistence fails */ }
  }

  async function selectProvider(p: ProviderDescriptorDTO) {
    const nextModel = p.defaultModel || null
    setSideProviderId(p.id)
    setSideModel(nextModel)
    await persistSideModel(p.id, nextModel)
  }

  async function selectModel(model: string) {
    setSideModel(model)
    await persistSideModel(sideProviderId, model)
  }

  function selectSideChat(value: string) {
    if (value === 'new') {
      onSessionSelected(null)
      setDraftMessages([])
      setInput('')
      setSideProviderId(provider.id)
      setSideModel(provider.model ?? null)
      return
    }
    const nextId = Number(value)
    if (!Number.isFinite(nextId)) return
    onSessionSelected(nextId)
  }

  useEffect(() => {
    if (sideChatId == null) return
    let cancelled = false
    const store = useProject.getState()
    const snap = store.chatSnapshots[sideChatId]
    if (snap && snap.messages.length > 0) return
    void window.api.chats.list(sideChatId).then(history => {
      if (cancelled) return
      const current = useProject.getState().chatSnapshots[sideChatId]
      if (current && current.messages.length > 0) return
      store.seedChatSnapshot(sideChatId, history.map(m => ({ role: m.role, content: m.content, thinking: m.thinking, appliedSkills: m.appliedSkills, createdAt: m.createdAt, dbId: m.id })))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [sideChatId])

  useEffect(() => {
    if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight
  }, [messages])

  function autoGrow() {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
  }
  useEffect(autoGrow, [input])

  async function send() {
    const text = input.trim()
    if (!text || isStreaming) return
    setInput('')
    const chatId = await ensureSideChatSession()
    if (chatId == null) return

    const store = useProject.getState()
    const priorMessages = store.chatSnapshots[chatId]?.messages ?? draftMessages
    const isFirstUserMessage = !priorMessages.some(m => m.role === 'user' && m.content.trim())
    // historyForSend сохраняет dbId — по нему main режет историю по границе сжатого
    // итога (ревью 2.0.11-B #4). Локальная копия его срезала, и сжатие вырождалось.
    const history = historyForSend(priorMessages)
    const userMsg = { role: 'user' as const, content: text }
    setDraftMessages([])
    store.pushUserToChatSnapshot(chatId, text)
    if (path) {
      void window.api.chats.append(chatId, path, 'user', text).catch(() => {})
    }
    if (isFirstUserMessage) {
      void store.autoTitleChatSession(chatId, text)
    }
    const sendId = await window.api.ai.sendWithOverrides(
      [...history, userMsg],
      path,
      { providerId: sideProviderId ?? undefined, model: sideModel, agentMode: await readAgentMode(chatId, false) },
      String(chatId)
    )
    sendIdRef.current = sendId
    if (sendId > 0) {
      store.registerSendOwner(sendId, { kind: 'chat', chatId, projectPath: path })
    } else {
      store.applyEventToChat(chatId, { type: 'error', message: 'Провайдер недоступен' })
    }
  }

  async function stop() {
    const id = sendIdRef.current
    if (id == null || sideChatId == null) return
    await window.api.ai.stop(id).catch(() => {})
    useProject.getState().applyEventToChat(sideChatId, { type: 'done' })
    useProject.getState().forgetSendOwner(id)
    sendIdRef.current = null
  }

  const streamingLabel = sideProvider?.shortLabel ?? sideProvider?.name ?? provider.label

  return (
    <div className="gg-sidechat" style={{ width }}>
      <div
        className="gg-sidechat-resizer"
        onMouseDown={onResizeStart}
        role="separator"
        aria-orientation="vertical"
        title="Изменить ширину параллельного чата"
      />
      <div className="gg-sidechat-header">
        <div className="gg-sidechat-header-main">
          <div className="gg-sidechat-title">
            <span className="gg-sidechat-title-icon"><SideChatPanelIcon /></span>
            <span>{t.chat.sideChatTitle}</span>
          </div>
          <button
            className="gg-sidechat-close"
            onClick={onClose}
            title={t.chat.sideChatClose}
          >×</button>
        </div>
        <div className="gg-sidechat-header-controls">
          <select
            className="gg-sidechat-session-select"
            value={sideChatId ?? 'new'}
            onChange={e => selectSideChat(e.target.value)}
            disabled={isStreaming}
            title="Выбрать чат для правой панели"
          >
            <option value="new">Новый параллельный</option>
            {chatSessions.map(session => (
              <option key={session.id} value={session.id}>
                {session.title?.trim() || `Чат ${session.id}`}
              </option>
            ))}
          </select>
          <div className="gg-sidechat-mp" ref={pickerRef}>
            <button
              type="button"
              className="gg-sidechat-mp-pill"
              onClick={() => setPickerOpen(v => !v)}
              title={t.chat.sideChatModelPickerTitle}
            >
              <span className="gg-sidechat-mp-name">{sideLabel}</span>
              <span className="gg-sidechat-mp-sep">·</span>
              <span className="gg-sidechat-mp-model">{sideModelLabel}</span>
            </button>
            {pickerOpen && (
              <div className="gg-sidechat-mp-popover">
                <div className="gg-sidechat-mp-section-title">Провайдер</div>
                {providers.map(p => {
                  const isConfigured = configuredIds.has(p.id)
                  const isActive = p.id === sideProviderId
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`gg-sidechat-mp-row ${isActive ? 'is-active' : ''} ${!isConfigured ? 'is-unconfigured' : ''}`}
                      disabled={!isConfigured}
                      title={isConfigured ? undefined : 'API-ключ не задан (Настройки)'}
                      onClick={() => { if (isConfigured) void selectProvider(p).then(() => setPickerOpen(false)) }}
                    >
                      <span className="gg-sidechat-mp-row-label">
                        {!isConfigured && '🔒 '}{p.shortLabel || p.name}
                      </span>
                      <span className="gg-sidechat-mp-row-meta">{p.transport}</span>
                    </button>
                  )
                })}
                {sideProvider && sideProvider.models.length > 1 && (
                  <>
                    <div className="gg-sidechat-mp-section-title">Модель</div>
                    {sideProvider.models.map(m => (
                      <button
                        key={m}
                        type="button"
                        className={`gg-sidechat-mp-row ${m === sideModel ? 'is-active' : ''}`}
                        onClick={() => void selectModel(m).then(() => setPickerOpen(false))}
                      >
                        <span className="gg-sidechat-mp-row-label">{m}</span>
                        {m === sideModel && <span className="gg-sidechat-mp-row-meta">✓</span>}
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="gg-sidechat-stream" ref={streamRef}>
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1
          const isStreamingAssistant = isLast && m.role === 'assistant' && isStreaming
          return (
            <div key={i} className={`gg-sidechat-msg ${m.role === 'user' ? 'is-user' : 'is-assistant'}`}>
              <div className="gg-sidechat-bubble">
                {m.content
                  ? (m.role === 'assistant'
                      ? <Markdown text={m.content} />
                      : <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>)
                  : isStreamingAssistant
                    ? <div className="gg-typing"><span /><span /><span /></div>
                    : null}
              </div>
            </div>
          )
        })}
      </div>
      <div className="gg-sidechat-composer">
        {!hasUserMessages && (
          <div className="gg-sidechat-hint">{t.chat.sideChatHint}</div>
        )}
        <div className="gg-sidechat-composer-row">
          <textarea
            ref={textareaRef}
            className="gg-sidechat-textarea"
            value={input}
            rows={1}
            onChange={e => setInput(e.target.value)}
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
            placeholder={isStreaming
              ? `${streamingLabel} ${t.chat.sideChatStreamingPlaceholder}`
              : t.chat.sideChatPlaceholder}
          />
          {isStreaming ? (
            <button className="gg-sidechat-send is-stop" onClick={() => void stop()} title="Остановить (Esc)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="1.5" />
              </svg>
            </button>
          ) : (
            <button
              className="gg-sidechat-send"
              onClick={() => void send()}
              disabled={input.trim().length === 0}
              title="Отправить (Enter)"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12l14 -8l-4 16l-4 -6l-6 -2z" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
