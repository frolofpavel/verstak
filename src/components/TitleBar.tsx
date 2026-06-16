import { useCallback, useEffect, useState, type ReactNode } from 'react'
import iconUrl from '../assets/icon.png'

function MinimizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <rect x="1" y="7.5" width="8" height="1.25" rx="0.5" fill="currentColor" />
    </svg>
  )
}

function MaximizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <rect x="1.5" y="1.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  )
}

function RestoreIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <rect x="2.5" y="0.75" width="6" height="6" rx="0.75" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <rect x="0.75" y="2.5" width="6" height="6" rx="0.75" fill="var(--titlebar-bg)" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d="M1.75 1.75L8.25 8.25M8.25 1.75L1.75 8.25" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  )
}

export function TitleBar() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.api.window.isMaximized().then(setMaximized)
    return window.api.window.onMaximizedChanged(setMaximized)
  }, [])

  const toggleMaximize = useCallback(() => {
    void window.api.window.maximize().then(setMaximized)
  }, [])

  return (
    <header className="gg-titlebar">
      <div
        className="gg-titlebar-drag"
        onDoubleClick={toggleMaximize}
      >
        <img src={iconUrl} alt="" className="gg-titlebar-icon" width={18} height={18} />
        <span className="gg-titlebar-brand">Verstak</span>
      </div>

      <div className="gg-titlebar-controls">
        <button
          type="button"
          className="gg-titlebar-btn"
          onClick={() => void window.api.window.minimize()}
          title="Свернуть"
          aria-label="Свернуть"
        >
          <MinimizeIcon />
        </button>
        <button
          type="button"
          className="gg-titlebar-btn"
          onClick={toggleMaximize}
          title={maximized ? 'Восстановить' : 'Развернуть'}
          aria-label={maximized ? 'Восстановить' : 'Развернуть'}
        >
          {maximized ? <RestoreIcon /> : <MaximizeIcon />}
        </button>
        <button
          type="button"
          className="gg-titlebar-btn gg-titlebar-btn-close"
          onClick={() => void window.api.window.close()}
          title="Закрыть"
          aria-label="Закрыть"
        >
          <CloseIcon />
        </button>
      </div>
    </header>
  )
}

export function WindowShell({ children }: { children: ReactNode }) {
  return (
    <div className="gg-window-shell">
      <TitleBar />
      <div className="gg-window-body">
        {children}
      </div>
    </div>
  )
}