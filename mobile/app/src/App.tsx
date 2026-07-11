import { useEffect, useMemo, useReducer, useState } from 'react'
import { MobileClient, type MobileClientConfig } from './client'
import { createMobileState, reduceMobileState } from './state'

interface Root { rootId: string; name: string; available: boolean }
interface Chat { id: number; title: string }
interface Message { id: number; role: string; content: string }

const initialConfig: MobileClientConfig = {
  relayUrl: localStorage.getItem('relayUrl') ?? 'http://localhost:8787',
  token: localStorage.getItem('relayToken') ?? '',
  accountId: localStorage.getItem('accountId') ?? 'local',
  deviceId: localStorage.getItem('deviceId') ?? 'desktop',
}

export function App() {
  const [config, setConfig] = useState(initialConfig)
  const [state, dispatch] = useReducer(reduceMobileState, undefined, createMobileState)
  const [roots, setRoots] = useState<Root[]>([])
  const [chats, setChats] = useState<Chat[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [error, setError] = useState('')
  const client = useMemo(() => new MobileClient(config), [config])
  useEffect(() => () => client.disconnect(), [client])

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
    setMessages(current => [...current, { id: Date.now(), role: 'user', content: text }])
    await client.command('chat.send', { rootId: state.rootId, chatId: state.chatId, text })
    const chatId = state.chatId
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1_000))
      const history = await client.command('chat.history', { rootId: state.rootId, chatId }) as Message[]
      setMessages(history)
      if (history.at(-1)?.role === 'assistant') break
    }
  }

  if (!state.online) return <main className="shell"><h1>Verstak Mobile</h1><p>Твой компьютерный AI — с телефона.</p>
    {(['relayUrl', 'accountId', 'deviceId', 'token'] as const).map(key => <label key={key}>{key}<input type={key === 'token' ? 'password' : 'text'} value={config[key]} onChange={e => setConfig({ ...config, [key]: e.target.value })} /></label>)}
    <button onClick={() => void connect()}>Подключиться</button>{error && <p className="error">{error}</p>}</main>
  if (!state.rootId) return <main className="shell"><h2>Проекты и папки</h2>{roots.map(root => <button className="card" key={root.rootId} onClick={() => void selectRoot(root.rootId)}>{root.name}</button>)}</main>
  if (!state.chatId) return <main className="shell"><button className="back" onClick={() => dispatch({ type: 'device.selected', deviceId: config.deviceId })}>← Папки</button><h2>Чаты</h2><button onClick={() => void createChat()}>＋ Новый чат</button>{chats.map(chat => <button className="card" key={chat.id} onClick={() => void selectChat(chat.id)}>{chat.title}</button>)}</main>
  return <main className="chat"><header><button className="back" onClick={() => dispatch({ type: 'root.selected', rootId: state.rootId! })}>← Чаты</button><strong>Verstak</strong></header><section className="messages">{messages.map(message => <article className={message.role} key={message.id}>{message.content}</article>)}</section><footer><textarea aria-label="Задача" placeholder="Надиктуй или напиши задачу…" value={state.draft} onChange={e => dispatch({ type: 'draft.changed', text: e.target.value })} /><button onClick={() => void send()}>Отправить</button></footer></main>
}
