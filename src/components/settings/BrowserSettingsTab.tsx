import { useCallback, useEffect, useState } from 'react'
import { useT } from '../../i18n'
import type { BrowserBridgeStateDTO } from '../../types/api'
import { ComputerUseSettingsCard } from './ComputerUseSettingsCard'

type BrowserSetupStatus =
  | 'loading'
  | 'disconnected'
  | 'ready'
  | 'bridge'
  | 'paired'
  | 'attached'
  | 'connected'
  | 'repair'
type BrowserSetupCopy = ReturnType<typeof useT>['settings']['browserSetup']

function browserSetupStatus(state: BrowserBridgeStateDTO | null, failed: boolean): BrowserSetupStatus {
  if (state == null && !failed) return 'loading'
  if (failed || state?.ui === 'error' || Boolean(state?.lastError)) return 'repair'
  if (!state?.host.installed) return 'disconnected'
  if (state.host.needsRepair) return 'repair'
  if (!state.connected) return 'ready'
  if (!state.authenticated) return 'bridge'
  if (!state.exactTabAttached) return 'paired'
  if (!state.freshObservation) return 'attached'
  return 'connected'
}

function statusCopy(status: BrowserSetupStatus, t: BrowserSetupCopy): { label: string; hint: string } {
  switch (status) {
    case 'loading': return { label: t.loading, hint: t.connectHint }
    case 'disconnected': return { label: t.disconnected, hint: t.connectHint }
    case 'ready': return { label: t.ready, hint: t.readyHint }
    case 'bridge': return { label: t.bridge, hint: t.bridgeHint }
    case 'paired': return { label: t.paired, hint: t.pairedHint }
    case 'attached': return { label: t.attached, hint: t.attachedHint }
    case 'connected': return { label: t.connected, hint: t.connectedHint }
    case 'repair': return { label: t.repair, hint: t.repairHint }
  }
}

function primaryActionLabel(status: BrowserSetupStatus, busy: boolean, t: BrowserSetupCopy): string {
  if (busy) return t.working
  if (status === 'disconnected' || status === 'ready' || status === 'bridge') return t.connect
  if (status === 'repair') return t.recover
  return t.check
}

function BrowserConnectionDetails({ state, t }: { state: BrowserBridgeStateDTO | null; t: BrowserSetupCopy }) {
  const hostReady = Boolean(state?.host.installed && !state.host.needsRepair)
  const hostLabel = hostReady ? t.componentReady : state?.host.needsRepair ? t.componentRepair : t.componentMissing

  return (
    <details className="gg-browser-settings-diagnostics">
      <summary>{t.diagnostics}</summary>
      <dl>
        <div><dt>{t.localComponent}</dt><dd>{hostLabel}</dd></div>
        <div><dt>{t.bridgeConnection}</dt><dd>{state?.connected ? t.stageReady : t.stageWaiting}</dd></div>
        <div><dt>{t.pairing}</dt><dd>{state?.authenticated ? t.stageReady : t.stageWaiting}</dd></div>
        <div><dt>{t.exactTab}</dt><dd>{state?.exactTabAttached ? t.stageReady : t.stageWaiting}</dd></div>
        <div><dt>{t.freshObserve}</dt><dd>{state?.freshObservation ? t.stageReady : t.stageWaiting}</dd></div>
      </dl>
    </details>
  )
}

export function BrowserSettingsTab() {
  const t = useT().settings.browserSetup
  const [state, setState] = useState<BrowserBridgeStateDTO | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async (announce = false) => {
    try {
      const next = await window.api.browserBridge.getState()
      setState(next)
      setFailed(false)
      if (announce) setNotice(t.checkDone)
    } catch {
      setFailed(true)
      setNotice(null)
    }
  }, [t.checkDone])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 2500)
    return () => window.clearInterval(timer)
  }, [refresh])

  const status = browserSetupStatus(state, failed)
  const copy = statusCopy(status, t)
  const buttonLabel = primaryActionLabel(status, busy, t)

  async function connect() {
    setBusy(true)
    setFailed(false)
    setNotice(null)
    try {
      const result = await window.api.browserBridge.connect()
      setState(result.state)
      if (!result.ok) {
        setFailed(true)
        return
      }
      setNotice(result.needsExtensionAction ? t.installDone : t.checkDone)
      await refresh()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  async function runPrimaryAction() {
    if (status === 'paired' || status === 'attached' || status === 'connected') {
      setBusy(true)
      setNotice(null)
      try {
        await refresh(true)
      } finally {
        setBusy(false)
      }
      return
    }
    await connect()
  }

  return (
    <div className="gg-browser-settings-page" data-testid="browser-settings-page">
      <section className={`gg-browser-settings-card is-${status}`} aria-live="polite">
        <div className="gg-browser-settings-main">
          <div className="gg-browser-settings-icon" aria-hidden>
            <svg viewBox="0 0 32 32" fill="none">
              <rect x="3.5" y="5" width="25" height="21" rx="5" />
              <path d="M3.5 10.5h25M8.3 7.8h.01M12 7.8h.01" />
              <path d="M12 18h8M16 14v8" />
            </svg>
          </div>
          <div className="gg-browser-settings-copy">
            <div className="gg-browser-settings-eyebrow">{t.eyebrow}</div>
            <h3>{t.title}</h3>
            <p>{t.description}</p>
          </div>
        </div>

        <div className="gg-browser-settings-state">
          <span className={`gg-browser-settings-dot is-${status}`} aria-hidden />
          <div>
            <strong>{copy.label}</strong>
            <p>{copy.hint}</p>
          </div>
        </div>

        <button
          type="button"
          className="gg-btn gg-btn-primary gg-browser-settings-primary"
          onClick={() => void runPrimaryAction()}
          disabled={busy || status === 'loading'}
        >
          {buttonLabel}
        </button>

        {notice && <div className="gg-browser-settings-notice is-ok">{notice}</div>}
        {(failed || status === 'repair') && (
          <div className="gg-browser-settings-notice is-error">{t.failed}</div>
        )}

        <BrowserConnectionDetails state={state} t={t} />
      </section>
      <ComputerUseSettingsCard />
    </div>
  )
}
