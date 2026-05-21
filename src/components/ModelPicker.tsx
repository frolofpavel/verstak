import { useEffect, useRef, useState } from 'react'
import { useProvider, type ProviderId } from '../hooks/useProvider'
import { useProject } from '../store/projectStore'

interface ProviderOption {
  id: ProviderId
  label: string
  description: string
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  { id: 'gemini-api', label: 'Gemini',       description: 'API · с tools' },
  { id: 'gemini-cli', label: 'Gemini Ultra', description: 'CLI · подписка' },
  { id: 'claude',     label: 'Claude',       description: 'API · с tools' },
  { id: 'claude-cli', label: 'Claude Code',  description: 'CLI · Pro/Max подписка' },
  { id: 'grok',       label: 'Grok',         description: 'API · с tools' },
  { id: 'grok-cli',   label: 'Grok Build',   description: 'CLI · SuperGrok подписка' },
  { id: 'openai',     label: 'ChatGPT',      description: 'API · с tools' },
  { id: 'codex-cli',  label: 'Codex',        description: 'CLI · Plus подписка' }
]

interface Props {
  onOpenSettings: () => void
}

export function ModelPicker({ onOpenSettings }: Props) {
  const provider = useProvider()
  const activeChatId = useProject(s => s.activeChatId)
  const refreshChatSessions = useProject(s => s.refreshChatSessions)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Persist provider/model on the current chat session so it sticks per-chat
  async function persistOnSession(providerId: ProviderId, model: string | null) {
    if (!activeChatId) return
    try {
      // null model => 'use this provider's default'. Avoids writing empty
      // strings that mask stored defaults on next switchChatSession.
      await window.api.chatSessions.setModel(activeChatId, providerId, model && model.length > 0 ? model : null)
      await refreshChatSessions()
    } catch { /* don't block UX if persistence fails */ }
  }

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
                onClick={async () => {
                  // STALE CLOSURE FIX: provider.model captured BEFORE
                  // setProviderId completes is the OLD provider's model
                  // (e.g. 'gemini-3.5-flash' when switching to claude-cli).
                  // Read the NEW provider's stored model directly.
                  await provider.setProviderId(p.id)
                  const storedNewModel = await window.api.settings.getKey(`model_${p.id}`)
                  await persistOnSession(p.id, storedNewModel)
                  setOpen(false)
                }}
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
                  onClick={() => void provider.setModel(m).then(async () => {
                    await persistOnSession(provider.id, m)
                    setOpen(false)
                  })}
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
