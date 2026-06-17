import { useCallback, useEffect, useState } from 'react'
import iconUrl from '../assets/icon.png'

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d="M1.75 1.75L8.25 8.25M8.25 1.75L1.75 8.25" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  )
}

export function InstallerTitleBar() {
  return (
    <header className="gg-titlebar">
      <div className="gg-titlebar-drag">
        <img src={iconUrl} alt="" className="gg-titlebar-icon" width={18} height={18} />
        <span className="gg-titlebar-brand">Verstak · Установка</span>
      </div>
      <div className="gg-titlebar-controls">
        <button
          type="button"
          className="gg-titlebar-btn gg-titlebar-btn-close"
          onClick={() => void window.installer.window.close()}
          title="Закрыть"
          aria-label="Закрыть"
        >
          <CloseIcon />
        </button>
      </div>
    </header>
  )
}