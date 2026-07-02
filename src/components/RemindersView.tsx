import { useEffect, useMemo, useRef, useState } from 'react'
import { useProject } from '../store/projectStore'
import type { ChatSession, Reminder, ReminderTarget } from '../types/api'

function toLocalInputValue(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function statusLabel(reminder: Reminder): string {
  if (reminder.status === 'pending' && reminder.dueAt <= Date.now()) return 'Ожидает реакции'
  if (reminder.status === 'pending') return 'Запланировано'
  if (reminder.status === 'delivered') return 'Отправлено'
  return 'Закрыто'
}

function emitRemindersChanged(projectPath: string): void {
  window.dispatchEvent(new CustomEvent('gg-reminders-changed', { detail: { projectPath } }))
}

export function RemindersView() {
  const { path, chatSessions } = useProject()
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [chats, setChats] = useState<ChatSession[]>([])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [due, setDue] = useState(() => toLocalInputValue(Date.now() + 60 * 60 * 1000))
  const [target, setTarget] = useState<ReminderTarget>('notification')
  const [chatId, setChatId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const dateInputRef = useRef<HTMLInputElement | null>(null)

  async function refresh() {
    if (!path) return
    try {
      const [nextReminders, nextChats] = await Promise.all([
        window.api.reminders.list(path, 200),
        window.api.chatSessions.list(path)
      ])
      const availableChats = nextChats.length > 0 ? nextChats : chatSessions
      setReminders(nextReminders)
      setChats(availableChats)
      setChatId(prev => (prev && availableChats.some(c => c.id === prev)) ? prev : availableChats[0]?.id ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setChats(chatSessions)
    }
  }

  useEffect(() => { void refresh() }, [path, chatSessions])
  useEffect(() => {
    if (chatId && chats.some(c => c.id === chatId)) return
    setChatId(chats[0]?.id ?? null)
  }, [chats, chatId])

  const active = useMemo(() => reminders.filter(r => r.status === 'pending'), [reminders])
  const history = useMemo(() => reminders.filter(r => r.status !== 'pending'), [reminders])

  if (!path) {
    return (
      <div className="gg-panel">
        <div className="gg-panel-empty" style={{ marginTop: 80 }}>Открой проект, чтобы управлять напоминаниями</div>
      </div>
    )
  }

  async function createReminder() {
    setError(null)
    setNotice(null)
    const cleanTitle = title.trim()
    if (!cleanTitle) {
      setError('Введите текст напоминания')
      return
    }
    const dueAt = new Date(due).getTime()
    if (!Number.isFinite(dueAt)) {
      setError('Выберите дату и время')
      return
    }
    if (target === 'chat' && !chatId) {
      setError('Выберите чат проекта')
      return
    }
    try {
      const created = await window.api.reminders.create({
        projectPath: path!,
        title: cleanTitle,
        body: body.trim() || null,
        dueAt,
        target,
        chatId: target === 'chat' ? chatId : null
      })
      setReminders(prev => [created, ...prev.filter(r => r.id !== created.id)])
      setTitle('')
      setBody('')
      setDue(toLocalInputValue(Date.now() + 60 * 60 * 1000))
      setNotice('Напоминание создано')
      await refresh()
      emitRemindersChanged(path!)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function snooze(id: number) {
    await window.api.reminders.snooze(id, 10)
    await refresh()
    if (!path) return
    emitRemindersChanged(path)
  }

  async function dismiss(id: number) {
    await window.api.reminders.dismiss(id)
    await refresh()
    if (!path) return
    emitRemindersChanged(path)
  }

  async function remove(id: number) {
    await window.api.reminders.remove(id)
    await refresh()
    if (!path) return
    emitRemindersChanged(path)
  }

  function renderReminder(reminder: Reminder) {
    const chat = reminder.chatId ? chats.find(c => c.id === reminder.chatId) : null
    return (
      <div key={reminder.id} className="gg-journal-entry">
        <div className="gg-journal-meta">
          <span className="gg-journal-kind" style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}>
            {statusLabel(reminder)}
          </span>
          <span className="gg-journal-time">{formatDateTime(reminder.dueAt)}</span>
        </div>
        <div className="gg-journal-title">{reminder.title}</div>
        {reminder.body && <div className="gg-journal-detail-text">{reminder.body}</div>}
        <div className="gg-panel-meta" style={{ marginTop: 8 }}>
          {reminder.target === 'chat' ? `В чат: ${chat?.title ?? `#${reminder.chatId}`}` : 'Уведомление Verstak'}
        </div>
        <div className="gg-journal-edit-actions" style={{ marginTop: 12 }}>
          {reminder.status === 'pending' && (
            <>
              <button className="gg-btn gg-btn-ghost" type="button" onClick={() => void snooze(reminder.id)}>Через 10 минут</button>
              <button className="gg-btn gg-btn-ghost" type="button" onClick={() => void dismiss(reminder.id)}>Закрыть</button>
            </>
          )}
          <button className="gg-btn gg-btn-ghost" type="button" onClick={() => void remove(reminder.id)}>Удалить</button>
        </div>
      </div>
    )
  }

  return (
    <div className="gg-panel">
      <div className="gg-panel-header">
        <h2 className="gg-panel-title">Напоминания</h2>
        <div className="gg-panel-meta">{active.length} активных</div>
      </div>
      <div className="gg-panel-body">
        <div className="gg-reminder-compose">
          <input
            className="gg-input"
            placeholder="Что напомнить?"
            value={title}
            onChange={e => setTitle(e.target.value)}
          />
          <textarea
            className="gg-input gg-journal-detail"
            placeholder="Детали (необязательно)"
            rows={2}
            value={body}
            onChange={e => setBody(e.target.value)}
          />
          <div className="gg-reminder-compose-grid">
            <input
              ref={dateInputRef}
              className="gg-input"
              type="datetime-local"
              value={due}
              onChange={e => setDue(e.target.value)}
              onClick={e => {
                e.currentTarget.showPicker?.()
              }}
              onFocus={e => {
                e.currentTarget.showPicker?.()
              }}
            />
            <select className="gg-input" value={target} onChange={e => setTarget(e.target.value as ReminderTarget)}>
              <option value="notification">Показать уведомление</option>
              <option value="chat">Отправить в чат проекта</option>
            </select>
          </div>
          {target === 'chat' && (
            <select className="gg-input" value={chatId ?? ''} onChange={e => setChatId(Number(e.target.value))}>
              {chats.length === 0 && <option value="">Нет чатов проекта</option>}
              {chats.map(chat => <option key={chat.id} value={chat.id}>{chat.title || `Чат #${chat.id}`}</option>)}
            </select>
          )}
          {error && <div className="gg-reminder-message is-error">{error}</div>}
          {notice && <div className="gg-reminder-message is-ok">{notice}</div>}
          <button className="gg-btn gg-btn-primary" type="button" onClick={() => void createReminder()} disabled={!title.trim()}>
            Создать напоминание
          </button>
        </div>

        <div className="gg-journal-list">
          {active.map(renderReminder)}
          {active.length === 0 && <div className="gg-panel-empty">Активных напоминаний нет</div>}
        </div>

        {history.length > 0 && (
          <>
            <div className="gg-panel-header" style={{ paddingLeft: 0, paddingRight: 0, marginTop: 24 }}>
              <h3 className="gg-panel-title" style={{ fontSize: 16 }}>История</h3>
              <div className="gg-panel-meta">{history.length}</div>
            </div>
            <div className="gg-journal-list">{history.map(renderReminder)}</div>
          </>
        )}
      </div>
    </div>
  )
}
