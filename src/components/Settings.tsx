import { useEffect, useState } from 'react'
import type { ProviderId } from '../hooks/useProvider'

interface ProviderConfig {
  id: ProviderId
  name: string
  transport: 'API' | 'CLI'
  description: string
  models: string[]
  defaultModel: string
  secretKey: string | null
  keyHint: string
  keyLink?: { url: string; label: string }
  supportsTools: boolean
}

const PROVIDERS: ProviderConfig[] = [
  {
    id: 'gemini-api',
    name: 'Gemini',
    transport: 'API',
    description: 'Google. Полный агентский режим с tools.',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    defaultModel: 'gemini-2.5-pro',
    secretKey: 'gemini_api_key',
    keyHint: 'AIzaSy…',
    keyLink: { url: 'https://aistudio.google.com', label: 'AI Studio' },
    supportsTools: true
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    transport: 'CLI',
    description: 'Твоя Gemini Ultra подписка через gemini-cli. Без API ключа.',
    models: ['auto'],
    defaultModel: 'auto',
    secretKey: null,
    keyHint: '',
    supportsTools: false
  },
  {
    id: 'claude',
    name: 'Claude',
    transport: 'API',
    description: 'Anthropic. Chat-only пока.',
    models: ['claude-opus-4-5-20251101', 'claude-sonnet-4-5-20251101', 'claude-haiku-4-5-20251101'],
    defaultModel: 'claude-sonnet-4-5-20251101',
    secretKey: 'anthropic_api_key',
    keyHint: 'sk-ant-…',
    keyLink: { url: 'https://console.anthropic.com', label: 'Anthropic Console' },
    supportsTools: false
  },
  {
    id: 'grok',
    name: 'Grok',
    transport: 'API',
    description: 'xAI. Chat-only пока.',
    models: ['grok-4', 'grok-4-fast', 'grok-3'],
    defaultModel: 'grok-4',
    secretKey: 'xai_api_key',
    keyHint: 'xai-…',
    keyLink: { url: 'https://console.x.ai', label: 'xAI Console' },
    supportsTools: false
  },
  {
    id: 'openai',
    name: 'ChatGPT / Codex',
    transport: 'API',
    description: 'OpenAI. Chat-only пока.',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini'],
    defaultModel: 'gpt-5',
    secretKey: 'openai_api_key',
    keyHint: 'sk-…',
    keyLink: { url: 'https://platform.openai.com/api-keys', label: 'OpenAI Platform' },
    supportsTools: false
  }
]

export function Settings({ onClose }: { onClose: () => void }) {
  const [activeProvider, setActiveProvider] = useState<ProviderId>('gemini-api')
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [models, setModels] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void (async () => {
      const provider = await window.api.settings.getKey('provider')
      const valid = ['gemini-api', 'gemini-cli', 'claude', 'grok', 'openai'].includes(provider ?? '') ? (provider as ProviderId) : 'gemini-api'
      setActiveProvider(valid)
      const keyVals: Record<string, string> = {}
      const modelVals: Record<string, string> = {}
      for (const p of PROVIDERS) {
        if (p.secretKey) {
          const v = await window.api.settings.getKey(p.secretKey)
          if (v) keyVals[p.secretKey] = v
        }
        const m = await window.api.settings.getKey(`model_${p.id}`)
        modelVals[p.id] = m ?? p.defaultModel
      }
      setKeys(keyVals)
      setModels(modelVals)
    })()
  }, [])

  async function save() {
    await window.api.settings.setKey('provider', activeProvider)
    for (const p of PROVIDERS) {
      if (p.secretKey && keys[p.secretKey] !== undefined) {
        await window.api.settings.setKey(p.secretKey, keys[p.secretKey])
      }
      if (models[p.id]) {
        await window.api.settings.setKey(`model_${p.id}`, models[p.id])
      }
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const activeCfg = PROVIDERS.find(p => p.id === activeProvider)!

  return (
    <div className="gg-modal-backdrop" onClick={onClose}>
      <div className="gg-modal gg-modal-large" onClick={e => e.stopPropagation()}>
        <div className="gg-modal-header">
          <div className="gg-modal-title">Провайдеры AI</div>
          <button className="gg-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="gg-modal-body" style={{ display: 'flex', gap: 18, padding: 0, minHeight: 420 }}>
          <div className="gg-provider-list">
            {PROVIDERS.map(p => (
              <button
                key={p.id}
                type="button"
                className={`gg-provider-card-row ${activeProvider === p.id ? 'active' : ''}`}
                onClick={() => setActiveProvider(p.id)}
              >
                <div className="gg-provider-card-name">
                  {p.name}
                  {p.supportsTools && <span className="gg-provider-tag is-tools">tools</span>}
                  {p.transport === 'CLI' && <span className="gg-provider-tag is-cli">CLI</span>}
                </div>
                <div className="gg-provider-card-desc">{p.description}</div>
              </button>
            ))}
          </div>

          <div className="gg-provider-detail">
            <div className="gg-label">Активный провайдер</div>
            <div className="gg-provider-detail-title">{activeCfg.name}</div>

            {activeCfg.secretKey && (
              <>
                <div className="gg-label" style={{ marginTop: 18 }}>API ключ</div>
                <input
                  className="gg-input"
                  type="password"
                  value={keys[activeCfg.secretKey] ?? ''}
                  onChange={e => setKeys(k => ({ ...k, [activeCfg.secretKey!]: e.target.value }))}
                  placeholder={activeCfg.keyHint}
                  autoFocus
                />
                {activeCfg.keyLink && (
                  <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 6 }}>
                    Получить ключ: <a href={activeCfg.keyLink.url} target="_blank" rel="noreferrer">{activeCfg.keyLink.label}</a>. Хранится зашифрованно через safeStorage.
                  </div>
                )}
              </>
            )}

            {activeCfg.id === 'gemini-cli' && (
              <div className="gg-notice" style={{ marginTop: 12 }}>
                Нужно установлен <code>gemini-cli</code> и пройден OAuth твоим Google аккаунтом с Ultra подпиской.
                Открой обычный терминал, набери <code>gemini</code>, согласись с авторизацией. После этого работает в нашем приложении.
              </div>
            )}

            {activeCfg.models.length > 1 && (
              <>
                <div className="gg-label" style={{ marginTop: 18 }}>Модель по умолчанию</div>
                <select
                  className="gg-input"
                  value={models[activeCfg.id] ?? activeCfg.defaultModel}
                  onChange={e => setModels(m => ({ ...m, [activeCfg.id]: e.target.value }))}
                >
                  {activeCfg.models.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
                <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 6 }}>
                  Можно быстро переключать в композитор-чате — клик по pill справа от поля ввода.
                </div>
              </>
            )}

            {!activeCfg.supportsTools && activeCfg.id !== 'gemini-cli' && (
              <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 18, padding: 10, background: 'var(--bg-input)', borderRadius: 'var(--radius-md)' }}>
                Этот провайдер сейчас работает в режиме chat-only. AI tools (чтение/правка файлов, выполнение команд) пока поддерживаются только у Gemini API. Добавим в следующих итерациях.
              </div>
            )}
          </div>
        </div>

        <div className="gg-modal-footer">
          <button className="gg-btn gg-btn-ghost" onClick={onClose}>Закрыть</button>
          <button className="gg-btn gg-btn-primary" onClick={save}>
            {saved ? '✓ Сохранено' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  )
}
