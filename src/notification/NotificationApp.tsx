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
      setToasts(prev => [item, ...prev].slice(0, MAX_VISIBLE))

      const timer = setTimeout(() => {
        setToasts(prev => {
          const next = prev.filter(t => t.id !== id)
          if (next.length === 0) window.toastApi.hideWindow()
          return next
        })
        timersRef.current.delete(id)
      }, AUTO_HIDE_MS)
      timersRef.current.set(id, timer)
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

  function openMain(id: number, toast: ToastItem) {
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
              onClick={(e) => { e.stopPropagation(); dismiss(toast.id) }}
              aria-label="Закрыть"
            >
              ×
            </button>
          </div>
          {toast.projectName ? (
            <div className="gg-app-toast-project">{toast.projectName}</div>
          ) : null}
          {toast.body ? <div className="gg-app-toast-body">{toast.body}</div> : null}
        </article>
      ))}
    </div>
  )
}