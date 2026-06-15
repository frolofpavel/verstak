import { useEffect, useState } from 'react'
import { useProject } from '../store/projectStore'
import { Markdown } from './Markdown'
import type { VerificationRow } from '../types/api'

/**
 * Pills ревью в Timeline + ReviewPanel над composer.
 *
 * Два экспорта в одном файле:
 * - <ReviewPills/> рендерится внутри TimelineBar.
 * - <ReviewPanel/> рендерится отдельным сиблингом в Chat.tsx, выше composer.
 *   Это нужно потому что .gg-timeline имеет overflow-x: auto и клиппает
 *   любой absolute child по вертикали.
 *
 * Состояние «какой ревью раскрыт» живёт в store (openedReviewId), чтобы оба
 * компонента могли его читать.
 */

const PROVIDER_LABELS: Record<string, string> = {
  'gemini-api': 'Gemini',
  'gemini-cli': 'Gemini CLI',
  'claude': 'Claude',
  'claude-cli': 'Claude Code',
  'grok': 'Grok',
  'grok-cli': 'Grok Build',
  'openai': 'OpenAI',
  'codex-cli': 'Codex'
}

export function ReviewPills() {
  const activeChatId = useProject(s => s.activeChatId)
  const reviews = useProject(s => s.reviews)
  const openedReviewId = useProject(s => s.openedReviewId)
  const toggleReviewPanel = useProject(s => s.toggleReviewPanel)

  if (activeChatId == null) return null

  const myReviews = Object.values(reviews).filter(r => r.parentChatId === activeChatId)
  if (myReviews.length === 0) return null

  myReviews.sort((a, b) => a.createdAt - b.createdAt)

  return (
    <>
      {myReviews.map(r => {
        const label = PROVIDER_LABELS[r.providerId] ?? r.providerId
        const statusText = r.status === 'streaming'
          ? 'идёт…'
          : r.status === 'error'
            ? 'ошибка'
            : r.noteCount >= 0
              ? `${r.noteCount} ${plural(r.noteCount, 'замечание', 'замечания', 'замечаний')}`
              : 'готово'
        const isOpen = openedReviewId === r.reviewChatId
        return (
          <span
            key={r.reviewChatId}
            className={`gg-timeline-pill gg-review-pill is-${r.status} ${isOpen ? 'is-open' : ''}`}
            onClick={() => toggleReviewPanel(r.reviewChatId)}
            title={`Ревью от ${label} — ${statusText}. Клик: ${isOpen ? 'свернуть' : 'раскрыть'}`}
          >
            <span className="gg-timeline-pill-icon">🔍</span>
            <span className="gg-timeline-pill-detail">{label}: {statusText}</span>
          </span>
        )
      })}
    </>
  )
}

/**
 * Панель раскрытого ревью. Рендерится отдельным сиблингом в Chat.tsx (между
 * TimelineBar и composer), чтобы не страдать от overflow-x: auto на timeline.
 */
