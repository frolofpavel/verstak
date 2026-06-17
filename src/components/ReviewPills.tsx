import { useEffect, useState } from 'react'
import { useProject } from '../store/projectStore'
import { Markdown } from './Markdown'
import { composeFixPrompt, findingsToPlanSteps, type ReviewFinding, type FindingSeverity } from '../lib/review-findings'
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
  const toggleFinding = useProject(s => s.toggleFinding)

  // DoD-бейдж (Фаза 4): latest-верификация текущего чата рядом с ревью — чтобы
  // было видно доказательство, которое ревьюер сверял. Подтягиваем при открытии
  // панели / смене чата. Best-effort: нет истории или ошибка → бейджа просто нет.
  const [verification, setVerification] = useState<VerificationRow | null>(null)
  // F8: статус сохранения находок в План (нотис под действиями).
  const [planNotice, setPlanNotice] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (openedReviewId == null || !path || activeChatId == null) { setVerification(null); return }
    window.api.verifications.latest(path, activeChatId)
      .then(v => { if (alive) setVerification(v) })
      .catch(() => { if (alive) setVerification(null) })
    return () => { alive = false }
  }, [openedReviewId, path, activeChatId])
  // Сброс нотиса при смене раскрытого ревью.
  useEffect(() => { setPlanNotice(null) }, [openedReviewId])

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

  // V2: «Исправить выбранные» — собирает принятые findings в таргетированный
  // промпт и отправляет в ОСНОВНОЙ чат. Та же guard-логика, что и forwardToChat
  // (чат не должен стримить, ревью должно быть завершено).
  async function fixSelected() {
    if (!review || !path || activeChatId == null) return
    if (review.status !== 'done') {
      window.alert('Ревью ещё не завершилось — подожди немного и попробуй снова.')
      return
    }
    if (useProject.getState().isStreaming) {
      window.alert('Основной чат сейчас отвечает. Подожди завершения и попробуй снова.')
      return
    }
    const chosen = review.findings.filter(f => review.accepted.includes(f.id))
    if (chosen.length === 0) {
      window.alert('Не выбрано ни одного замечания. Отметь галочками те, что нужно исправить.')
      return
    }
    const prompt = composeFixPrompt(chosen)
    addMessage({ role: 'user', content: prompt })
    void window.api.chats.append(activeChatId, path, 'user', prompt).catch(() => {})
    void window.api.journal.append(path, 'note',
      `✓ Исправить выбранные замечания ревью (${chosen.length})`,
      prompt.length > 300 ? prompt.slice(0, 300) + '…' : prompt)
    addMessage({ role: 'assistant', content: '' })
    setStreaming(true)
    const allMessages = [...useProject.getState().messages].slice(0, -1)
    const sendId = await window.api.ai.send(allMessages, path)
    registerSendOwner(sendId, { kind: 'chat', chatId: activeChatId })
    toggleReviewPanel(null)
  }

  // F8: сохранить находки в План (выбранные галочками, иначе все). Каждая находка
  // = шаг плана → persist + статус (pending→done/skipped/failed) + связка
  // шаг→прогон→верификация. Закрывает петлю «нашёл → исправил → перепроверил».
  async function saveFindingsToPlan() {
    if (!review || !path) return
    const selected = review.findings.filter(f => review.accepted.includes(f.id))
    const chosen = selected.length > 0 ? selected : review.findings
    if (chosen.length === 0) { setPlanNotice('Нет находок для сохранения.'); return }
    const steps = findingsToPlanSteps(chosen)
    const title = `Ревью от ${label} · ${chosen.length} ${plural(chosen.length, 'находка', 'находки', 'находок')}`
    try {
      const plan = await window.api.plans.create(path, title, steps)
      void window.api.journal.append(path, 'note', `📋 Находки ревью → план «${title}»`,
        chosen.map(f => `${f.severity} ${f.file}: ${f.title}`).join('\n')).catch(() => {})
      setPlanNotice(plan ? `✓ Сохранено в план «${title}». Открой вкладку «Планы» — статус по каждой находке, связка с прогоном и верификацией.` : 'Не удалось создать план.')
    } catch {
      setPlanNotice('Не удалось создать план.')
    }
  }

  // file:line → reveal в проводнике. Путь finding относителен корня проекта;
  // склеиваем с project root (revealInExplorer требует путь внутри known roots).
  function revealFinding(f: ReviewFinding) {
    if (!path || !f.file || f.file === '(не указан)') return
    const sep = path.includes('\\') ? '\\' : '/'
    const rel = f.file.replace(/[/\\]+/g, sep).replace(/^[/\\]+/, '')
    const abs = `${path}${sep}${rel}`
    void window.api.files.revealInExplorer(abs).catch(() => {})
  }

  const findings = review.findings
  const acceptedCount = review.accepted.length

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
        ) : findings.length > 0 ? (
          // V2: карточки findings, отсортированные по severity (P0 первыми).
          <ul className="gg-finding-list">
            {[...findings].sort((a, b) => sevRank(a.severity) - sevRank(b.severity)).map(f => (
              <FindingCard
                key={f.id}
                finding={f}
                accepted={review.accepted.includes(f.id)}
                onToggle={() => toggleFinding(review.reviewChatId, f.id)}
                onReveal={() => revealFinding(f)}
              />
            ))}
          </ul>
        ) : review.content ? (
          // Старый текстовый ревью без json-блока — как раньше, markdown.
          <Markdown text={review.content} />
        ) : (
          <div className="gg-review-empty">Ревью загружается…</div>
        )}
      </div>
      {review.status === 'done' && (review.content || findings.length > 0) && (
        <div className="gg-review-panel-actions">
          {findings.length > 0 && (
            <button
              type="button"
              className="gg-btn gg-btn-primary"
              onClick={() => void fixSelected()}
              disabled={isStreaming || acceptedCount === 0}
              title={isStreaming
                ? 'Основной чат отвечает — дождись завершения'
                : acceptedCount === 0 ? 'Отметь замечания галочками' : ''}
            >
              ✓ Исправить выбранные ({acceptedCount})
            </button>
          )}
          <button
            type="button"
            className={findings.length > 0 ? 'gg-btn' : 'gg-btn gg-btn-primary'}
            onClick={() => void forwardToChat()}
            disabled={isStreaming}
            title={isStreaming ? 'Основной чат отвечает — дождись завершения' : ''}
          >
            ↪ Учесть в чате
          </button>
          {findings.length > 0 && (
            <button
              type="button"
              className="gg-btn"
              onClick={() => void saveFindingsToPlan()}
              title="Сохранить находки в План — статус по каждой, связка с прогоном и верификацией. Выбранные галочками, иначе все."
            >
              📋 В план ({acceptedCount > 0 ? acceptedCount : findings.length})
            </button>
          )}
          <span className="gg-review-panel-hint">
            {isStreaming
              ? 'Жди завершения текущего ответа основного чата'
              : findings.length > 0
                ? 'Отметь нужные замечания и нажми «Исправить выбранные» — фикс уйдёт точечно'
                : 'Отправит текст ревью в основной чат — модель сама решит что с ним делать'}
          </span>
          {planNotice && <div className="gg-review-plan-notice">{planNotice}</div>}
        </div>
      )}
    </div>
  )
}

