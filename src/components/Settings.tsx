import { useEffect, useState } from 'react'
import type { ProviderId } from '../hooks/useProvider'
import { useTheme } from '../hooks/useTheme'

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
    models: ['auto', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-pro-preview', 'gemini-3-flash-preview'],
    defaultModel: 'auto',
    secretKey: null,
    keyHint: '',
    supportsTools: false
  },
  {
    id: 'claude',
    name: 'Claude',
    transport: 'API',
    description: 'Anthropic. Полный агентский режим с tools.',
    models: ['claude-opus-4-5-20251101', 'claude-sonnet-4-5-20251101', 'claude-haiku-4-5-20251101'],
    defaultModel: 'claude-sonnet-4-5-20251101',
    secretKey: 'anthropic_api_key',
    keyHint: 'sk-ant-…',
    keyLink: { url: 'https://console.anthropic.com', label: 'Anthropic Console' },
    supportsTools: true
  },
  {
    id: 'claude-cli',
    name: 'Claude Code',
    transport: 'CLI',
    description: 'Твоя Claude Pro/Max подписка через claude CLI.',
    models: ['auto', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-haiku-4-5', 'claude-sonnet-4-5'],
    defaultModel: 'auto',
    secretKey: null,
    keyHint: '',
    supportsTools: false
  },
  {
    id: 'grok',
    name: 'Grok',
    transport: 'API',
    description: 'xAI. Полный агентский режим с tools.',
    models: ['grok-4', 'grok-4-fast', 'grok-3'],
    defaultModel: 'grok-4',
    secretKey: 'xai_api_key',
    keyHint: 'xai-…',
    keyLink: { url: 'https://console.x.ai', label: 'xAI Console' },
    supportsTools: true
  },
  {
    id: 'grok-cli',
    name: 'Grok Build',
    transport: 'CLI',
    description: 'Твоя x.com/SuperGrok подписка через grok CLI.',
    models: ['auto', 'grok-4', 'grok-4-fast', 'grok-code-fast-1', 'grok-3'],
    defaultModel: 'auto',
    secretKey: null,
    keyHint: '',
    supportsTools: false
  },
  {
    id: 'openai',
    name: 'ChatGPT',
    transport: 'API',
    description: 'OpenAI. Полный агентский режим с tools.',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini'],
    defaultModel: 'gpt-5',
    secretKey: 'openai_api_key',
    keyHint: 'sk-…',
    keyLink: { url: 'https://platform.openai.com/api-keys', label: 'OpenAI Platform' },
    supportsTools: true
  },
  {
    id: 'codex-cli',
    name: 'Codex CLI',
    transport: 'CLI',
    description: 'Твоя ChatGPT Plus/Pro подписка через codex CLI.',
    models: ['auto', 'gpt-5-codex', 'gpt-5', 'gpt-5-mini', 'o3', 'o3-mini', 'gpt-4o'],
    defaultModel: 'auto',
    secretKey: null,
    keyHint: '',
    supportsTools: false
  }
]

