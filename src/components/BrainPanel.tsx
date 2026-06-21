import { useEffect, useState } from 'react'
import { useProject } from '../store/projectStore'
import type { ProjectBrain } from '../types/api'

function fmtDateTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// «Мозг проекта» (Project Brain, Итер.1-4): прогрев → overview/summary/context-packs.
// Renderer для backend brain:get / brain:warmup. Статус мозга + ручной прогрев.
type WarmupResult = {
  filesScanned: number
  filesSummarized: number
  packs: Array<{ type: 'short' | 'medium' | 'long'; tokenEstimate: number | null }>
}

export function BrainPanel() {
  const { path } = useProject()
  const [brain, setBrain] = useState<ProjectBrain | null>(null)
  const [loading, setLoading] = useState(false)
  const [warming, setWarming] = useState(false)
  const [warmResult, setWarmResult] = useState<WarmupResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    setLoading(true)
    try {
      setBrain(await window.api.brain.get())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { setWarmResult(null); void refresh() }, [path])

  async function warmup() {
    setWarming(true)
    setError(null)
    try {
      const res = await window.api.brain.warmup()
      setWarmResult(res)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setWarming(false)
    }
  }

  return (
    <div className="gg-panel">
      <div className="gg-panel-header">
        <h2 className="gg-panel-title">Мозг проекта</h2>
        <div className="gg-panel-meta">
          <button className="gg-btn" onClick={() => void warmup()} disabled={warming || !path}>
            {warming ? 'Прогрев…' : brain ? 'Перепрогреть' : 'Прогреть проект'}
          </button>
        </div>
      </div>

      <div className="gg-panel-body">
        {!path && <div className="gg-text-tertiary" style={{ padding: 16 }}>Откройте проект.</div>}

        {path && !brain && !loading && (
          <div className="gg-text-tertiary" style={{ padding: 16, lineHeight: 1.6 }}>
            Проект ещё не прогрет. Нажми «Прогреть проект» — мозг просканирует код,
            сделает summary и подготовит контекст-паки, чтобы агент сразу видел структуру
            без пере-сканирования на каждый запрос.
          </div>
        )}

        {error && (
          <div className="gg-brain-error">Ошибка прогрева: {error}</div>
        )}

        {warmResult && (
          <div className="gg-brain-warm">
            Прогрето: файлов {warmResult.filesScanned}, summary {warmResult.filesSummarized}.{' '}
            {warmResult.packs.map(p => `${p.type}: ~${p.tokenEstimate ?? '?'} ток.`).join(' · ')}
          </div>
        )}

        {brain && (
          <div className="gg-brain">
            <div className="gg-brain-meta">
              v{brain.version} · обновлён {fmtDateTime(brain.updatedAt)}
              {brain.lastWarmupAt != null && ` · прогрет ${fmtDateTime(brain.lastWarmupAt)}`}
            </div>
            {brain.overview && (
              <div className="gg-brain-block"><div className="gg-brain-label">Обзор</div><div className="gg-brain-text">{brain.overview}</div></div>
            )}
            {brain.architectureSummary && (
              <div className="gg-brain-block"><div className="gg-brain-label">Архитектура</div><div className="gg-brain-text">{brain.architectureSummary}</div></div>
            )}
            {brain.projectRules && (
              <div className="gg-brain-block"><div className="gg-brain-label">Правила</div><div className="gg-brain-text">{brain.projectRules}</div></div>
            )}
            {brain.importantFiles.length > 0 && (
              <div className="gg-brain-block">
                <div className="gg-brain-label">Ключевые файлы ({brain.importantFiles.length})</div>
                <div className="gg-brain-tags">{brain.importantFiles.map((f, i) => <span key={i} className="gg-brain-tag">{f}</span>)}</div>
              </div>
            )}
            {brain.entities.length > 0 && (
              <div className="gg-brain-block">
                <div className="gg-brain-label">Сущности ({brain.entities.length})</div>
                <div className="gg-brain-tags">{brain.entities.map((e, i) => <span key={i} className="gg-brain-tag">{e}</span>)}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
