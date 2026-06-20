import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { semverGt } from '../lib/semver'

/**
 * Плашка в правом нижнем углу: обновление скачано и предустановлено в фоне.
 * «Позже» скрывает до перезапуска; «Установить» — закрыть, применить, перезапустить.
 */
export function UpdateReadyToast() {
  const t = useT()
  const [dismissed, setDismissed] = useState(false)
  const [visible, setVisible] = useState(false)
  const [version, setVersion] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState('')
  const [currentVersion, setCurrentVersion] = useState('')

  useEffect(() => {
    void window.api.app.getVersion().then(setCurrentVersion).catch(() => {})
  }, [])

  useEffect(() => {
    const isNewer = (v?: string) => !!v && !!currentVersion && semverGt(v, currentVersion)

    const showReady = (v: string) => {
      if (!isNewer(v)) return
      setVersion(v)
      if (!dismissed) setVisible(true)
    }

    const applyState = (state: { phase: string; version?: string }) => {
      if (state.phase === 'installing' && state.version) {
        setInstalling(true)
        showReady(state.version)
        return
      }
      if (state.phase === 'ready' && state.version) {
        setInstalling(false)
        showReady(state.version)
      }
    }

    void window.api.updater.getState().then(applyState).catch(() => {})

    const offState = window.api.updater.onState(applyState)
    const offReady = window.api.updater.onReady(({ version: v }) => showReady(v))

    return () => {
      offState()
      offReady()
    }
  }, [dismissed, currentVersion])

  if (!visible || dismissed) return null

  const body = t.updates.readyToastBody.replace('{version}', version)
  const installNow = async () => {
    setInstallError('')
    setInstalling(true)
    try {
      const result = await window.api.updater.install()
      if (result?.ok === false) {
        setInstalling(false)
        setInstallError(result.reason || t.settings.updateError)
      }
    } catch (err) {
      setInstalling(false)
      setInstallError(err instanceof Error ? err.message : t.settings.updateError)
    }
  }

  return (
    <div className="gg-update-ready-toast" role="status" aria-live="polite">
      <div className="gg-update-ready-toast-head">
        <span className="gg-update-ready-toast-title">{t.updates.readyToastTitle}</span>
        <button
          type="button"
          className="gg-update-ready-toast-close"
          onClick={() => setDismissed(true)}
          aria-label={t.updates.later}
        >
          ×
        </button>
      </div>
      <p className="gg-update-ready-toast-body">{body}</p>
      {installError && <p className="gg-update-ready-toast-body" style={{ color: 'var(--error)' }}>{installError}</p>}
      <div className="gg-update-ready-toast-actions">
        <button type="button" className="gg-btn gg-btn-ghost" onClick={() => setDismissed(true)}>
          {t.updates.later}
        </button>
        <button
          type="button"
          className="gg-btn gg-btn-primary"
          onClick={() => void installNow()}
          disabled={installing}
        >
          {installing ? '…' : t.updates.install}
        </button>
      </div>
    </div>
  )
}