export function ReviewPanel() {
  const openedReviewId = useProject(s => s.openedReviewId)
  const reviews = useProject(s => s.reviews)
  const toggleReviewPanel = useProject(s => s.toggleReviewPanel)
  const addMessage = useProject(s => s.addMessage)
  const path = useProject(s => s.path)
  const activeChatId = useProject(s => s.activeChatId)
  const isStreaming = useProject(s => s.isStreaming)
  const setStreaming = useProject(s => s.setStreaming)
  const registerSendOwner = useProject(s => s.registerSendOwner)

  // DoD-бейдж (Фаза 4): latest-верификация текущего чата рядом с ревью — чтобы
  // было видно доказательство, которое ревьюер сверял. Подтягиваем при открытии
  // панели / смене чата. Best-effort: нет истории или ошибка → бейджа просто нет.
  const [verification, setVerification] = useState<VerificationRow | null>(null)
  useEffect(() => {
    let alive = true
    if (openedReviewId == null || !path || activeChatId == null) { setVerification(null); return }
    window.api.verifications.latest(path, activeChatId)
      .then(v => { if (alive) setVerification(v) })
      .catch(() => { if (alive) setVerification(null) })
    return () => { alive = false }
  }, [openedReviewId, path, activeChatId])

  if (openedReviewId == null) return null
  const review = reviews[openedReviewId]
  if (!review) return null
  const label = PROVIDER_LABELS[review.providerId] ?? review.providerId

  async function forwardToChat() {
    if (!review || !path || activeChatId == null) return
    if (review.status !== 'done') {
      window.alert('Ревью ещё не завершилось — подожди немного и попробуй снова.')
      return
    }
    // Grok audit fix: если основной чат сейчас стримит ответ, нельзя
    // одновременно пушить новый user message + второй ai.send — будут два
    // assistant placeholders, события могут перепутаться.
    if (useProject.getState().isStreaming) {
      window.alert('Основной чат сейчас отвечает. Подожди завершения и попробуй снова.')
      return
    }
    const text = review.content.trim()
    if (!text) {
      window.alert('Ревью пустое, пересылать нечего.')
      return
    }
    const wrapped = `[Review from ${label}]:\n\n${text}`
    addMessage({ role: 'user', content: wrapped })
    void window.api.chats.append(activeChatId, path, 'user', wrapped).catch(() => {})
    void window.api.journal.append(path, 'note', `Учёл ревью от ${label}`,
      text.length > 300 ? text.slice(0, 300) + '…' : text)
    addMessage({ role: 'assistant', content: '' })
    setStreaming(true)
    const allMessages = [...useProject.getState().messages].slice(0, -1)
    const sendId = await window.api.ai.send(allMessages, path)
    registerSendOwner(sendId, { kind: 'chat', chatId: activeChatId })
    toggleReviewPanel(null)
  }

  return (
    <div className="gg-review-panel">
      <div className="gg-review-panel-header">
        <span className="gg-review-panel-title">
          🔍 Ревью от {label}
          {review.status === 'streaming' && <span className="gg-review-streaming">· идёт…</span>}
          {review.status === 'error' && <span className="gg-review-error">· ошибка</span>}
        </span>
        {verification && (
          <span
            className={`gg-timeline-pill gg-verification-pill is-${verification.overall}`}
            title={`Заявленный DoD этого чата: ${verification.taskSummary ?? 'без описания'}. Ревьюер сверял его с ответом агента.`}
          >
            {dodLabel(verification)}
          </span>
        )}
        <button type="button" className="gg-review-panel-close" onClick={() => toggleReviewPanel(null)}>×</button>
      </div>
      <div className="gg-review-panel-body">
        {review.status === 'error' ? (
          <div className="gg-review-error-msg">{review.errorMessage ?? 'Неизвестная ошибка'}</div>
        ) : review.content ? (
          <Markdown text={review.content} />
        ) : (
          <div className="gg-review-empty">Ревью загружается…</div>
        )}
      </div>
      {review.status === 'done' && review.content && (
        <div className="gg-review-panel-actions">
          <button
            type="button"
            className="gg-btn gg-btn-primary"
            onClick={() => void forwardToChat()}
            disabled={isStreaming}
            title={isStreaming ? 'Основной чат отвечает — дождись завершения' : ''}
          >
            ↪ Учесть в чате
          </button>
          <span className="gg-review-panel-hint">
            {isStreaming
              ? 'Жди завершения текущего ответа основного чата'
              : 'Отправит текст ревью в основной чат — модель сама решит что с ним делать'}
          </span>
        </div>
      )}
    </div>
  )
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}

/** Короткий DoD-бейдж для ReviewPanel: ✅passed N/M / ✗failed / ⚠partial. */
function dodLabel(v: VerificationRow): string {
  const nm = `${v.checksPassed}/${v.checksTotal}`
  switch (v.overall) {
    case 'passed': return `✅ DoD ${nm}`
    case 'failed': return `✗ DoD ${nm}`
    case 'partial': return `⚠ DoD ${nm}`
    default: return `⚠ DoD не запущен`
  }
}
