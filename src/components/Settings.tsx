import { useEffect, useState } from 'react'

type ProviderId = 'gemini-api' | 'gemini-cli'

export function Settings({ onClose }: { onClose: () => void }) {
  const [key, setKey] = useState('')
  const [provider, setProvider] = useState<ProviderId>('gemini-api')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void window.api.settings.getKey('gemini_api_key').then(v => setKey(v ?? ''))
    void window.api.settings.getKey('provider').then(v => {
      if (v === 'gemini-cli') setProvider('gemini-cli')
    })
  }, [])

  async function save() {
    await window.api.settings.setKey('gemini_api_key', key)
    await window.api.settings.setKey('provider', provider)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10 }}>
      <div style={{ background: '#1a1a2e', padding: 24, borderRadius: 8, width: 540, color: '#e0e0e0' }}>
        <h3 style={{ marginTop: 0 }}>Настройки</h3>

        <label style={{ display: 'block', marginBottom: 8, fontSize: 13, color: '#aaa' }}>Как подключиться к Gemini</label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button
            onClick={() => setProvider('gemini-api')}
            style={{
              flex: 1, padding: 10, cursor: 'pointer',
              background: provider === 'gemini-api' ? '#0f3460' : '#0d0d0d',
              color: provider === 'gemini-api' ? '#4fc3f7' : '#888',
              border: provider === 'gemini-api' ? '1px solid #4fc3f7' : '1px solid #333',
              borderRadius: 6, textAlign: 'left'
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>🔑 API ключ</div>
            <div style={{ fontSize: 11, opacity: 0.85 }}>Через @google/genai. С diff-подтверждением правок.</div>
          </button>
          <button
            onClick={() => setProvider('gemini-cli')}
            style={{
              flex: 1, padding: 10, cursor: 'pointer',
              background: provider === 'gemini-cli' ? '#1a3a1a' : '#0d0d0d',
              color: provider === 'gemini-cli' ? '#4ec9b0' : '#888',
              border: provider === 'gemini-cli' ? '1px solid #4ec9b0' : '1px solid #333',
              borderRadius: 6, textAlign: 'left'
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>📦 CLI (подписка)</div>
            <div style={{ fontSize: 11, opacity: 0.85 }}>Через gemini-cli + твою Ultra подписку. Без API ключа.</div>
          </button>
        </div>

        {provider === 'gemini-api' && (
          <>
            <label style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>Gemini API ключ</label>
            <input
              type="password"
              value={key}
              onChange={e => setKey(e.target.value)}
              placeholder="AIzaSy..."
              style={{ width: '100%', padding: 8, background: '#0d0d0d', color: '#fff', border: '1px solid #333', borderRadius: 4, marginBottom: 12, boxSizing: 'border-box' }}
            />
            <div style={{ fontSize: 11, color: '#888', marginBottom: 16 }}>
              Получи бесплатно в Google AI Studio: aistudio.google.com → Get API key
            </div>
          </>
        )}

        {provider === 'gemini-cli' && (
          <div style={{ background: '#0d1a0d', padding: 12, borderRadius: 6, marginBottom: 16, fontSize: 12, color: '#aaa', lineHeight: 1.6 }}>
            <div style={{ color: '#4ec9b0', marginBottom: 6 }}>Что нужно для CLI режима:</div>
            <div>1. Установлен <code style={{ color: '#fff' }}>gemini-cli</code> (у тебя уже есть, проверено)</div>
            <div>2. Залогинен через <code style={{ color: '#fff' }}>gemini</code> один раз — открой терминал, набери <code style={{ color: '#fff' }}>gemini</code>, пройди Google OAuth твоим аккаунтом с Ultra</div>
            <div style={{ marginTop: 8, color: '#888', fontSize: 11 }}>В этом режиме AI сам управляет файлами проекта. Diff-подтверждения нет.</div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Закрыть</button>
          <button onClick={save}>{saved ? 'Сохранено ✓' : 'Сохранить'}</button>
        </div>
      </div>
    </div>
  )
}
