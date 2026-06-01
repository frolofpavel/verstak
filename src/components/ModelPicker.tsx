import { useEffect, useRef, useState } from 'react'
import { useProvider, type ProviderId } from '../hooks/useProvider'
import { useProject } from '../store/projectStore'

interface ProviderOption {
  id: ProviderId
  label: string
  description: string
}

// CLI-провайдеры помечены (beta) с явным tooltip'ом.
// Не скрываем — пользователь может ими пользоваться — но даём сигнал что они
// требуют локальной установки CLI и иногда падают (особенно grok-cli на Windows).
const CLI_BETA_HINT = 'CLI-провайдеры требуют локальной установки. Если агент не отвечает — переключитесь на API-версию.'

const PROVIDER_OPTIONS: ProviderOption[] = [
  { id: 'gemini-api', label: 'Gemini',             description: 'API · с tools' },
  { id: 'gemini-cli', label: 'Gemini Ultra (beta)', description: 'CLI · подписка' },
  { id: 'claude',     label: 'Claude',             description: 'API · с tools' },
  { id: 'claude-cli', label: 'Claude Code (beta)', description: 'CLI · Pro/Max подписка' },
  { id: 'grok',       label: 'Grok',               description: 'API · с tools' },
  { id: 'grok-cli',   label: 'Grok Build (beta)',  description: 'CLI · SuperGrok подписка' },
  { id: 'openai',     label: 'ChatGPT',            description: 'API · с tools' },
  { id: 'codex-cli',  label: 'Codex (beta)',       description: 'CLI · Plus подписка' },
  { id: 'yandex-gpt', label: 'YandexGPT 🇷🇺',     description: 'API · 152-ФЗ' },
  { id: 'gigachat',   label: 'GigaChat 🇷🇺',       description: 'API · 152-ФЗ' },
]

// Секретный ключ для каждого API-провайдера. CLI-провайдеры = null (не нужен).
// null-ключ = провайдер считается «всегда настроен» (ollama, CLI).
const API_SECRET_KEY: Partial<Record<ProviderId, string>> = {
  'gemini-api':   'gemini_api_key',
  'claude':       'anthropic_api_key',
  'grok':         'xai_api_key',
  'openai':       'openai_api_key',
  'yandex-gpt':   'yandex_api_key',
  'gigachat':     'gigachat_client_id',
}

interface Props {
  onOpenSettings: () => void
}

