import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { semverGt } from '../lib/semver'

type ModalPhase = 'available' | 'pending' | 'downloading' | 'ready' | 'installing'

const RELEASES_URL = 'https://github.com/frolofpavel/verstak/releases'

/**
 * Модалка при старте: обновление доступно / качается / готово к установке.
 * «Позже» скрывает до следующего перезапуска (состояние сессии).
 */
export function UpdateAvailableModal() {
  const t = useT()
  const [dismissed, setDismissed] = useState(false)
  const [visible, setVisible] = useState(false)
  const [version, setVersion] = useState('')
  const [phase, setPhase] = useState<ModalPhase>('available')
  const [percent, setPercent] = useState(0)
  const [currentVersion, setCurrentVersion] = useState('')
  const [installError, setInstallError] = useState('')

  useEffect(() => {
    void window.api.app.getVersion().then(setCurrentVersion).catch(() => {})
  }, [])

  useEffect(() => {
    const isNewerThanInstalled = (v: string) => !!currentVersion && semverGt(v, currentVersion)

    const showUpdate = (nextPhase: ModalPhase, v: string) => {
      if (v) setVersion(v)
      setPhase(nextPhase)
      if (!dismissed) setVisible(true)
    }

    const applyState = (state: {
      phase: string
      version?: string
      percent?: number
      pendingRelease?: boolean
    }) => {
      if (state.phase === 'installing' && state.version) {
        showUpdate('installing', state.version)
        setPercent(100)
        return
      }
      if ((state.phase === 'ready' || state.phase === 'downloaded') && state.version) {
        if (!isNewerThanInstalled(state.version)) return
        showUpdate('ready', state.version)
        setPercent(100)
        return
      }
      if (state.phase === 'downloading' && state.version) {
        showUpdate('downloading', state.version)
        if (state.percent != null) setPercent(state.percent)
        return
      }
      if (state.phase === 'available' && state.version) {
        if (!state.pendingRelease && !isNewerThanInstalled(state.version)) return
        showUpdate(state.pendingRelease ? 'pending' : 'available', state.version)
      }
    }

    void window.api.updater.getState().then(applyState).catch(() => {})

    const offState = window.api.updater.onState(applyState)
    const offAvailable = window.api.updater.onAvailable(({ version: v, pendingRelease }) => {
      if (!pendingRelease && !isNewerThanInstalled(v)) return
      showUpdate(pendingRelease ? 'pending' : 'available', v)
    })
    const offProgress = window.api.updater.onProgress(({ percent: p }) => {
      setPercent(p)
      setPhase('downloading')
      if (!dismissed) setVisible(true)
    })
    const offDownloaded = window.api.updater.onDownloaded(({ version: v }) => {
      if (!isNewerThanInstalled(v)) return
      showUpdate('ready', v)
      setPercent(100)
    })
    const offReady = window.api.updater.onReady(({ version: v }) => {
      if (!isNewerThanInstalled(v)) return
      showUpdate('ready', v)
      setPercent(100)
    })

    const kickDownload = () => { void window.api.updater.ensureDownload().catch(() => {}) }
    kickDownload()
    const offAvailableKick = window.api.updater.onAvailable(() => { kickDownload() })

    return () => {
      offState()
      offAvailable()
      offProgress()
      offDownloaded()
      offReady()
      offAvailableKick()
    }
  }, [dismissed, currentVersion])

  if (!visible || dismissed) return null

  const installNow = async () => {
    setInstallError('')
    setPhase('installing')
    try {
      const result = await window.api.updater.install()
      if (result?.ok === false) {
        setPhase('ready')
        setInstallError(result.reason || t.settings.updateError)
      }
    } catch (err) {
      setPhase('ready')
      setInstallError(err instanceof Error ? err.message : t.settings.updateError)
    }
  }

  const body =
    phase === 'installing'
      ? t.updates.installingBar.replace('{version}', version)
      : phase === 'ready'
      ? t.updates.availableReady.replace('{version}', version)
      : phase === 'downloading'
        ? t.updates.downloadingBar.replace('{version}', version).replace('{percent}', String(percent))
        : phase === 'pending'
          ? t.updates.pendingBody.replace('{version}', version)
          : t.updates.availableBody.replace('{version}', version)

  return (
    <div className="gg-modal-backdrop" role="dialog" aria-modal="true">
      <div className="gg-modal" onClick={e => e.stopPropagation()}>
        <div className="gg-modal-header">
          <div className="gg-modal-title">{t.updates.availableTitle}</div>
          <button
            type="button"
            className="gg-modal-close"
            onClick={() => setDismissed(true)}
            aria-label={t.updates.later}
          >
            ×
          </button>
        </div>
        <div className="gg-modal-body">
          <p className="gg-models-required-text">{body}</p>
          {installError && <p className="gg-models-required-text" style={{ color: 'var(--error)' }}>{installError}</p>}
          {phase === 'downloading' && (
            <div className="gg-update-modal-progress">
              <div className="gg-update-progress" style={{ width: `${percent}%` }} />
            </div>
          )}
        </div>
        <div className="gg-modal-footer">
          <button type="button" className="gg-btn gg-btn-ghost" onClick={() => setDismissed(true)}>
            {t.updates.later}
          </button>
          {(phase === 'ready' || phase === 'installing') && (
            <button
              type="button"
              className="gg-btn gg-btn-primary"
              onClick={() => void installNow()}
              disabled={phase === 'installing'}
            >
              {phase === 'installing' ? '…' : t.updates.install}
            </button>
          )}
          {phase === 'pending' && (
            <button
              type="button"
              className="gg-btn gg-btn-primary"
              onClick={() => void window.api.app.openExternal(RELEASES_URL)}
            >
              {t.updates.openReleases}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
