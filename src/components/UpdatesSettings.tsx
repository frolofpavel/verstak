import { useCallback, useEffect, useState } from 'react'
import { useT } from '../i18n'
import { PastReleasesModal } from './PastReleasesModal'
import { ReleaseNotesModal, type ReleaseNote } from './ReleaseNotesModal'

type Status = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error' | 'pending'

function friendlyUpdateError(raw: string, fallback: string, noRelease: string): string {
  if (!raw) return fallback
  const m = raw.toLowerCase()
  if (
    m.includes('404')
    || m.includes('not found')
    || m.includes('latest.yml')
    || m.includes('no published')
    || m.includes('cannot find')
  ) {
    return noRelease
  }
  return raw.length > 160 ? fallback : raw
}

export function UpdatesSettings() {
  const t = useT()
  const [version, setVersion] = useState('…')
  const [status, setStatus] = useState<Status>('idle')
  const [remoteVersion, setRemoteVersion] = useState('')
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState('')
  const [notesOpen, setNotesOpen] = useState(false)
  const [pastOpen, setPastOpen] = useState(false)
  const [releaseNotes, setReleaseNotes] = useState<ReleaseNote[]>([])
  const [notesLoading, setNotesLoading] = useState(false)
  const [notesTargetVersion, setNotesTargetVersion] = useState('')

  useEffect(() => {
    const applyPhase = (
      phase: string,
      v?: string,
      p?: number,
      err?: string,
      pendingRelease?: boolean,
    ) => {
      if (phase === 'available') {
        if (v) setRemoteVersion(v)
        setStatus(pendingRelease ? 'pending' : 'available')
        setError('')
      } else if (phase === 'downloading') {
        if (v) setRemoteVersion(v)
        setStatus('downloading')
        if (p != null) setPercent(p)
        setError('')
      } else if (phase === 'downloaded') {
        if (v) setRemoteVersion(v)
        setStatus('ready')
        setError('')
      } else if (phase === 'not-available') {
        setStatus('current')
        setError('')
      } else if (phase === 'checking') {
        setStatus('checking')
      } else if (phase === 'error') {
        setError(friendlyUpdateError(err || '', t.settings.updateError, t.settings.updateNoRelease))
        setStatus('error')
      }
    }

    void window.api.app.getVersion().then(setVersion)
    void window.api.updater.getState().then(s => applyPhase(s.phase, s.version, s.percent, s.error, s.pendingRelease))

    const offState = window.api.updater.onState(s => applyPhase(s.phase, s.version, s.percent, s.error, s.pendingRelease))
    const offAvailable = window.api.updater.onAvailable(({ version: v, pendingRelease }) => {
      setRemoteVersion(v)
      setStatus(pendingRelease ? 'pending' : 'available')
    })
    const offProgress = window.api.updater.onProgress(({ percent: p }) => {
      setPercent(p)
      setStatus('downloading')
    })
    const offDownloaded = window.api.updater.onDownloaded(({ version: v }) => {
      setRemoteVersion(v)
      setStatus('ready')
    })
    const offNotAvailable = window.api.updater.onNotAvailable(() => {
      setStatus('current')
    })
    const offError = window.api.updater.onError(({ error: e }) => {
      setError(friendlyUpdateError(e, t.settings.updateError, t.settings.updateNoRelease))
      setStatus('error')
    })
    return () => {
      offState()
      offAvailable()
      offProgress()
      offDownloaded()
      offNotAvailable()
      offError()
    }
  }, [])

  const viewReleaseNotes = useCallback(async () => {
    setNotesLoading(true)
    try {
      const targetVersion = remoteVersion && status !== 'current' && status !== 'idle'
        ? remoteVersion
        : version.replace(/^v/, '')
      const notes = await window.api.updater.getReleaseNotes({ version: targetVersion })
      setReleaseNotes(notes)
      setNotesTargetVersion(targetVersion)
      setNotesOpen(true)
    } finally {
      setNotesLoading(false)
    }
  }, [remoteVersion, status, version])

  const check = useCallback(async () => {
    setStatus('checking')
    setError('')
    const result = await window.api.updater.check()
    if (result.error) {
      setError(friendlyUpdateError(result.error, t.settings.updateError, t.settings.updateNoRelease))
      setStatus('error')
      return
    }
    if (!result.available) {
      setStatus('current')
      return
    }
    if (result.version) setRemoteVersion(result.version)
    setStatus(result.pendingRelease ? 'pending' : 'available')
  }, [])

  const notesTitle = notesTargetVersion && remoteVersion === notesTargetVersion && status !== 'current'
    ? t.updates.releaseNotesTitleAvailable.replace('{version}', notesTargetVersion)
    : t.updates.releaseNotesTitleCurrent.replace('{version}', notesTargetVersion || version.replace(/^v/, ''))

  return (
    <div className="gg-settings-extra">
      <div className="gg-settings-section-title">{t.settings.updates}</div>
      <div className="gg-settings-hint" style={{ marginBottom: 16 }}>{t.settings.updatesHint}</div>

      <div className="gg-settings-row" style={{ marginBottom: 12 }}>
        <label className="gg-settings-label">{t.settings.releaseNotes}</label>
        <div className="gg-updates-notes-actions">
          <button
            type="button"
            className="gg-btn gg-btn-ghost"
            onClick={() => void viewReleaseNotes()}
            disabled={notesLoading || version === '…'}
          >
            {notesLoading ? t.settings.viewReleaseNotesLoading : t.settings.viewReleaseNotes}
          </button>
          <button
            type="button"
            className="gg-btn gg-btn-ghost"
            onClick={() => setPastOpen(true)}
          >
            {t.settings.viewPastUpdates}
          </button>
        </div>
      </div>

      <div className="gg-settings-row">
        <label className="gg-settings-label">{t.settings.currentVersion}</label>
        <div style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>v{version}</div>
      </div>

      <div className="gg-settings-row">
        <label className="gg-settings-label">{t.settings.checkUpdates}</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
          <button type="button" className="gg-btn gg-btn-ghost" onClick={() => void check()} disabled={status === 'checking'}>
            {status === 'checking' ? t.settings.checkingUpdates : t.settings.checkUpdates}
          </button>
          {status === 'current' && <span className="gg-settings-hint">{t.settings.upToDate}</span>}
          {status === 'available' && remoteVersion && (
            <span className="gg-settings-hint">{t.settings.updateAvailable.replace('{version}', remoteVersion)}</span>
          )}
          {status === 'pending' && remoteVersion && (
            <span className="gg-settings-hint">{t.settings.updatePendingRelease.replace('{version}', remoteVersion)}</span>
          )}
          {status === 'downloading' && remoteVersion && (
            <span className="gg-settings-hint">
              {t.settings.downloadingUpdate.replace('{version}', remoteVersion).replace('{percent}', String(percent))}
            </span>
          )}
          {status === 'ready' && remoteVersion && (
            <div className="gg-updates-ready-row">
              <span className="gg-settings-hint">{t.settings.updateReady.replace('{version}', remoteVersion)}</span>
              <button type="button" className="gg-btn gg-btn-primary" onClick={() => void window.api.updater.install()}>
                {t.settings.installUpdate}
              </button>
            </div>
          )}
          {status === 'error' && <span className="gg-settings-hint" style={{ color: 'var(--error)' }}>{error || t.settings.updateError}</span>}
        </div>
      </div>

      <ReleaseNotesModal
        open={notesOpen}
        onClose={() => setNotesOpen(false)}
        notes={releaseNotes}
        title={notesTitle}
        emptyText={t.settings.releaseNotesEmpty}
      />
      <PastReleasesModal open={pastOpen} onClose={() => setPastOpen(false)} />
    </div>
  )
}