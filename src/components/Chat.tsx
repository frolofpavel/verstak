import { useEffect, useRef, useState } from 'react'
import { useProject } from '../store/projectStore'
import { useProvider } from '../hooks/useProvider'
import { Markdown } from './Markdown'

interface ChatProps {
  onOpenSettings: () => void
}

export function Chat({ onOpenSettings }: ChatProps) {
  const { messages, addMessage, updateLastAssistant, isStreaming, setStreaming } = useProject()
  const provider = useProvider()
  const [input, setInput] = useState('')
  const streamRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const off = window.api.ai.onEvent(({ event }) => {
      if (event.type === 'text') updateLastAssistant(event.text)
      else if (event.type === 'pending-write') {
        useProject.getState().setPendingWrite({
          callId: event.callId,
          path: event.path,
          before: event.before,
          after: event.after
        })
      }
      else if (event.type === 'done') {
        const path = useProject.getState().path
        const msgs = useProject.getState().messages
        const lastAssistant = msgs[msgs.length - 1]
        if (path && lastAssistant?.role === 'assistant' && lastAssistant.content) {
          void window.api.chats.append(path, 'assistant', lastAssistant.content)
        }
        setStreaming(false)
      }
      else if (event.type === 'error') {
        updateLastAssistant(`\n\n[Ошибка: ${event.message}]`)
        setStreaming(false)
      }
    })
    return off
  }, [updateLastAssistant, setStreaming])

  // Autoscroll on new content
  useEffect(() => {
    if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight
  }, [messages])

  // Auto-grow textarea
  function autoGrow() {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'
  }
  useEffect(autoGrow, [input])

  async function send() {
    const text = input.trim()
    if (!text || isStreaming) return
    const path = useProject.getState().path
    setInput('')
    addMessage({ role: 'user', content: text })
    if (path) await window.api.chats.append(path, 'user', text)
    addMessage({ role: 'assistant', content: '' })
    setStreaming(true)
    const allMessages = [...useProject.getState().messages].slice(0, -1)
    await window.api.ai.send(allMessages, path)
  }

  const hasMessages = messages.length > 0

  return (
    <div className="gg-chat">
      <div className="gg-chat-stream" ref={streamRef}>
        {!hasMessages && (
          <div className="gg-chat-empty">
            <div className="gg-chat-empty-mark">G</div>
            <div className="gg-chat-empty-title">Готов к работе</div>
            <div className="gg-chat-empty-hint">
              Открой проект слева и напиши задачу. Gemini прочитает файлы, предложит изменения и покажет diff перед применением.
            </div>
          </div>
        )}
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1
          const isStreamingAssistant = isLast && m.role === 'assistant' && isStreaming
          return (
            <div key={i} className={`gg-msg ${m.role === 'user' ? 'gg-msg-user' : 'gg-msg-assistant'}`}>
              {m.role === 'assistant' && (
                <div className="gg-msg-meta">
                  <span className="gg-msg-author">Gemini</span>
                </div>
              )}
              <div className="gg-msg-bubble">
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
        <div className="gg-composer-inner">
          <textarea
            ref={textareaRef}
            className="gg-composer-textarea"
            value={input}
            rows={1}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder={isStreaming ? 'Gemini отвечает…' : 'Опиши задачу. Enter — отправить, Shift+Enter — новая строка'}
            disabled={isStreaming}
          />
          <button
            className="gg-send-btn"
            onClick={() => void send()}
            disabled={isStreaming || !input.trim()}
            title="Отправить (Enter)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12l14 -8l-4 16l-4 -6l-6 -2z" />
            </svg>
          </button>
        </div>
        <div className="gg-composer-hint">
          <span><span className="gg-kbd">Enter</span> отправить · <span className="gg-kbd">Shift</span>+<span className="gg-kbd">Enter</span> новая строка</span>
          <button
            type="button"
            className="gg-model-pill"
            onClick={onOpenSettings}
            title="Сменить модель / провайдер"
          >
            <span className={`gg-provider-dot ${provider.id === 'gemini-cli' ? 'cli' : ''}`} />
            <span className="gg-model-pill-name">{provider.model}</span>
            <span className="gg-model-pill-sep">·</span>
            <span className="gg-model-pill-transport">{provider.transport}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
