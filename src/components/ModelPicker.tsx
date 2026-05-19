import { useEffect, useRef, useState } from 'react'
import { useProvider, type ProviderId } from '../hooks/useProvider'

interface ProviderOption {
  id: ProviderId
  label: string
  description: string
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  { id: 'gemini-api', label: 'Gemini',       description: 'API · с tools' },
  { id: 'gemini-cli', label: 'Gemini Ultra', description: 'CLI · подписка' },
  { id: 'claude',     label: 'Claude',       description: 'API · chat-only' },
  { id: 'grok',       label: 'Grok',         description: 'API · chat-only' },
  { id: 'openai',     label: 'ChatGPT',      description: 'API · chat-only' }
]

interface Props {
  onOpenSettings: () => void
}

export function ModelPicker({ onOpenSettings }: Props) {
  const provider = useProvider()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className="gg-mp-wrap" ref={wrapRef}>
      <button
        type="button"
        className="gg-model-pill"
        onClick={() => setOpen(v => !v)}
        title="Сменить модель / провайдер"
      >
        <span className={`gg-provider-dot ${provider.id === 'gemini-cli' ? 'cli' : ''}`} />
        <span className="gg-model-pill-name">{provider.label}</span>
        <span className="gg-model-pill-sep">·</span>
        <span className="gg-model-pill-transport">{shortModel(provider.model)}</span>
      </button>

      {open && (
        <div className="gg-mp-popover">
          <div className="gg-mp-section">
            <div className="gg-mp-section-title">Провайдер</div>
            {PROVIDER_OPTIONS.map(p => (
              <button
                key={p.id}
                type="button"
                className={`gg-mp-row ${provider.id === p.id ? 'is-active' : ''}`}
                onClick={() => void provider.setProviderId(p.id).then(() => setOpen(false))}
              >
                <span className="gg-mp-row-label">{p.label}</span>
                <span className="gg-mp-row-meta">{p.description}</span>
              </button>
            ))}
          </div>

          {provider.models.length > 1 && (
            <div className="gg-mp-section">
              <div className="gg-mp-section-title">Модель</div>
              {provider.models.map(m => (
                <button
                  key={m}
                  type="button"
                  className={`gg-mp-row ${provider.model === m ? 'is-active' : ''}`}
                  onClick={() => void provider.setModel(m).then(() => setOpen(false))}
                >
                  <span className="gg-mp-row-label">{m}</span>
                  {provider.model === m && <span className="gg-mp-row-meta">✓</span>}
                </button>
              ))}
            </div>
          )}

          <div className="gg-mp-section">
            <button
              type="button"
              className="gg-mp-row"
              onClick={() => { setOpen(false); onOpenSettings() }}
            >
              <span className="gg-mp-row-label">⚙ Настройки и ключи…</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function shortModel(m: string): string {
  if (m === 'auto') return 'auto'
  // Strip date suffix from claude-...-20251101 and gpt-5/4o families
  const dateMatch = m.match(/(.*)-\d{8}$/)
  if (dateMatch) return dateMatch[1]
  return m
}
