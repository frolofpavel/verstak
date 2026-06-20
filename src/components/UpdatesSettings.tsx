import { useCallback, useEffect, useState } from 'react'
import { useT } from '../i18n'
import { semverGt } from '../lib/semver'
import { formatUpdaterError, type UpdaterErrorPayload } from '../lib/updater-error'
import { formatStagingStepLabel, type StagingStep } from '../lib/staging-step-label'
import { PastReleasesModal } from './PastReleasesModal'

type Status = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'staging' | 'ready' | 'installing' | 'error' | 'pending'

function formatDownloadBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

type CheckResult = UpdaterErrorPayload & {
  available: boolean
  version?: string
  installedVersion?: string
  phase?: string
  percent?: number
  stagingStep?: StagingStep
  pendingRelease?: boolean
}

export function UpdatesSettings() {
  const t = useT()
  const errorT = {
    updateError: t.settings.updateError,
    updateNoRelease: t.settings.updateNoRelease,
    updateRateLimitMinutes: t.settings.updateRateLimitMinutes,
    updateRateLimitHour: t.settings.updateRateLimitHour,
  }
  const [version, setVersion] = useState('…')
  const [versionLoaded, setVersionLoaded] = useState(false)
  const [status, setStatus] = useState<Status>('idle')
  const [remoteVersion, setRemoteVersion] = useState('')
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState('')
  const [pastOpen, setPastOpen] = useState(false)
  const [bytesTransferred, setBytesTransferred] = useState(0)
  const [bytesTotal, setBytesTotal] = useState(0)
  const [stagingStep, setStagingStep] = useState<StagingStep | undefined>()
  const [showUpToDateNotice, setShowUpToDateNotice] = useState(false)
  const installedNorm = version.replace(/^v/, '')

  const isNewerThanInstalled = useCallback((v?: string) => {
    if (!v || !versionLoaded) return false
    return semverGt(v, installedNorm)
  }, [installedNorm, versionLoaded])

  const applyAvailable = useCallback((v: string, pendingRelease?: boolean) => {
    setRemoteVersion(v)
    setStatus(pendingRelease ? 'pending' : 'available')
    setError('')
    setShowUpToDateNotice(false)
  }, [])

  const applyCheckResult = useCallback((result: CheckResult) => {
    if (result.error || result.errorCode || result.phase === 'error') {
      setError(formatUpdaterError(result, errorT))
      setStatus('error')
      setShowUpToDateNotice(false)
      return
    }
    if (result.phase === 'installing') {
      if (result.version) setRemoteVersion(result.version)
      setStatus('installing')
      setShowUpToDateNotice(false)
      return
    }
    if (result.phase === 'ready' || result.phase === 'downloaded') {
      if (result.version) setRemoteVersion(result.version)
      setStatus('ready')
      setShowUpToDateNotice(false)
      return
    }
    if (result.phase === 'staging') {
      if (result.version) setRemoteVersion(result.version)
      setStatus('staging')
      if (result.percent != null) setPercent(result.percent)
      setShowUpToDateNotice(false)
      return
    }
    if (result.phase === 'downloading') {
      if (result.version) setRemoteVersion(result.version)
      setStatus('downloading')
      setShowUpToDateNotice(false)
      return
    }
    if (result.available && result.version) {
      applyAvailable(result.version, result.pendingRelease)
      return
    }
    if (result.version && isNewerThanInstalled(result.version)) {
      applyAvailable(result.version, result.pendingRelease)
      return
    }
    if (result.phase === 'idle') {
      setStatus('idle')
      return
    }
    setStatus('current')
    setError('')
  }, [applyAvailable, errorT, isNewerThanInstalled])

  useEffect(() => {
    const applyPhase = (
      phase: string,
      v?: string,
      p?: number,
      err?: string,
      pendingRelease?: boolean,
      errorCode?: string,
      rateLimitMinutes?: number,
      step?: StagingStep,
    ) => {
      if (phase === 'available') {
        if (!pendingRelease && !isNewerThanInstalled(v)) {
          setStatus('current')
          return
        }
        if (v) applyAvailable(v, pendingRelease)
      } else if (phase === 'downloading') {
        if (v) setRemoteVersion(v)
        setStatus('downloading')
        if (p != null) setPercent(p)
        setError('')
        setShowUpToDateNotice(false)
      } else if (phase === 'installing') {
        if (v) setRemoteVersion(v)
        setStatus('installing')
        setError('')
        setShowUpToDateNotice(false)
      } else if (phase === 'staging') {
        if (v) setRemoteVersion(v)
        setStatus('staging')
        if (p != null) setPercent(p)
        setStagingStep(step)
        setError('')
        setShowUpToDateNotice(false)
      } else if (phase === 'ready' || phase === 'downloaded') {
        if (!isNewerThanInstalled(v)) {
          setStatus('current')
          return
        }
        if (v) setRemoteVersion(v)
        setStatus('ready')
        setStagingStep(undefined)
        setError('')
        setShowUpToDateNotice(false)
      } else if (phase === 'not-available') {
        if (v && isNewerThanInstalled(v)) {
          applyAvailable(v, pendingRelease)
          return
        }
        setStatus('current')
        setError('')
      } else if (phase === 'checking') {
        setStatus('checking')
        setShowUpToDateNotice(false)
      } else if (phase === 'error') {
        setError(formatUpdaterError({ error: err, errorCode, rateLimitMinutes }, errorT))
        setStatus('error')
        setShowUpToDateNotice(false)
      } else if (phase === 'idle') {
        setStatus('idle')
      }
    }

    void window.api.app.getVersion()
      .then((v) => {
        setVersion(v)
        setVersionLoaded(true)
      })
      .catch(() => setVersionLoaded(true))
    void window.api.updater.getState()
      .then(s => applyPhase(
        s.phase,
        s.remoteVersion ?? s.version,
        s.percent,
        s.error,
        s.pendingRelease,
        s.errorCode,
        s.rateLimitMinutes,
        s.stagingStep,
      ))
      .catch(() => {})

    const offState = window.api.updater.onState(s => applyPhase(
      s.phase,
      s.version,
      s.percent,
      s.error,
      s.pendingRelease,
      s.errorCode,
      s.rateLimitMinutes,
      s.stagingStep,
    ))
    const offAvailable = window.api.updater.onAvailable(({ version: v, pendingRelease }) => {
      if (!pendingRelease && !isNewerThanInstalled(v)) {
        setStatus('current')
        return
      }
      applyAvailable(v, pendingRelease)
    })
    const offProgress = window.api.updater.onProgress(({ percent: p, transferred, total }) => {
      setPercent(p)
      setStatus('downloading')
      if (transferred != null) setBytesTransferred(transferred)
      if (total != null) setBytesTotal(total)
    })
    const offReady = window.api.updater.onReady(({ version: v }) => {
      if (!isNewerThanInstalled(v)) {
        setStatus('current')
        return
      }
      setRemoteVersion(v)
      setStatus('ready')
    })
    const offNotAvailable = window.api.updater.onNotAvailable(() => {
      if (remoteVersion && isNewerThanInstalled(remoteVersion)) return
      setStatus('current')
    })
    const offError = window.api.updater.onError((payload) => {
      setError(formatUpdaterError(payload, errorT))
      setStatus('error')
    })
    return () => {
      offState()
      offAvailable()
      offProgress()
      offReady()
      offNotAvailable()
      offError()
    }
  }, [applyAvailable, errorT, isNewerThanInstalled, remoteVersion])

  const check = useCallback(async () => {
    setStatus('checking')
    setError('')
    setShowUpToDateNotice(false)
    try {
      const result = await window.api.updater.check()
      applyCheckResult(result)
      const isUpToDate =
        !result.available &&
        !result.error &&
        !result.errorCode &&
        result.phase !== 'error' &&
        result.phase !== 'installing' &&
        result.phase !== 'ready' &&
        result.phase !== 'downloaded' &&
        result.phase !== 'downloading' &&
        result.phase !== 'staging'
      if (isUpToDate) setShowUpToDateNotice(true)
    } catch {
      setError(errorT.updateError)
      setStatus('error')
      setShowUpToDateNotice(false)
    }
  }, [applyCheckResult, errorT])

  const installNow = useCallback(async () => {
    setStatus('installing')
    setError('')
    try {
      const result = await window.api.updater.install()
      if (result?.ok === false) {
        setStatus('ready')
        setError(result.reason || errorT.updateError)
      }
    } catch (err) {
      setStatus('ready')
      setError(err instanceof Error ? err.message : errorT.updateError)
    }
  }, [errorT])

  const busy = status === 'checking' || status === 'downloading' || status === 'staging' || status === 'installing'
  const showDownloadProgress = (status === 'downloading' || status === 'staging') && !!remoteVersion
  const stagingMeta = remoteVersion
    ? formatStagingStepLabel(stagingStep, remoteVersion, percent, {
      updateStagingSetup: t.settings.updateStagingSetup,
      updateStagingPayload: t.settings.updateStagingPayload,
      updateStagingVerify: t.settings.updateStagingVerify,
      updateStagingDone: t.settings.updateStagingDone,
    })
    : ''

  const downloadMeta = bytesTotal > 0
    ? t.settings.updateProgressBytes
      .replace('{downloaded}', formatDownloadBytes(bytesTransferred))
      .replace('{total}', formatDownloadBytes(bytesTotal))
      .replace('{percent}', String(percent))
    : t.settings.downloadingUpdate
      .replace('{version}', remoteVersion)
      .replace('{percent}', String(percent))

  return (
    <div className="gg-settings-extra">
      <div className="gg-settings-section-title">{t.settings.updates}</div>
      <div className="gg-settings-hint" style={{ marginBottom: 16 }}>{t.settings.updatesHint}</div>

      <div className="gg-settings-row" style={{ marginBottom: 12 }}>
        <label className="gg-settings-label">{t.settings.releaseNotes}</label>
        <button
          type="button"
          className="gg-btn gg-btn-ghost"
          onClick={() => setPastOpen(true)}
          disabled={version === '…'}
        >
          {t.settings.viewAllUpdates}
        </button>
      </div>
      <div className="gg-settings-row">
        <label className="gg-settings-label">{t.settings.currentVersion}</label>
        <div style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>v{version}</div>
      </div>

      <div className="gg-settings-row">
        <label className="gg-settings-label">{t.settings.checkUpdates}</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
          <button type="button" className="gg-btn gg-btn-ghost" onClick={() => void check()} disabled={busy}>
            {status === 'checking' ? t.settings.checkingUpdates : t.settings.checkUpdates}
          </button>
          {showDownloadProgress && (
            <div className="gg-updates-settings-progress-wrap">
              <div className="gg-updates-settings-progress-label">
                {status === 'staging' ? stagingMeta : downloadMeta}
              </div>
              <div
                className="gg-update-modal-progress gg-updates-settings-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-label={status === 'staging' ? stagingMeta : downloadMeta}
              >
                <div
                  className="gg-update-progress"
                  style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
                />
              </div>
              {status === 'staging' && (
                <div className="gg-settings-hint">{t.settings.updateStagingDurationHint}</div>
              )}
            </div>
          )}
          {showUpToDateNotice && (
            <div className="gg-updates-up-to-date" role="status">
              {t.settings.upToDate}
            </div>
          )}
          {status === 'pending' && remoteVersion && (
            <span className="gg-settings-hint">{t.settings.updatePendingRelease.replace('{version}', remoteVersion)}</span>
          )}
          {status === 'available' && remoteVersion && (
            <span className="gg-settings-hint">{t.settings.updateAvailable.replace('{version}', remoteVersion)}</span>
          )}
          {status === 'ready' && remoteVersion && (
            <div className="gg-updates-ready-row">
              <span className="gg-settings-hint">{t.settings.updateReady.replace('{version}', remoteVersion)}</span>
              <button type="button" className="gg-btn gg-btn-primary" onClick={() => void installNow()}>
                {t.settings.installUpdate}
              </button>
              {error && <span className="gg-settings-hint" style={{ color: 'var(--error)' }}>{error}</span>}
            </div>
          )}
          {status === 'installing' && remoteVersion && (
            <span className="gg-settings-hint">{t.settings.updateInstalling.replace('{version}', remoteVersion)}</span>
          )}
          {status === 'error' && <span className="gg-settings-hint" style={{ color: 'var(--error)' }}>{error || t.settings.updateError}</span>}
        </div>
      </div>

      <PastReleasesModal open={pastOpen} onClose={() => setPastOpen(false)} installedVersion={installedNorm} />
    </div>
  )
}
