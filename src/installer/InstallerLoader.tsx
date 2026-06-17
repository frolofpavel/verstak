import { useEffect, useState } from 'react'
import { INSTALLER_BOOT_MESSAGES } from './constants'

type InstallerLoaderProps = {
  title: string
  hint?: string
}

export function InstallerLoader({ title, hint }: InstallerLoaderProps) {
  const [msgIndex, setMsgIndex] = useState(0)

  useEffect(() => {
    const timer = window.setInterval(() => {
      setMsgIndex((i) => (i + 1) % INSTALLER_BOOT_MESSAGES.length)
    }, 2200)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div className="gg-installer-loader" role="status" aria-live="polite">
      <p className="gg-installer-loader-title">{title}</p>
      <p className="gg-installer-loader-status">
        {INSTALLER_BOOT_MESSAGES[msgIndex]}
        <span className="gg-installer-loader-dots" />
      </p>
      {hint ? <p className="gg-installer-loader-hint">{hint}</p> : null}
      <div className="gg-installer-loader-track" aria-hidden="true">
        <span className="gg-installer-loader-shimmer" />
      </div>
    </div>
  )
}