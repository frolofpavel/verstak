import { useEffect, useState } from 'react'
import { useProject } from '../store/projectStore'
import { useProvider } from '../hooks/useProvider'
import type { FeedbackEntry } from '../types/api'

const RATINGS: Array<{ value: number; label: string }> = [
  { value: 1, label: '🙁' },
  { value: 2, label: '😐' },
  { value: 3, label: '🙂' },
  { value: 4, label: '😊' },
  { value: 5, label: '🤩' }
]

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function FeedbackView() {
  const { path } = useProject()
  const provider = useProvider()
  const [entries, setEntries] = useState<FeedbackEntry[]>([])
  const [rating, setRating] = useState<number | null>(null)
  const [message, setMessage] = useState('')
  const [sent, setSent] = useState(false)
  const [report, setReport] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  async function refresh() {
    const list = await window.api.feedback.list(path, 50)
    setEntries(list)
  }

  useEffect(() => { void refresh() }, [path])

  async function submit() {
    const text = message.trim()
    if (!text) return
    await window.api.feedback.submit({
      projectPath: path,
      providerId: provider.id,
      rating,
      message: text
    })
    setMessage('')
    setRating(null)
    setSent(true)
    setTimeout(() => setSent(false), 2000)
    await refresh()
  }

  /** Собирает отчёт и ПОКАЗЫВАЕТ его. Отправку делает человек — см. support-report.ts. */
  async function prepareReport() {
    const text = message.trim()
    if (!text) return
    setBusy(true)
    try {
      setReport(await window.api.feedback.buildReport({
        message: text,
        rating,
        providerId: provider.id,
        model: provider.model ?? null
      }))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: number) {
    await window.api.feedback.remove(id)
    await refresh()
  }

  return (
    <div className="gg-panel">
      <div className="gg-panel-header">
        <h2 className="gg-panel-title">Обратная связь</h2>
        <div className="gg-panel-meta">{entries.length} запис(и)</div>
      </div>

      <div className="gg-panel-body">
        <div className="gg-feedback-form">
          <div className="gg-label">Оценка работы агента</div>
          <div className="gg-feedback-ratings">
            {RATINGS.map(r => (
              <button
                key={r.value}
                type="button"
                className={`gg-feedback-rating ${rating === r.value ? 'is-active' : ''}`}
                onClick={() => setRating(rating === r.value ? null : r.value)}
                title={`${r.value} / 5`}
              >
                {r.label}
              </button>
            ))}
          </div>

          <div className="gg-label" style={{ marginTop: 16 }}>Что понравилось / что хочется улучшить</div>
          <textarea
            className="gg-input gg-feedback-textarea"
            placeholder="Например: AI забыл правило про async/await; classify-команды слишком строгие; нужна кнопка X…"
            rows={4}
            value={message}
            onChange={e => setMessage(e.target.value)}
          />

          <div className="gg-feedback-actions">
            <span className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)' }}>
              {provider.label} · {path ? path.split(/[\\/]/).pop() : 'без проекта'}
            </span>
            <button
              className="gg-btn"
              onClick={() => void prepareReport()}
              disabled={!message.trim() || busy}
              title="Собрать отчёт с версией, системой и последними записями журнала. Ничего не отправляется — вы увидите текст целиком."
            >
              Собрать отчёт о проблеме
            </button>
            <button
              className="gg-btn gg-btn-primary"
              onClick={() => void submit()}
              disabled={!message.trim()}
            >
              {/* Раньше здесь стояло «Отправить» / «✓ Отправлено», хотя запись ложилась
                  в локальную базу и никуда не уходила. Человек считал, что сообщил о
                  проблеме, а автор продукта не узнавал ничего. Слово приведено к делу. */}
              {sent ? '✓ Сохранено' : 'Сохранить у себя'}
            </button>
          </div>

          {report != null && (
            <div className="gg-feedback-report">
              <div className="gg-label" style={{ marginTop: 16 }}>
                Отчёт готов. Ключи и токены из него вырезаны. Проверьте текст и отправьте сами —
                приложение ничего не отправляет.
              </div>
              <textarea className="gg-input gg-feedback-textarea" rows={12} readOnly value={report} />
              <div className="gg-feedback-actions">
                <button
                  className="gg-btn"
                  onClick={() => { void navigator.clipboard.writeText(report); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
                >
                  {copied ? '✓ Скопировано' : 'Скопировать'}
                </button>
                <button className="gg-btn" onClick={() => setReport(null)}>Закрыть</button>
              </div>
            </div>
          )}
        </div>

        {entries.length > 0 && (
          <div className="gg-feedback-list">
            {entries.map(e => (
              <div key={e.id} className="gg-feedback-entry">
                <div className="gg-feedback-entry-meta">
                  {e.rating && <span className="gg-feedback-entry-rating">{RATINGS.find(r => r.value === e.rating)?.label ?? e.rating}</span>}
                  {e.providerId && <span className="gg-feedback-entry-provider">{e.providerId}</span>}
                  <span className="gg-feedback-entry-time">{formatTime(e.createdAt)}</span>
                  <button className="gg-feedback-entry-remove" onClick={() => void remove(e.id)} title="Удалить">×</button>
                </div>
                <div className="gg-feedback-entry-message">{e.message}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
