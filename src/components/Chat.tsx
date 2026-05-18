import { useEffect, useState } from 'react'
import { useProject } from '../store/projectStore'

export function Chat() {
  const { messages, addMessage, updateLastAssistant, isStreaming, setStreaming } = useProject()
  const [input, setInput] = useState('')

  useEffect(() => {
    const off = window.api.ai.onEvent(({ event }) => {
      if (event.type === 'text') updateLastAssistant(event.text)
      else if (event.type === 'done') setStreaming(false)
      else if (event.type === 'error') {
        updateLastAssistant(`\n\n[Ошибка: ${event.message}]`)
        setStreaming(false)
      }
    })
    return off
  }, [updateLastAssistant, setStreaming])

  async function send() {
    const text = input.trim()
    if (!text || isStreaming) return
    setInput('')
    addMessage({ role: 'user', content: text })
    addMessage({ role: 'assistant', content: '' })
    setStreaming(true)
    const allMessages = [...useProject.getState().messages].slice(0, -1)
    await window.api.ai.send(allMessages)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {messages.map((m, i) => (
          <div key={i} style={{
            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
            background: m.role === 'user' ? '#1a1a2e' : '#0f2027',
            padding: '10px 14px', borderRadius: 8, maxWidth: '80%', whiteSpace: 'pre-wrap'
          }}>
            {m.role === 'assistant' && <div style={{ color: '#4fc3f7', fontSize: 11, marginBottom: 4 }}>✦ Gemini</div>}
            {m.content || (m.role === 'assistant' && isStreaming ? '...' : '')}
          </div>
        ))}
      </div>
      <div style={{ padding: 12, borderTop: '1px solid #222' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder={isStreaming ? 'Gemini отвечает...' : 'Напиши задачу...'}
          disabled={isStreaming}
          style={{ width: '100%', padding: 10, background: '#1a1a1a', color: '#fff', border: '1px solid #333', borderRadius: 6 }}
        />
      </div>
    </div>
  )
}
