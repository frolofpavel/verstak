import { useEffect, useRef, useState } from 'react'
import iconUrl from '../assets/icon.png'

interface ToastPayload {
  title?: string
  body: string
  projectName?: string
  projectPath?: string
  isHelp?: boolean
  helpProjectPath?: string
  isError?: boolean
  theme?: 'nord' | 'light'
  reminderId?: number
  chatId?: number
  kind?: 'reminder' | 'chat-reminder-sent'
  persistent?: boolean
}

interface ToastItem extends ToastPayload {
  id: number
  createdAt: number
}

const AUTO_HIDE_MS = 10_000
const MAX_VISIBLE = 3

export function NotificationApp() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const idRef = useRef(0)
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    const off = window.toastApi.onShow((payload) => {
      const id = ++idRef.current
      const item: ToastItem = {
        ...payload,
        id,
        createdAt: Date.now(),
        theme: payload.theme === 'light' ? 'light' : 'nord'
      }
      setToasts(prev => {
        const sameReminder = typeof item.reminderId === 'number'
          ? prev.find(t => t.reminderId === item.reminderId && (t.kind ?? 'reminder') === (item.kind ?? 'reminder'))
          : null
        if (sameReminder) {
          return [
            { ...sameReminder, ...item, id: sameReminder.id },
            ...prev.filter(t => t.id !== sameReminder.id)
          ].slice(0, MAX_VISIBLE)
        }
        return [item, ...prev].slice(0, MAX_VISIBLE)
      })

      if (!item.persistent) {
        const timer = setTimeout(() => {
          setToasts(prev => {
            const next = prev.filter(t => t.id !== id)
            if (next.length === 0) window.toastApi.hideWindow()
            return next
          })
          timersRef.current.delete(id)
        }, AUTO_HIDE_MS)
        timersRef.current.set(id, timer)
      }
    })
    return () => {
      off()
      for (const t of timersRef.current.values()) clearTimeout(t)
      timersRef.current.clear()
    }
  }, [])

  function dismiss(id: number) {
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
    setToasts(prev => {
      const next = prev.filter(t => t.id !== id)
      if (next.length === 0) window.toastApi.hideWindow()
      return next
    })
  }

  function dismissReminderToasts(reminderId: number) {
    setToasts(prev => {
      const removedIds = prev.filter(t => t.reminderId === reminderId).map(t => t.id)
      for (const toastId of removedIds) {
        const timer = timersRef.current.get(toastId)
        if (timer) clearTimeout(timer)
        timersRef.current.delete(toastId)
      }
      const next = prev.filter(t => t.reminderId !== reminderId)
      if (next.length === 0) window.toastApi.hideWindow()
      return next
    })
  }

  function dismissReminder(id: number, reminderId: number) {
    window.toastApi.reminderDismiss(reminderId)
    dismissReminderToasts(reminderId)
  }

  function snoozeReminder(id: number, reminderId: number) {
    window.toastApi.reminderSnooze(reminderId)
    dismissReminderToasts(reminderId)
  }

  function openReminder(id: number, reminderId: number) {
    window.toastApi.reminderOpen(reminderId)
    dismissReminderToasts(reminderId)
  }

  function openMain(id: number, toast: ToastItem) {
    if (toast.kind === 'chat-reminder-sent' && toast.chatId) {
      window.toastApi.focusMain(toast.projectPath, false, toast.chatId)
      dismiss(id)
      return
    }
    if (toast.reminderId) {
      openReminder(id, toast.reminderId)
      return
    }
    if (toast.isHelp) {
      window.toastApi.focusMain(undefined, true)
    } else {
      window.toastApi.focusMain(toast.projectPath)
    }
    dismiss(id)
  }

  if (toasts.length === 0) return null

  return (
    <div className="gg-toast-overlay">
      {toasts.map(toast => (
        <article
          key={toast.id}
          className={`gg-app-toast ${toast.isError ? 'is-error' : 'is-ok'}`}
          data-theme={toast.theme ?? 'nord'}
          role="alert"
          onClick={() => openMain(toast.id, toast)}
        >
          <div className="gg-app-toast-head">
            <div className="gg-app-toast-brand">
              <img src={iconUrl} alt="" className="gg-app-toast-icon" width={20} height={20} />
              <span className="gg-app-toast-title">{toast.title ?? 'Verstak'}</span>
            </div>
            <button
              type="button"
              className="gg-app-toast-close"
              onClick={(e) => {
                e.stopPropagation()
                if (toast.kind === 'chat-reminder-sent') dismiss(toast.id)
                else if (toast.reminderId) dismissReminder(toast.id, toast.reminderId)
                else dismiss(toast.id)
              }}
              aria-label="Закрыть"
            >
              ×
            </button>
          </div>
          {toast.projectName ? (
            <div className="gg-app-toast-project">{toast.projectName}</div>
          ) : null}
          {toast.body ? <div className="gg-app-toast-body">{toast.body}</div> : null}
          {toast.kind === 'chat-reminder-sent' && toast.chatId ? (
            <div className="gg-app-toast-actions" onClick={e => e.stopPropagation()}>
              <button type="button" onClick={() => openMain(toast.id, toast)}>Перейти в чат</button>
              <button type="button" onClick={() => dismiss(toast.id)}>Закрыть</button>
            </div>
          ) : toast.reminderId ? (
            <div className="gg-app-toast-actions" onClick={e => e.stopPropagation()}>
              <button type="button" onClick={() => openReminder(toast.id, toast.reminderId!)}>Открыть</button>
              <button type="button" onClick={() => snoozeReminder(toast.id, toast.reminderId!)}>Через 10 минут</button>
              <button type="button" onClick={() => dismissReminder(toast.id, toast.reminderId!)}>Закрыть</button>
            </div>
          ) : null}
        </article>
      ))}
    </div>
  )
}
