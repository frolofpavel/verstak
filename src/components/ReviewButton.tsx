import { useEffect, useState } from 'react'
import { useProject } from '../store/projectStore'
import { composeReviewPayload } from '../lib/compose-review-payload'

/**
 * Кнопка «🔍 Ревью» в composer-toolbar.
 *
 * Поведение (V1, Explicit Review):
 * - Появляется, когда в активном чате есть хотя бы одно assistant-сообщение
 *   с непустым content.
 * - Клик → берёт default review provider из settings; если он не задан,
 *   просит выбрать (popup → сохраняется в settings).
 * - Self-review защита: если выбранный reviewer == текущий provider чата,
 *   показывает confirm() с предупреждением.
 * - Рядом маленький ▾ — разово сменить провайдера для этого ревью.
 *
 * После клика создаёт review sub-chat через store.startReview().
 */

const PROVIDER_LABELS: Record<string, string> = {
  'gemini-api': 'Gemini (API)',
  'gemini-cli': 'Gemini CLI',
  'claude': 'Claude (API)',
  'claude-cli': 'Claude Code',
  'grok': 'Grok (API)',
  'grok-cli': 'Grok Build',
  'openai': 'OpenAI',
  'codex-cli': 'Codex'
}
const KNOWN_PROVIDERS = Object.keys(PROVIDER_LABELS)

export function ReviewButton() {
  const messages = useProject(s => s.messages)
  const startReview = useProject(s => s.startReview)
  const path = useProject(s => s.path)
  const activeChatId = useProject(s => s.activeChatId)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [defaultReviewer, setDefaultReviewer] = useState<string | null>(null)
  const [currentProvider, setCurrentProvider] = useState<string | null>(null)

  // Подгружаем настройки при монтировании и периодически.
  useEffect(() => {
    let alive = true
    async function load() {
      const dr = await window.api.settings.getKey('default_review_provider')
      const cur = await window.api.settings.getKey('provider')
      if (alive) {
        setDefaultReviewer(dr)
        setCurrentProvider(cur)
      }
    }
    void load()
    const t = window.setInterval(load, 2000)
    return () => { alive = false; window.clearInterval(t) }
  }, [])

  // Скрываем пока в чате нет ответа агента — нечего ревьюить.
  const hasAssistantContent = messages.some(m => m.role === 'assistant' && m.content && m.content.trim().length > 0)
  if (!hasAssistantContent) return null

  async function runReview(providerId: string) {
    // Self-review guard
    if (currentProvider && providerId === currentProvider) {
      const ok = window.confirm(
        `Ревьюер совпадает с текущим провайдером (${PROVIDER_LABELS[providerId] ?? providerId}). ` +
        'Самоконтроль обычно бесполезен — модель пропустит свои же ошибки. Продолжить?'
      )
      if (!ok) return
    }
    // Сохраняем выбор как default если ещё не задан
    if (!defaultReviewer) {
      await window.api.settings.setKey('default_review_provider', providerId)
      setDefaultReviewer(providerId)
    }
    // DoD (Фаза 4): подтягиваем latest-верификацию чата, чтобы ревьюер сверял
    // заявленный итог с доказательством. Best-effort — нет verstak-истории или
    // ошибка IPC → ревью идёт как раньше, без VERIFICATION-блока.
    let verification = null
    if (path) {
      try { verification = await window.api.verifications.latest(path, activeChatId) } catch { /* DoD не критичен */ }
    }
    const payload = composeReviewPayload(messages, verification)
    // Модель — null (бэкэнд возьмёт default для этого провайдера)
    await startReview({ providerId, model: null, payload })
  }

  async function onClick() {
    // Grok audit fix: default reviewer мог быть удалён из списка (например
    // пользователь стёр API key). Не запускаем ревью с провайдером, для
    // которого нет ключа — открываем picker, пусть выберет действующий.
    // Простая эвристика: если API-провайдер, нужен ключ; CLI-провайдер
    // считаем доступным всегда (CLI сам ругнётся если бинарь не установлен —
    // мы это обработаем через sendId=0 в startReview).
    if (defaultReviewer) {
      const needsKey = defaultReviewer.endsWith('-api') ||
                       ['claude', 'grok', 'openai'].includes(defaultReviewer)
      if (needsKey) {
        const keyName = `${defaultReviewer.replace('-api', '')}_api_key`
        const key = await window.api.settings.getKey(keyName)
        if (!key) {
          setPickerOpen(true)
          return
        }
      }
      await runReview(defaultReviewer)
    } else {
      setPickerOpen(true)
    }
  }

  return (
    <div className="gg-review-btn-wrap">
      <button
        type="button"
        className="gg-review-btn"
        onClick={() => void onClick()}
        title="Запросить ревью последнего ответа агента другой моделью"
      >
        🔍 Ревью
      </button>
      <button
        type="button"
        className="gg-review-btn-dropdown"
        onClick={() => setPickerOpen(v => !v)}
        title="Выбрать другого ревьюера для этого раза"
      >▾</button>
      {pickerOpen && (
        <div className="gg-review-picker" onMouseLeave={() => setPickerOpen(false)}>
          <div className="gg-review-picker-title">Ревьюер:</div>
          {KNOWN_PROVIDERS.map(pid => (
            <button
              key={pid}
              type="button"
              className={`gg-review-picker-item ${pid === defaultReviewer ? 'is-default' : ''} ${pid === currentProvider ? 'is-self' : ''}`}
              onClick={() => { setPickerOpen(false); void runReview(pid) }}
            >
              {PROVIDER_LABELS[pid]}
              {pid === defaultReviewer && <span className="gg-review-picker-tag">по умолчанию</span>}
              {pid === currentProvider && <span className="gg-review-picker-tag is-warn">это сам чат</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
