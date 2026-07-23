import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { MobileClient, type MobileClientConfig } from './client'
import type { MobileEnvelope } from '../../shared/protocol'
import { createMobileState, reduceMobileState } from './state'

interface Root { rootId: string; name: string; available: boolean }
interface Chat { id: number; title: string }
interface Message { id: number; role: string; content: string }
interface RunLog { id: string; text: string; tone: 'info' | 'ok' | 'warn' | 'error' }

const query = new URLSearchParams(window.location.search)
const initialConfig: MobileClientConfig = {
  relayUrl: query.get('relayUrl') ?? localStorage.getItem('relayUrl') ?? 'http://localhost:8787',
  token: query.get('token') ?? localStorage.getItem('relayToken') ?? '',
  accountId: query.get('accountId') ?? localStorage.getItem('accountId') ?? 'local',
  deviceId: query.get('deviceId') ?? localStorage.getItem('deviceId') ?? 'desktop',
}
const shouldAutoConnect = query.has('token') && query.has('relayUrl')

export function App() {
  const [config, setConfig] = useState(initialConfig)
  const [state, dispatch] = useReducer(reduceMobileState, undefined, createMobileState)
  const [roots, setRoots] = useState<Root[]>([])
  const [chats, setChats] = useState<Chat[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [liveText, setLiveText] = useState('')
  const [runLog, setRunLog] = useState<RunLog[]>([])
  const [error, setError] = useState('')
  const autoConnectStartedRef = useRef(false)
  const client = useMemo(() => new MobileClient(config), [config])
  useEffect(() => () => client.disconnect(), [client])
  useEffect(() => client.onEvent(event => {
    if (event.kind !== 'run.event') return
    const payload = event.payload as { runId?: string; event?: { type?: string; text?: string; message?: string; command?: string; status?: string; title?: string; detail?: string } }
    if (!payload.runId || payload.runId !== activeRunId || !payload.event) return
    applyRunEvent(event, payload.event)
  }), [activeRunId, client])

  const addRunLog = (text: string, tone: RunLog['tone'] = 'info') => {
    setRunLog(current => [...current.slice(-39), { id: `${Date.now()}-${current.length}`, text, tone }])
  }
  const applyRunEvent = (envelope: MobileEnvelope, event: { type?: string; text?: string; message?: string; command?: string; status?: string; title?: string; detail?: string }) => {
    if (event.type === 'text' && event.text) { setLiveText(current => current + event.text); return }
    if (event.type === 'agent-progress') { addRunLog([event.title, event.detail].filter(Boolean).join(' · ') || 'Прогресс') ; return }
    if (event.type === 'pending-command') { addRunLog(`Нужно подтверждение команды: ${event.command ?? 'command'}`, 'warn'); return }
    if (event.type === 'command-result') { addRunLog(`Команда: ${event.status ?? 'result'}`, event.status === 'ok' ? 'ok' : 'warn'); return }
    if (event.type === 'done') { addRunLog('Задача завершена', 'ok'); setActiveRunId(null); return }
    if (event.type === 'error') { addRunLog(event.message ?? 'Ошибка выполнения', 'error'); setActiveRunId(null); return }
    addRunLog(`${envelope.kind}: ${event.type ?? 'event'}`)
  }

  const connect = async () => {
    setError('')
    try {
      Object.entries(config).forEach(([key, value]) => localStorage.setItem(key === 'token' ? 'relayToken' : key, value))
      await client.connect()
      dispatch({ type: 'connection.changed', online: true })
      dispatch({ type: 'device.selected', deviceId: config.deviceId })
      setRoots(await client.command('roots.list', {}) as Root[])
    } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка подключения') }
  }
  useEffect(() => {
    if (!shouldAutoConnect || state.online || autoConnectStartedRef.current) return
    autoConnectStartedRef.current = true
    void connect()
  }, [state.online])
  const selectRoot = async (rootId: string) => {
    dispatch({ type: 'root.selected', rootId })
    setChats(await client.command('chats.list', { rootId }) as Chat[])
  }
  const createChat = async () => {
    if (!state.rootId) return
    const chat = await client.command('chat.create', { rootId: state.rootId, title: 'Мобильный чат' }) as Chat
    setChats(current => [chat, ...current]); dispatch({ type: 'chat.selected', chatId: chat.id }); setMessages([])
  }
  const selectChat = async (chatId: number) => {
    dispatch({ type: 'chat.selected', chatId }); setMessages(await client.command('chat.history', { rootId: state.rootId, chatId }) as Message[])
  }
  const send = async () => {
    if (!state.rootId || !state.chatId || !state.draft.trim()) return
    const text = state.draft.trim(); dispatch({ type: 'draft.changed', text: '' })
    setLiveText(''); setRunLog([])
    setMessages(current => [...current, { id: Date.now(), role: 'user', content: text }])
    const run = await client.command('chat.send', { rootId: state.rootId, chatId: state.chatId, text }) as { runId?: string }
    if (run.runId) { setActiveRunId(run.runId); addRunLog(`Запуск ${run.runId}`, 'ok') }
    const chatId = state.chatId
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1_000))
      const history = await client.command('chat.history', { rootId: state.rootId, chatId }) as Message[]
      setMessages(history)
      if (history.at(-1)?.role === 'assistant') break
    }
  }
  const stop = async () => {
    if (!activeRunId) return
    await client.command('run.stop', { runId: activeRunId })
    addRunLog('Остановка отправлена', 'warn')
    setActiveRunId(null)
  }

  if (!state.online) return <main className="shell"><h1>Verstak Mobile</h1><p>Твой компьютерный AI — с телефона.</p>
    {(['relayUrl', 'accountId', 'deviceId', 'token'] as const).map(key => <label key={key}>{key}<input type={key === 'token' ? 'password' : 'text'} value={config[key]} onChange={e => setConfig({ ...config, [key]: e.target.value })} /></label>)}
    <button onClick={() => void connect()}>Подключиться</button>{error && <p className="error">{error}</p>}</main>
  if (!state.rootId) return <main className="shell"><h2>Проекты и папки</h2>{roots.length === 0 && <p className="hint">В этом тестовом профиле пока нет проектов. В открывшемся окне Verstak на компьютере добавь тестовую папку, затем обнови эту страницу.</p>}{roots.map(root => <button className="card" key={root.rootId} onClick={() => void selectRoot(root.rootId)}>{root.name}</button>)}</main>
  if (!state.chatId) return <main className="shell"><button className="back" onClick={() => dispatch({ type: 'device.selected', deviceId: config.deviceId })}>← Папки</button><h2>Чаты</h2><button onClick={() => void createChat()}>＋ Новый чат</button>{chats.map(chat => <button className="card" key={chat.id} onClick={() => void selectChat(chat.id)}>{chat.title}</button>)}</main>
  return <main className="chat"><header><button className="back" onClick={() => dispatch({ type: 'root.selected', rootId: state.rootId! })}>← Чаты</button><strong>Verstak</strong>{activeRunId && <button className="stop" onClick={() => void stop()}>Стоп</button>}</header><section className="messages">{messages.map(message => <article className={message.role} key={message.id}>{message.content}</article>)}{liveText && <article className="assistant live">{liveText}</article>}{runLog.length > 0 && <aside className="run-log">{runLog.map(item => <p className={item.tone} key={item.id}>{item.text}</p>)}</aside>}</section><footer><textarea aria-label="Задача" placeholder="Надиктуй или напиши задачу…" value={state.draft} onChange={e => dispatch({ type: 'draft.changed', text: e.target.value })} /><button disabled={!!activeRunId} onClick={() => void send()}>Отправить</button></footer></main>
}
