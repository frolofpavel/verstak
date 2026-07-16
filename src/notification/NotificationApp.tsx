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

type ToastTone = 'ok' | 'error' | 'reminder' | 'sent' | 'help'

const AUTO_HIDE_MS = 10_000
const MAX_VISIBLE = 3

function toastTone(toast: ToastItem): ToastTone {
  if (toast.isError) return 'error'
  if (toast.kind === 'chat-reminder-sent') return 'sent'
  if (toast.reminderId) return 'reminder'
  if (toast.isHelp) return 'help'
  return 'ok'
}

function stripReminderPrefix(title?: string): string | undefined {
  return title?.replace(/^Напоминание:\s*/i, '').trim() || undefined
}

function toastHeadline(toast: ToastItem): string {
  if (toast.projectName) return toast.projectName
  if (toast.reminderId) return stripReminderPrefix(toast.title) ?? 'Напоминание'
  return toast.title ?? 'Verstak'
}

function toastEyebrow(toast: ToastItem): string {
  if (toast.isError) return 'Ошибка'
  if (toast.kind === 'chat-reminder-sent') return 'Команда отправлена'
  if (toast.reminderId) return 'Напоминание'
  if (toast.isHelp) return 'Справка Verstak'
  return toast.projectName ? (toast.title ?? 'Verstak') : 'Verstak'
}

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

  useEffect(() => {
    const theme = toasts[0]?.theme === 'light' ? 'light' : 'nord'
    const root = document.documentElement
    root.setAttribute('data-theme', theme)
    root.classList.add('gg-atelier')
  }, [toasts])

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
      {toasts.map(toast => {
        const tone = toastTone(toast)
        const headline = toastHeadline(toast)
        const eyebrow = toastEyebrow(toast)
        const role = tone === 'error' || tone === 'reminder' ? 'alert' : 'status'

        return (
          <article
            key={toast.id}
            className={`gg-app-toast is-${tone}`}
            data-persistent={toast.persistent ? 'true' : 'false'}
            role={role}
            onClick={() => openMain(toast.id, toast)}
          >
            <div className="gg-app-toast-main">
              <div className="gg-app-toast-mark" aria-hidden="true">
                <img src={iconUrl} alt="" className="gg-app-toast-icon" width={22} height={22} />
              </div>
              <div className="gg-app-toast-copy">
                <div className="gg-app-toast-topline">
                  <span className="gg-app-toast-tone" aria-hidden="true" />
                  <span className="gg-app-toast-eyebrow">{eyebrow}</span>
                </div>
                <div className="gg-app-toast-headline">{headline}</div>
                {toast.body ? <div className="gg-app-toast-body">{toast.body}</div> : null}
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
            {toast.kind === 'chat-reminder-sent' && toast.chatId ? (
              <div className="gg-app-toast-actions" onClick={e => e.stopPropagation()}>
                <button type="button" className="is-primary" onClick={() => openMain(toast.id, toast)}>Перейти в чат</button>
                <button type="button" className="is-muted" onClick={() => dismiss(toast.id)}>Закрыть</button>
              </div>
            ) : toast.reminderId ? (
              <div className="gg-app-toast-actions" onClick={e => e.stopPropagation()}>
                <button type="button" className="is-primary" onClick={() => openReminder(toast.id, toast.reminderId!)}>Открыть</button>
                <button type="button" onClick={() => snoozeReminder(toast.id, toast.reminderId!)}>Через 10 минут</button>
                <button type="button" className="is-muted" onClick={() => dismissReminder(toast.id, toast.reminderId!)}>Закрыть</button>
              </div>
            ) : null}
          </article>
        )
      })}
    </div>
  )
}
