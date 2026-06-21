import { useEffect, useState } from 'react'
import { useProject } from '../store/projectStore'
import type { DecisionRecord } from '../types/api'

function fmtDate(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Память решений проекта (AI-штаб /board → save_decision → project-brain).
// Renderer для backend brain:decisions-list. Read-only список Decision Record'ов.
const CONF_LABEL: Record<string, string> = { low: 'низкая', medium: 'средняя', high: 'высокая' }

export function DecisionsPanel() {
  const { path } = useProject()
  const [items, setItems] = useState<DecisionRecord[]>([])
  const [loading, setLoading] = useState(false)

  async function refresh() {
    setLoading(true)
    try {
      const list = await window.api.brain.decisionsList()
      setItems(Array.isArray(list) ? list : [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [path])

  return (
    <div className="gg-panel">
      <div className="gg-panel-header">
        <h2 className="gg-panel-title">Решения проекта</h2>
        <div className="gg-panel-meta">
          {items.length} реш.{' '}
          <button className="gg-btn" onClick={() => void refresh()} disabled={loading}>
            {loading ? '…' : 'Обновить'}
          </button>
        </div>
      </div>

      <div className="gg-panel-body">
        {items.length === 0 && !loading && (
          <div className="gg-text-tertiary" style={{ padding: 16, lineHeight: 1.6 }}>
            Пока нет сохранённых решений. Запусти <code>/board</code> для разбора важного решения —
            итог штаба (что / почему / риски / когда пересмотреть) сохранится сюда.
          </div>
        )}

        <div className="gg-decisions-list">
          {items.map(d => (
            <div key={d.id} className="gg-decision">
              <div className="gg-decision-head">
                <span className="gg-decision-title">{d.title}</span>
                {d.confidence && <span className="gg-decision-conf">{CONF_LABEL[d.confidence] ?? d.confidence}</span>}
                <span className="gg-decision-date">{fmtDate(d.createdAt)}</span>
              </div>
              {d.finalDecision && <div className="gg-decision-row"><b>Решение:</b> {d.finalDecision}</div>}
              {d.why && <div className="gg-decision-row"><b>Почему:</b> {d.why}</div>}
              {d.risks.length > 0 && <div className="gg-decision-row"><b>Риски:</b> {d.risks.join('; ')}</div>}
              {d.nextActions.length > 0 && <div className="gg-decision-row"><b>Дальше:</b> {d.nextActions.join('; ')}</div>}
              {d.revisitDate != null && (
                <div className="gg-decision-revisit">Пересмотреть: {fmtDate(d.revisitDate)}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