/** Одна карточка finding: severity-бейдж + category + title + file:line + чекбокс. */
function FindingCard(props: {
  finding: ReviewFinding
  accepted: boolean
  onToggle: () => void
  onReveal: () => void
}) {
  const { finding: f, accepted, onToggle, onReveal } = props
  const [expanded, setExpanded] = useState(false)
  const hasFile = !!f.file && f.file !== '(не указан)'
  const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file
  return (
    <li className={`gg-finding gg-finding-${severityClass(f.severity)} ${accepted ? 'is-accepted' : ''}`}>
      <label className="gg-finding-check">
        <input type="checkbox" checked={accepted} onChange={onToggle} />
      </label>
      <div className="gg-finding-main">
        <div className="gg-finding-head">
          <span className={`gg-finding-sev gg-finding-sev-${severityClass(f.severity)}`}>{f.severity}</span>
          <span className="gg-finding-cat">{f.category}</span>
          <span className="gg-finding-title">{f.title}</span>
        </div>
        <div className="gg-finding-meta">
          {hasFile && (
            <button
              type="button"
              className="gg-finding-loc"
              onClick={onReveal}
              title="Открыть файл в проводнике"
            >{loc}</button>
          )}
          {f.detail && (
            <button
              type="button"
              className="gg-finding-toggle"
              onClick={() => setExpanded(v => !v)}
            >{expanded ? 'свернуть' : 'подробнее'}</button>
          )}
        </div>
        {expanded && f.detail && (
          <div className="gg-finding-detail">
            <div>{f.detail}</div>
            {f.suggestedFix && (
              <div className="gg-finding-fix"><b>Фикс:</b> {f.suggestedFix}</div>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

/** severity → css-суффикс (для цвета карточки). */
function severityClass(sev: FindingSeverity): string {
  switch (sev) {
    case 'P0': return 'p0'
    case 'P1': return 'p1'
    case 'P2': return 'p2'
    default: return 'p3'
  }
}

/** Ранг severity для сортировки списка findings: P0 (критично) — первым,
 *  P3 (мелочь) — последним. Раньше карточки шли в порядке прихода и P0-дыра
 *  тонула среди P3 (аудит). */
function sevRank(sev: FindingSeverity): number {
  switch (sev) {
    case 'P0': return 0
    case 'P1': return 1
    case 'P2': return 2
    default: return 3
  }
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
