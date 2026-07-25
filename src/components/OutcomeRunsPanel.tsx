import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentJob, PipelineRun } from '../types/api'
import { OutcomeRunView } from './OutcomeRunView'

type Filter = 'all' | 'active' | 'completed' | 'attention'

interface OutcomeRunsPanelProps {
  projectPath: string
  onClose: () => void
}

export function OutcomeRunsPanel({ projectPath, onClose }: OutcomeRunsPanelProps) {
  const [runs, setRuns] = useState<PipelineRun[]>([])
  const [jobs, setJobs] = useState<AgentJob[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<PipelineRun | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [actionMessage, setActionMessage] = useState('')

  function refresh() {
    let cancelled = false
    setLoading(true)
    void Promise.all([
      window.api.pipeline.list(projectPath),
      window.api.agentJobs.list(projectPath),
    ]).then(([nextRuns, nextJobs]) => {
      if (!cancelled) {
        setRuns(nextRuns)
        setJobs(nextJobs)
      }
    }).catch(cause => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить прогоны.')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }

  useEffect(() => {
    return refresh()
    // refresh зависит только от projectPath; функция намеренно локальна экрану.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath])

  const visible = useMemo(() => filterOutcomeRuns(runs, filter), [filter, runs])
  const interventions = useMemo(() => selectOutcomeInterventions(jobs), [jobs])

  async function act(job: AgentJob, action: InterventionAction) {
    setActionMessage('')
    try {
      if (action === 'cancel') await window.api.agentJobs.cancel(job.id)
      if (action === 'resume') await window.api.agentJobs.approveResume(job.id)
      if (action === 'apply') {
        const result = await window.api.agentJobs.chooseVariant(job.id)
        if (!result.ok) throw new Error(result.error ?? 'Не удалось применить вариант.')
      }
      if (action === 'reject') {
        const result = await window.api.agentJobs.rejectVariant(job.id)
        if (!result.ok) throw new Error(result.error ?? 'Не удалось отклонить вариант.')
      }
      setActionMessage('Действие выполнено. Состояние перечитано.')
      refresh()
    } catch (cause) {
      setActionMessage(cause instanceof Error ? cause.message : String(cause))
    }
  }

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
            {actionMessage && <div className="gg-notice" role="status">{actionMessage}</div>}
            {interventions.length > 0 && (
              <section className="gg-outcome-interventions" aria-label="Нужны ваши действия">
                <h3>Нужны ваши действия · {interventions.length}</h3>
                {interventions.map(job => (
                  <div className="gg-outcome-intervention-row" key={job.id}>
                    <span className={`gg-outcome-status is-${job.status}`}>{job.status}</span>
                    <span className="gg-outcome-run-row-main">
                      <strong>{job.goal}</strong>
                      <small>{job.role} · {job.waitingReason ?? job.interruptionReason ?? 'готовый изолированный вариант'}</small>
                    </span>
                    <span className="gg-outcome-intervention-actions">
                      {availableInterventionActions(job).map(action => (
                        <button key={action} type="button" className={`gg-btn gg-btn-xs ${action === 'cancel' || action === 'reject' ? 'gg-btn-ghost' : 'gg-btn-primary'}`} onClick={() => void act(job, action)}>
                          {actionLabel(action)}
                        </button>
                      ))}
                    </span>
                  </div>
                ))}
              </section>
            )}
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

export type InterventionAction = 'resume' | 'cancel' | 'apply' | 'reject'

export function selectOutcomeInterventions(jobs: AgentJob[]): AgentJob[] {
  return jobs.filter(job =>
    job.status === 'waiting-approval'
    || job.status === 'interrupted'
    || job.status === 'blocked'
    || (job.status === 'succeeded' && !!job.worktreePath))
}

export function availableInterventionActions(job: AgentJob): InterventionAction[] {
  if (job.status === 'waiting-approval') return ['cancel']
  if (job.status === 'interrupted') return ['resume', 'cancel']
  if (job.status === 'succeeded' && job.worktreePath) return ['apply', 'reject']
  return []
}

function actionLabel(action: InterventionAction) {
  if (action === 'resume') return 'Продолжить'
  if (action === 'apply') return 'Применить'
  if (action === 'reject') return 'Отклонить'
  return 'Отменить'
}

function effortLabel(level: PipelineRun['effortLevel']) {
  if (level === 'quick') return 'Быстро'
  if (level === 'deep') return 'Глубоко'
  return 'Под контролем'
}