export function Settings({ onClose }: { onClose: () => void }) {
  const [activeProvider, setActiveProvider] = useState<ProviderId>('gemini-api')
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [models, setModels] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [onec, setOneC] = useState({ url: '', user: '', pass: '' })
  const [httpEndpoints, setHttpEndpoints] = useState<Array<{ name: string; base: string; auth: string; paths: string }>>(
    [{ name: '', base: '', auth: '', paths: '' }, { name: '', base: '', auth: '', paths: '' }, { name: '', base: '', auth: '', paths: '' }, { name: '', base: '', auth: '', paths: '' }]
  )
  const { theme, setTheme } = useTheme()

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
      // 1С connector creds
      const url = await window.api.settings.getKey('onec_base_url')
      const user = await window.api.settings.getKey('onec_username')
      const pass = await window.api.settings.getKey('onec_password')
      setOneC({ url: url ?? '', user: user ?? '', pass: pass ?? '' })
      // HTTP endpoints
      const eps: typeof httpEndpoints = []
      for (let i = 1; i <= 4; i++) {
        eps.push({
          name:  (await window.api.settings.getKey(`http_endpoint_${i}_name`))  ?? '',
          base:  (await window.api.settings.getKey(`http_endpoint_${i}_base`))  ?? '',
          auth:  (await window.api.settings.getKey(`http_endpoint_${i}_auth`))  ?? '',
          paths: (await window.api.settings.getKey(`http_endpoint_${i}_paths`)) ?? ''
        })
      }
      setHttpEndpoints(eps)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    await window.api.settings.setKey('onec_base_url', onec.url)
    await window.api.settings.setKey('onec_username', onec.user)
    await window.api.settings.setKey('onec_password', onec.pass)
    for (let i = 0; i < httpEndpoints.length; i++) {
      const e = httpEndpoints[i]
      await window.api.settings.setKey(`http_endpoint_${i + 1}_name`,  e.name)
      await window.api.settings.setKey(`http_endpoint_${i + 1}_base`,  e.base)
      await window.api.settings.setKey(`http_endpoint_${i + 1}_auth`,  e.auth)
      await window.api.settings.setKey(`http_endpoint_${i + 1}_paths`, e.paths)
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

        <div className="gg-theme-row">
          <div className="gg-label" style={{ margin: 0 }}>Тема оформления</div>
          <div className="gg-theme-toggle" role="group">
            <button
              type="button"
              className={`gg-theme-btn ${theme === 'dark' ? 'is-active' : ''}`}
              onClick={() => void setTheme('dark')}
            >
              <span aria-hidden>🌙</span> Тёмная
            </button>
            <button
              type="button"
              className={`gg-theme-btn ${theme === 'light' ? 'is-active' : ''}`}
              onClick={() => void setTheme('light')}
            >
              <span aria-hidden>☀</span> Светлая
            </button>
          </div>
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
            {activeCfg.id === 'claude-cli' && (
              <div className="gg-notice" style={{ marginTop: 12 }}>
                Нужен установленный <code>claude</code> CLI (Claude Code). Установить:{' '}
                <code>irm https://claude.ai/install.ps1 | iex</code> или <code>curl -fsSL https://claude.ai/install.sh | bash</code>.
                Залогинься через <code>claude</code> в обычном терминале своей Pro/Max подпиской — после этого работает у нас.
              </div>
            )}
            {activeCfg.id === 'codex-cli' && (
              <div className="gg-notice" style={{ marginTop: 12 }}>
                Нужен установленный <code>codex</code> CLI. Установить: <code>npm install -g @openai/codex</code>.
                Залогинься через <code>codex login</code> своей ChatGPT Plus/Pro подпиской — после этого работает у нас.
              </div>
            )}
            {activeCfg.id === 'grok-cli' && (
              <div className="gg-notice" style={{ marginTop: 12 }}>
                Нужен <code>grok</code> CLI (Grok Build) из <code>~/.grok/bin/grok</code> — обычно ставится автоматически через установщик с <a href="https://grok.com/build" target="_blank" rel="noreferrer">grok.com/build</a>.
                Залогинься через <code>grok</code> своей SuperGrok / x.com подпиской — после этого работает у нас.
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

        <div className="gg-settings-extra">
          <div className="gg-settings-section-title">Коннекторы</div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">1С OData base URL</label>
            <input
              className="gg-input"
              value={onec.url}
              onChange={e => setOneC(s => ({ ...s, url: e.target.value }))}
              placeholder="https://1c.example.com/base/odata/standard.odata"
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Логин</label>
            <input
              className="gg-input"
              value={onec.user}
              onChange={e => setOneC(s => ({ ...s, user: e.target.value }))}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="gg-settings-row">
            <label className="gg-settings-label">Пароль</label>
            <input
              className="gg-input"
              type="password"
              value={onec.pass}
              onChange={e => setOneC(s => ({ ...s, pass: e.target.value }))}
              autoComplete="new-password"
            />
          </div>
          <div className="gg-settings-hint">
            Кред хранится зашифрованным в Electron safeStorage. AI может звать
            tool <code>connector_query</code> с id=<code>onec</code>; пароль
            никогда не попадает в промпт.
          </div>

          <div className="gg-settings-section-title" style={{ marginTop: 18 }}>HTTP коннекторы</div>
          {httpEndpoints.map((ep, i) => (
            <div key={i} className="gg-http-endpoint">
              <div className="gg-http-endpoint-head">#{i + 1}</div>
              <div className="gg-settings-row">
                <label className="gg-settings-label">Имя</label>
                <input className="gg-input" value={ep.name} placeholder='напр. "github" или "internal-api"'
                  onChange={e => setHttpEndpoints(arr => arr.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                  spellCheck={false} />
              </div>
              <div className="gg-settings-row">
                <label className="gg-settings-label">Base URL</label>
                <input className="gg-input" value={ep.base} placeholder="https://api.github.com"
                  onChange={e => setHttpEndpoints(arr => arr.map((x, j) => j === i ? { ...x, base: e.target.value } : x))}
                  spellCheck={false} />
              </div>
              <div className="gg-settings-row">
                <label className="gg-settings-label">Authorization</label>
                <input className="gg-input" type="password" value={ep.auth} placeholder='напр. "Bearer ghp_…"'
                  onChange={e => setHttpEndpoints(arr => arr.map((x, j) => j === i ? { ...x, auth: e.target.value } : x))}
                  autoComplete="new-password" />
              </div>
              <div className="gg-settings-row">
                <label className="gg-settings-label">Allow-paths</label>
                <input className="gg-input" value={ep.paths} placeholder="/repos,/user (пусто = всё под base)"
                  onChange={e => setHttpEndpoints(arr => arr.map((x, j) => j === i ? { ...x, paths: e.target.value } : x))}
                  spellCheck={false} />
              </div>
            </div>
          ))}
          <div className="gg-settings-hint">
            AI вызывает <code>connector_query</code> с <code>id="http"</code>,
            <code>endpoint=&lt;имя&gt;</code> и path/method/query/body/headers.
            Auth-заголовок подставляется из настроек, AI его не видит.
            Allow-paths ограничивает к каким путям эндпоинта можно обращаться.
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
