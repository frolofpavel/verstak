import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PipelineRun } from '../types/api'
import { OutcomeRunView } from './OutcomeRunView'

type Filter = 'all' | 'active' | 'completed' | 'attention'

interface OutcomeRunsPanelProps {
  projectPath: string
  onClose: () => void
}

export function OutcomeRunsPanel({ projectPath, onClose }: OutcomeRunsPanelProps) {
  const [runs, setRuns] = useState<PipelineRun[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<PipelineRun | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.api.pipeline.list(projectPath).then(next => {
      if (!cancelled) setRuns(next)
    }).catch(cause => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить прогоны.')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [projectPath])

  const visible = useMemo(() => filterOutcomeRuns(runs, filter), [filter, runs])

  return createPortal(
    <>
      <div className="gg-modal-backdrop" onClick={onClose}>
        <div className="gg-modal gg-outcome-runs-panel" role="dialog" aria-modal="true" aria-labelledby="gg-outcome-runs-title" onClick={event => event.stopPropagation()}>
          <div className="gg-modal-header">
            <div>
              <div className="gg-modal-title" id="gg-outcome-runs-title">Прогоны до результата</div>
              <div className="gg-outcome-run-subtitle">История проекта · {runs.length}</div>
            </div>
            <button type="button" className="gg-modal-close" onClick={onClose} aria-label="Закрыть">×</button>
          </div>
          <div className="gg-outcome-run-filters" role="tablist">
            {([
              ['all', 'Все'],
              ['active', 'Активные'],
              ['completed', 'Завершённые'],
              ['attention', 'Нужны действия'],
            ] as const).map(([value, label]) => (
              <button key={value} type="button" className={`gg-btn gg-btn-xs ${filter === value ? 'gg-btn-primary' : 'gg-btn-ghost'}`} onClick={() => setFilter(value)}>
                {label}
              </button>
            ))}
          </div>
          <div className="gg-modal-body gg-outcome-runs-list">
            {loading && <p className="gg-outcome-muted">Загружаю историю…</p>}
            {error && <div className="gg-form-error" role="alert">{error}</div>}
            {!loading && !error && visible.length === 0 && <p className="gg-outcome-muted">В этом разделе прогонов пока нет.</p>}
            {visible.map(run => (
              <button type="button" className="gg-outcome-run-row" key={run.id} onClick={() => setSelected(run)}>
                <span className={`gg-outcome-status is-${run.step}`}>{run.step}</span>
                <span className="gg-outcome-run-row-main">
                  <strong>{run.brief.goal || `Прогон #${run.id}`}</strong>
                  <small>#{run.id} · {effortLabel(run.effortLevel)} · {new Date(run.updatedAt).toLocaleString()}</small>
                </span>
                <span aria-hidden>›</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      {selected && <OutcomeRunView pipeline={selected} onClose={() => setSelected(null)} />}
    </>,
    document.body,
  )
}

export function filterOutcomeRuns(runs: PipelineRun[], filter: Filter): PipelineRun[] {
  return runs.filter(run => {
    if (filter === 'active') return !['completed', 'cancelled'].includes(run.step)
    if (filter === 'completed') return run.step === 'completed'
    if (filter === 'attention') return run.step === 'blocked' || run.step === 'cancelled'
    return true
  })
}

function effortLabel(level: PipelineRun['effortLevel']) {
  if (level === 'quick') return 'Быстро'
  if (level === 'deep') return 'Глубоко'
  return 'Под контролем'
}
