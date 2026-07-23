// BrowserBridgeCard.tsx — карточка «Браузер» (EXT-B1/C1).
// Host status, pairing code, attached tab. Pair/re-pair/detach instructions.

import { useCallback, useEffect, useState } from 'react'
import type { BrowserBridgeStateDTO } from '../types/api'

const UI_LABEL: Record<string, string> = {
  offline: 'Offline',
  connecting: 'Подключение…',
  paired: 'Paired',
  attached: 'Attached',
  error: 'Ошибка',
}

export function BrowserBridgeCard() {
  const [state, setState] = useState<BrowserBridgeStateDTO | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const s = await window.api.browserBridge.getState()
      setState(s)
      if (s.activePairingCode) setPairingCode(s.activePairingCode)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => { void refresh() }, 2500)
    return () => clearInterval(t)
  }, [refresh])

  async function installHost() {
    setBusy(true)
    setMsg(null)
    try {
      const r = await window.api.browserBridge.installHost()
      if (!r.ok) setMsg(r.error || 'install failed')
      else setMsg(r.readback?.installed ? 'Мост установлен (HKCU OK)' : 'Установлено — проверьте registry')
      await refresh()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function issueCode() {
    setBusy(true)
    setMsg(null)
    setCopied(false)
    try {
      const r = await window.api.browserBridge.issuePairingCode()
      if (!r.ok) {
        setMsg(r.error)
        return
      }
      setPairingCode(r.code)
      setMsg(`Код действует до ${new Date(r.expiresAt).toLocaleTimeString()}`)
      await refresh()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function copyCode() {
    if (!pairingCode) return
    try {
      await navigator.clipboard.writeText(pairingCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setMsg('Не удалось скопировать')
    }
  }

  async function copyExtPath() {
    if (!state?.extensionDir) return
    try {
      await navigator.clipboard.writeText(state.extensionDir)
      setMsg('Путь к расширению скопирован')
    } catch {
      setMsg(state.extensionDir)
    }
  }

  const hostOk = state?.host.installed && !state.host.needsRepair
  const ui = state?.ui ?? 'offline'
  const tab = state?.attachedTab

  return (
    <div className="gg-browser-bridge-card" data-testid="browser-bridge-card">
      <div className="gg-browser-bridge-header">
        <strong>Браузер</strong>
        <span className={`gg-browser-bridge-pill gg-browser-bridge-pill-${ui}`}>
          {UI_LABEL[ui] ?? ui}
        </span>
      </div>

      <div className="gg-browser-bridge-row">
        <span className="gg-text-tertiary">Native Host</span>
        <span>
          {state == null ? '…' : hostOk ? 'установлен' : 'требует ремонта'}
        </span>
      </div>
      <div className="gg-browser-bridge-row">
        <span className="gg-text-tertiary">Соединение</span>
        <span>
          {state?.connected ? (state.authenticated ? 'paired' : 'connecting') : 'offline'}
        </span>
      </div>
      {tab && (
        <div className="gg-browser-bridge-row">
          <span className="gg-text-tertiary">Вкладка</span>
          <span className="gg-browser-bridge-tab" title={tab.url}>
            {tab.origin || tab.url}
          </span>
        </div>
      )}
      {state?.browserTaskId && (
        <div className="gg-browser-bridge-row">
          <span className="gg-text-tertiary">Task</span>
          <code style={{ fontSize: 11 }}>{state.browserTaskId}</code>
        </div>
      )}

      {pairingCode && (
        <div className="gg-browser-bridge-code">
          <code>{pairingCode}</code>
          <button type="button" className="gg-btn gg-btn-sm" onClick={() => void copyCode()} disabled={busy}>
            {copied ? 'Скопировано' : 'Копировать'}
          </button>
        </div>
      )}

      <div className="gg-browser-bridge-actions">
        <button type="button" className="gg-btn gg-btn-sm" onClick={() => void installHost()} disabled={busy}>
          {hostOk ? 'Починить мост' : 'Установить мост'}
        </button>
        <button type="button" className="gg-btn gg-btn-sm gg-btn-primary" onClick={() => void issueCode()} disabled={busy}>
          Pair-код
        </button>
        <button type="button" className="gg-btn gg-btn-sm" onClick={() => void refresh()} disabled={busy}>
          Обновить
        </button>
      </div>

      <div className="gg-browser-bridge-hint">
        1) Chrome → chrome://extensions → Load unpacked →
        {' '}
        <button type="button" className="gg-link-btn" onClick={() => void copyExtPath()}>
          browser-extension
        </button>
        <br />
        2) Side panel → вставить pair-код → Pair → Attach вкладку
        <br />
        3) Отключить: Detach в side panel (после restart attach не восстанавливается)
      </div>

      {msg && <div className="gg-browser-bridge-msg">{msg}</div>}
      {state?.lastError && (
        <div className="gg-browser-bridge-msg gg-browser-bridge-msg-err">{state.lastError}</div>
      )}
    </div>
  )
}