export function ModelPicker({ onOpenSettings }: Props) {
  const provider = useProvider()
  const activeChatId = useProject(s => s.activeChatId)
  const refreshChatSessions = useProject(s => s.refreshChatSessions)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  // enabled_models — управляется в Settings → Модели через toggle. Хранится
  // как JSON-массив ключей `providerId::model`. null = «фильтрация выключена,
  // показывать всё» (дефолт при первом запуске). Загружаем при открытии
  // popover'а — settings меняются редко, попадаем туда не часто.
  const [enabledModels, setEnabledModels] = useState<Set<string> | null>(null)
  // configuredIds: провайдеры у которых задан API-ключ (или CLI — они не требуют).
  // Загружается при открытии пикера параллельно с enabled_models.
  const [configuredIds, setConfiguredIds] = useState<Set<ProviderId>>(new Set())

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        // Загружаем enabled_models и ключи всех API-провайдеров параллельно
        const secretEntries = Object.entries(API_SECRET_KEY) as [ProviderId, string][]
        const [rawEnabled, ...keyValues] = await Promise.all([
          window.api.settings.getKey('enabled_models'),
          ...secretEntries.map(([, k]) => window.api.settings.getKey(k))
        ])
        if (cancelled) return

        // enabled_models
        if (!rawEnabled) {
          setEnabledModels(null)
        } else {
          const arr = JSON.parse(rawEnabled) as string[]
          setEnabledModels(Array.isArray(arr) && arr.length > 0 ? new Set(arr) : null)
        }

        // configuredIds: CLI-провайдеры всегда считаем настроенными
        const configured = new Set<ProviderId>(
          PROVIDER_OPTIONS.filter(p => p.id.endsWith('-cli') || !(p.id in API_SECRET_KEY)).map(p => p.id)
        )
        secretEntries.forEach(([pid], i) => {
          if (keyValues[i]) configured.add(pid)
        })
        setConfiguredIds(configured)
      } catch { if (!cancelled) setEnabledModels(null) }
    })()
    return () => { cancelled = true }
  }, [open])

  // Хелпер: модель «видна» если фильтр выключен, либо она в enabled, либо это
  // ТЕКУЩАЯ активная модель чата (даже если её выключили — не прячем, иначе
  // пользователь увидит пустой список и не поймёт что активно). Провайдеров
  // не фильтруем — у каждого есть «auto»-модель в provider.models, поэтому
  // фильтр уровня модели сам по себе достаточен.
  function isModelVisible(providerId: ProviderId, model: string): boolean {
    if (enabledModels === null) return true
    if (enabledModels.has(`${providerId}::${model}`)) return true
    if (providerId === provider.id && provider.model === model) return true
    return false
  }

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
            {PROVIDER_OPTIONS.map(p => {
              const isCli = p.id.endsWith('-cli')
              const isConfigured = configuredIds.has(p.id)
              const isActive = provider.id === p.id
              let title: string | undefined
              if (!isConfigured) title = 'API ключ не задан — нажми чтобы открыть Настройки'
              else if (isCli) title = CLI_BETA_HINT
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`gg-mp-row ${isActive ? 'is-active' : ''} ${!isConfigured ? 'is-unconfigured' : ''}`}
                  title={title}
                  onClick={async () => {
                    if (!isConfigured) {
                      // Открыть Settings на провайдерах вместо переключения
                      setOpen(false)
                      onOpenSettings()
                      return
                    }
                    await provider.setProviderId(p.id)
                    const storedNewModel = await window.api.settings.getKey(`model_${p.id}`)
                    await persistOnSession(p.id, storedNewModel)
                    setOpen(false)
                  }}
                >
                  <span className="gg-mp-row-label">
                    {!isConfigured && <span className="gg-mp-lock">🔒</span>}
                    {p.label}
                  </span>
                  <span className="gg-mp-row-meta">{p.description}</span>
                </button>
              )
            })}
          </div>

          {provider.models.length > 1 && (() => {
            const visibleModels = provider.models.filter(m => isModelVisible(provider.id, m))
            const hiddenCount = provider.models.length - visibleModels.length
            return (
              <div className="gg-mp-section">
                <div className="gg-mp-section-title">
                  Модель
                  {hiddenCount > 0 && (
                    <span className="gg-mp-section-hint" title="Скрыты по toggle в Настройки → Модели">
                      {' '}· скрыто {hiddenCount}
                    </span>
                  )}
                </div>
                {visibleModels.length === 0 && (
                  <div className="gg-mp-row gg-mp-row-empty">
                    <span className="gg-mp-row-label">Все модели выключены</span>
                    <span className="gg-mp-row-meta">включи в Настройки → Модели</span>
                  </div>
                )}
                {visibleModels.map(m => {
                  const isActiveModel = provider.model === m
                  const isHidden = enabledModels !== null && !enabledModels.has(`${provider.id}::${m}`)
                  return (
                    <button
                      key={m}
                      type="button"
                      className={`gg-mp-row ${isActiveModel ? 'is-active' : ''}`}
                      onClick={() => void provider.setModel(m).then(async () => {
                        await persistOnSession(provider.id, m)
                        setOpen(false)
                      })}
                      title={isHidden ? 'Эта модель отключена в Настройки → Модели, но активна в чате — отображается чтобы не потерять' : undefined}
                    >
                      <span className="gg-mp-row-label">
                        {m}
                        {isHidden && <span className="gg-mp-row-hidden-mark"> · скрыта</span>}
                      </span>
                      {isActiveModel && <span className="gg-mp-row-meta">✓</span>}
                    </button>
                  )
                })}
              </div>
            )
          })()}

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
