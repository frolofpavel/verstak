import { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import type { ComputerUseCandidateDTO, ComputerUseStateDTO } from '../../types/api'

type Notice = {
  message: string
  severity: 'ok' | 'error'
}

export function ComputerUseSettingsCard() {
  const t = useT().settings.computerUse
  const [state, setState] = useState<ComputerUseStateDTO | null>(null)
  const [candidates, setCandidates] = useState<ComputerUseCandidateDTO[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const api = window.api?.computerUse

  useEffect(() => {
    let active = true
    if (!api) {
      setState(emptyState(false))
      return () => { active = false }
    }
    const refresh = () => void api.getState()
      .then(next => { if (active) setState(next) })
      .catch(() => { if (active) setState(emptyState(true)) })
    refresh()
    // The helper can invalidate a target independently (closed window/crash/TTL).
    // Polling reads only main-owned redacted state and keeps reload UI truthful.
    const poll = window.setInterval(refresh, 2_000)
    return () => {
      active = false
      window.clearInterval(poll)
    }
  }, [api])

  async function chooseWindow() {
    if (!api) return
    setBusy(true)
    setNotice(null)
    try {
      setCandidates(await api.listCandidates())
    } catch {
      setNotice({ message: t.failed, severity: 'error' })
    } finally {
      setBusy(false)
    }
  }

  async function bind(candidateId: string) {
    if (!api) return
    setBusy(true)
    setNotice(null)
    try {
      const result = await api.bind(candidateId)
      if (!result.ok) {
        setNotice({ message: result.error || t.failed, severity: 'error' })
        return
      }
      setState(await api.getState())
      setCandidates([])
      setNotice({ message: t.boundNotice, severity: 'ok' })
    } catch {
      setNotice({ message: t.failed, severity: 'error' })
    } finally {
      setBusy(false)
    }
  }

  async function unbind() {
    if (!api) return
    setBusy(true)
    try {
      await api.unbind()
      setState(current => ({
        supported: current?.supported ?? true,
        helperReady: current?.helperReady ?? true,
        bound: false,
        bindingGeneration: current?.bindingGeneration ?? 0,
        target: null,
        expiresAt: null,
        reconciliationRequired: false,
        reconciliationAcknowledgementAvailable: false,
      }))
      setCandidates([])
      setNotice({ message: t.revokedNotice, severity: 'ok' })
    } catch {
      setNotice({ message: t.failed, severity: 'error' })
    } finally {
      setBusy(false)
    }
  }

  async function acknowledgeUncertain() {
    if (!api) return
    setBusy(true)
    setNotice(null)
    try {
      const result = await api.acknowledgeUncertain()
      if (!result.ok) {
        setNotice({ message: result.error || t.failed, severity: 'error' })
        return
      }
      setState(await api.getState())
      setCandidates([])
      setNotice({ message: t.reconciledNotice, severity: 'ok' })
    } catch {
      setNotice({ message: t.failed, severity: 'error' })
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    if (!api) return
    setBusy(true)
    try {
      const ack = await api.stop()
      setNotice({
        message: ack.acknowledged ? t.stoppedNotice : t.failed,
        severity: ack.acknowledged ? 'ok' : 'error',
      })
    } catch {
      setNotice({ message: t.failed, severity: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const supported = state?.supported !== false
  const ready = Boolean(state?.helperReady)
  const bound = Boolean(state?.bound)
  const automaticBound = bound && state?.bindingSource === 'automatic'

  return (
    <section className="gg-browser-settings-card gg-computer-use-card" aria-live="polite" data-testid="computer-use-settings">
      <div className="gg-browser-settings-main">
        <div className="gg-browser-settings-icon" aria-hidden>
          <svg viewBox="0 0 32 32" fill="none">
            <rect x="4" y="5" width="24" height="17" rx="3" />
            <path d="M11 27h10M16 22v5M12 13h8M16 9v8" />
          </svg>
        </div>
        <div className="gg-browser-settings-copy">
          <div className="gg-browser-settings-eyebrow">Computer Use</div>
          <h3>{t.title}</h3>
          <p>{t.description}</p>
        </div>
      </div>

      <div className="gg-browser-settings-state">
        <span className={`gg-browser-settings-dot is-${bound ? 'connected' : ready ? 'ready' : 'repair'}`} aria-hidden />
        <div>
          <strong>{!supported ? t.unsupported : bound ? automaticBound ? t.automaticBound : t.bound : ready ? t.ready : t.unavailable}</strong>
          <p>{bound
            ? state?.reconciliationRequired
              ? state.reconciliationAcknowledgementAvailable
                ? t.reconcileHint
                : t.reconcileUnavailableHint
              : automaticBound
                ? state?.expiresAt
                  ? `${t.automaticBoundHint} ${t.claimExpires} ${new Date(state.expiresAt).toLocaleTimeString()}`
                  : t.automaticBoundHint
                : state?.expiresAt
                  ? `${t.boundHint} ${t.claimExpires} ${new Date(state.expiresAt).toLocaleTimeString()}`
                  : t.boundHint
            : t.readyHint}</p>
        </div>
      </div>

      <div className="gg-computer-use-advanced">
        <strong>{t.advanced}</strong>
        <p>{t.advancedHint}</p>
      </div>

      {bound && state?.target && (
        <div className="gg-computer-use-target">
          <strong>{state.target.title || t.untitled}</strong>
          <span>{state.target.processName}</span>
        </div>
      )}

      {bound ? (
        <div className="gg-computer-use-actions">
          {state?.reconciliationAcknowledgementAvailable && (
            <button type="button" className="gg-btn gg-btn-primary" onClick={() => void acknowledgeUncertain()} disabled={busy}>
              {t.reconcile}
            </button>
          )}
          <button type="button" className="gg-btn gg-btn-primary" onClick={() => void stop()} disabled={busy}>{t.stop}</button>
          <button type="button" className="gg-btn" onClick={() => void unbind()} disabled={busy}>{t.revoke}</button>
        </div>
      ) : (
        <button
          type="button"
          className="gg-btn gg-btn-primary gg-browser-settings-primary"
          onClick={() => void chooseWindow()}
          disabled={busy || !supported || !ready}
        >
          {busy ? t.working : t.choose}
        </button>
      )}

      {candidates.length > 0 && (
        <div className="gg-computer-use-candidates" aria-label={t.windows}>
          {candidates.map(candidate => (
            <button
              type="button"
              key={candidate.candidateId}
              disabled={busy || Boolean(candidate.blockedReason)}
              onClick={() => void bind(candidate.candidateId)}
              aria-label={`${candidate.title || t.untitled} — ${candidate.processName}`}
            >
              <strong>{candidate.title || t.untitled}</strong>
              <span>{candidate.processName}</span>
              {candidate.blockedReason && <small>{candidate.blockedReason}</small>}
            </button>
          ))}
        </div>
      )}

      {notice && <div className={`gg-browser-settings-notice is-${notice.severity}`}>{notice.message}</div>}
      <p className="gg-computer-use-boundary">{t.dataScope}</p>
      <p className="gg-computer-use-boundary">{t.boundary}</p>
    </section>
  )
}

function emptyState(supported: boolean): ComputerUseStateDTO {
  return {
    supported,
    helperReady: false,
    bound: false,
    bindingGeneration: 0,
    target: null,
    expiresAt: null,
    reconciliationRequired: false,
    reconciliationAcknowledgementAvailable: false,
  }
}
