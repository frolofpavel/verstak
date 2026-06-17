import { useT } from '../i18n'
import type { DetectedCli, DetectedLocalServer } from '../types/api'

const SUPPORTED_CLI = ['claude-cli', 'codex-cli', 'gemini-cli', 'grok-cli'] as const

type Props = {
  clis: DetectedCli[]
  localServers: DetectedLocalServer[]
  scanLoading: boolean
  busy?: boolean
  connectingId?: string | null
  onConnectCli?: (cli: DetectedCli) => void
  onConnectLocal?: (server: DetectedLocalServer) => void
  className?: string
}

export function DetectedProvidersList({
  clis,
  localServers,
  scanLoading,
  busy = false,
  connectingId = null,
  onConnectCli,
  onConnectLocal,
  className = 'gg-auth-detected',
}: Props) {
  const t = useT()
  const show = scanLoading || clis.length > 0 || localServers.length > 0
  if (!show) return null

  return (
    <div className={className}>
      <div className="gg-auth-detected-title">
        {scanLoading ? t.auth.scanning : t.auth.foundOnPc}
      </div>
      {clis.map(c => (
        <div key={c.id} className="gg-auth-detected-item">
          <span className={`gg-auth-detected-dot${c.status === 'found' ? ' is-yellow' : ''}`} />
          <span className="gg-auth-detected-main">
            <span>{c.name}</span>
            <span className="gg-auth-detected-version">{c.version}</span>
          </span>
          {onConnectCli && SUPPORTED_CLI.includes(c.id as typeof SUPPORTED_CLI[number]) && (
            <button
              type="button"
              className="gg-auth-connect"
              onClick={() => onConnectCli(c)}
              disabled={busy}
            >
              {connectingId === c.id ? t.auth.connecting : t.auth.connect}
            </button>
          )}
        </div>
      ))}
      {localServers.map(server => (
        <div key={server.id} className="gg-auth-detected-item">
          <span className="gg-auth-detected-dot is-local" />
          <span className="gg-auth-detected-main">
            <span>
              {server.name}
              <span className="gg-auth-local-badge">{t.auth.localBadge}</span>
            </span>
            <span className="gg-auth-detected-version">
              {server.models.length} · {server.models.slice(0, 2).join(', ')}
            </span>
          </span>
          {onConnectLocal && (
            <button
              type="button"
              className="gg-auth-connect"
              onClick={() => onConnectLocal(server)}
              disabled={busy || server.models.length === 0}
            >
              {connectingId === server.id ? t.auth.connecting : t.auth.connect}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}