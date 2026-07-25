import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  AgentJob,
  OutcomeMetrics,
  PipelineRun,
  Plan,
  VerificationRow,
} from '../types/api'

interface OutcomeRunViewProps {
  pipeline: PipelineRun
  onClose: () => void
}

export function OutcomeRunView({ pipeline, onClose }: OutcomeRunViewProps) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [jobs, setJobs] = useState<AgentJob[]>([])
  const [verification, setVerification] = useState<VerificationRow | null>(null)
  const [metrics, setMetrics] = useState<OutcomeMetrics | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      pipeline.planId ? window.api.plans.get(pipeline.planId).catch(() => null) : Promise.resolve(null),
      window.api.agentJobs.list(pipeline.projectPath).catch(() => []),
      pipeline.agentRunId
        ? window.api.verifications.latestByRunId(pipeline.projectPath, pipeline.agentRunId).catch(() => null)
        : window.api.verifications.latest(pipeline.projectPath, pipeline.chatId).catch(() => null),
      window.api.pipeline.metrics(pipeline.projectPath).catch(() => null),
    ]).then(([nextPlan, allJobs, nextVerification, nextMetrics]) => {
      if (cancelled) return
      setPlan(nextPlan)
      setJobs(allJobs.filter(job => job.pipelineId === pipeline.id))
      setVerification(nextVerification)
      setMetrics(nextMetrics)
    })
    return () => { cancelled = true }
  }, [pipeline])

  return createPortal(
    <div className="gg-modal-backdrop" onClick={onClose}>
      <div
        className="gg-modal gg-outcome-run-view"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gg-outcome-run-title"
        onClick={event => event.stopPropagation()}
      >
        <div className="gg-modal-header">
          <div>
            <div className="gg-modal-title" id="gg-outcome-run-title">До результата · прогон #{pipeline.id}</div>
            <div className="gg-outcome-run-subtitle">
              {effortLabel(pipeline.effortLevel)} · {pipeline.step}
            </div>
          </div>
          <button type="button" className="gg-modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <div className="gg-modal-body gg-outcome-run-grid">
          <section className="gg-outcome-card">
            <h3>Результат</h3>
            <p>{pipeline.brief.goal}</p>
            <dl>
              <dt>Границы</dt><dd>{pipeline.brief.constraints || 'Не заданы'}</dd>
              <dt>Готово когда</dt><dd>{pipeline.brief.dod || 'Уточняется агентом'}</dd>
              <dt>Контракт</dt>
              <dd>{pipeline.taskContract ? `revision ${pipeline.contractRevision} · ${pipeline.taskContract.risk}` : 'Уточняется'}</dd>
            </dl>
          </section>

          <section className="gg-outcome-card">
            <h3>План</h3>
            {plan?.steps.length ? (
              <ol className="gg-outcome-step-list">
                {plan.steps.map(step => (
                  <li key={step.id}>
                    <span className={`gg-outcome-status is-${step.status}`}>{step.status}</span>
                    <span>{step.title}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="gg-outcome-muted">План ещё не собран.</p>}
          </section>

          <section className="gg-outcome-card">
            <h3>Исполнители</h3>
            {jobs.length ? jobs.map(job => (
              <div className="gg-outcome-job" key={job.id}>
                <span className={`gg-outcome-status is-${job.status}`}>{job.status}</span>
                <span>{job.role} · {job.providerId}/{job.model}</span>
                <small>attempt {job.attempt}/{job.maxAttempts}</small>
              </div>
            )) : <p className="gg-outcome-muted">Один основной агент; делегированные jobs ещё не создавались.</p>}
          </section>

          <section className="gg-outcome-card">
            <h3>Проверка и Proof</h3>
            {verification ? (
              <dl>
                <dt>Статус</dt><dd>{verification.overall}</dd>
                <dt>Проверки</dt><dd>{verification.checksPassed}/{verification.checksTotal}</dd>
                <dt>Файлы</dt><dd>{verification.changedFilesCount}</dd>
                <dt>Proof</dt><dd>{verification.htmlPath || verification.artifactPath || 'Артефакт не создан'}</dd>
              </dl>
            ) : <p className="gg-outcome-muted">Проверка и Proof появятся после выполнения.</p>}
          </section>

          <section className="gg-outcome-card gg-outcome-metrics">
            <h3>Локальные метрики</h3>
            {metrics ? (
              <div className="gg-outcome-metric-grid">
                <Metric label="Завершено" value={`${metrics.completed}/${metrics.starts}`} />
                <Metric label="Блокировки" value={metrics.blocked} />
                <Metric label="Повторы" value={metrics.retries} />
                <Metric label="Перепланы" value={metrics.replans} />
                <Metric label="Вмешательства" value={metrics.interventions} />
                <Metric label="Jobs" value={metrics.jobs} />
                <Metric label="Файлы" value={metrics.filesChanged} />
                <Metric label="Без corrective prompt" value={metrics.noCorrectivePromptRuns} />
                <Metric label="Токены" value={nullable(metrics.inputTokens, metrics.outputTokens)} />
                <Metric label="Кэш" value={metrics.cacheReadTokens ?? 'неизвестно'} />
                <Metric label="Стоимость" value={metrics.costCents == null ? 'неизвестно' : `$${(metrics.costCents / 100).toFixed(2)}`} />
                <Metric label="Медиана до Proof" value={formatDuration(metrics.medianTimeToProofMs)} />
              </div>
            ) : <p className="gg-outcome-muted">Метрики загружаются…</p>}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div><span>{label}</span><strong>{value}</strong></div>
}

function effortLabel(level: PipelineRun['effortLevel']) {
  if (level === 'quick') return 'Быстро'
  if (level === 'deep') return 'Глубоко'
  return 'Под контролем'
}

function nullable(input: number | null, output: number | null) {
  return input == null && output == null ? 'неизвестно' : `${input ?? '?'} / ${output ?? '?'}`
}

function formatDuration(value: number | null) {
  if (value == null) return 'неизвестно'
  if (value < 60_000) return `${Math.round(value / 1000)} сек`
  return `${Math.round(value / 60_000)} мин`
}
