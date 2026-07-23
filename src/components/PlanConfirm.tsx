import { useEffect, useState } from 'react'
import { useProject } from '../store/projectStore'
import type { Plan } from '../types/api'

/**
 * #3 plan-gate: модалка одобрения плана. Агент в режиме планирования предложил
 * план и БЛОКИРОВАН до решения — Одобрить (→ выполнение) / Доработать (с
 * замечаниями) / Отклонить. «Высокий контроль»: человек одобряет план ДО старта.
 */
export function PlanConfirm() {
  const { pendingPlan, setPendingPlan } = useProject()
  const [feedback, setFeedback] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null)
  const planId = pendingPlan?.planId ?? null
  useEffect(() => {
    if (planId == null) { setPlan(null); return }
    let cancelled = false
    void window.api.plans.get(planId).then(value => {
      if (!cancelled) setPlan(value)
    }).catch(() => {
      if (!cancelled) setPlan(null)
    })
    return () => { cancelled = true }
  }, [planId])
  if (!pendingPlan) return null
  const ref = pendingPlan

  async function resolve(decision: 'approve' | 'revise' | 'reject') {
    await window.api.ai.resolvePlan(ref.callId, decision, feedback.trim() || undefined, ref.sendId)
    if (decision === 'approve') {
      const store = useProject.getState()
      if (store.activePipeline?.step === 'plan') {
        await store.advancePipeline({ step: 'execute', planId: ref.planId })
        window.dispatchEvent(new CustomEvent('gg-pipeline-plan-approved'))
      }
    }
    setPendingPlan(null)
    setFeedback('')
  }

  return (
    <div className="gg-modal-backdrop" onClick={() => void resolve('reject')}>
      <div className="gg-modal gg-plan-confirm-full" onClick={e => e.stopPropagation()}>
        <div className="gg-modal-header">
          <div>
            <div className="gg-modal-title">📋 План на одобрение</div>
            <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 4 }}>
              «{ref.title}» — {ref.stepCount} шаг(ов). Одобрить выполнение, отправить на доработку или отклонить?
            </div>
          </div>
        </div>

        <div className="gg-modal-body" style={{ padding: '16px 22px', overflow: 'auto' }}>
          {plan?.quality && (
            <div className={`gg-plan-quality is-${plan.quality.status}`}>
              Quality: {plan.quality.score}/100 · {plan.quality.status}
              {plan.quality.warnings.length > 0 && <ul>{plan.quality.warnings.map(item => <li key={item}>{item}</li>)}</ul>}
            </div>
          )}
          {plan?.steps.map((step, index) => (
            <div className="gg-plan-confirm-step" key={step.id}>
              <strong>{index + 1}. {step.title}</strong>
              {step.detail && <div>{step.detail}</div>}
              {step.spec && (
                <dl>
                  <dt>Цель шага</dt><dd>{step.spec.intent}</dd>
                  <dt>Действия</dt><dd>{step.spec.actions.join('; ') || '—'}</dd>
                  <dt>Файлы / write scope</dt><dd>{[...step.spec.files, ...step.spec.writeScope].join(', ') || '—'}</dd>
                  <dt>Зависит от</dt><dd>{step.spec.dependsOn.join(', ') || '—'}</dd>
                  <dt>Критерии Task Contract</dt><dd>{step.spec.acceptanceCriterionIds.join(', ') || '—'}</dd>
                  <dt>Проверка</dt><dd>{step.spec.verification.join('; ') || '—'}</dd>
                  <dt>Evidence</dt><dd>{step.spec.expectedEvidence.join('; ') || '—'}</dd>
                  <dt>Риск / rollback</dt><dd>{step.spec.risk} · {step.spec.rollback || '—'}</dd>
                  <dt>Исполнение</dt><dd>{step.spec.execution} · {step.spec.role}</dd>
                </dl>
              )}
            </div>
          ))}
          {!plan && <div className="gg-text-tertiary">Загружаю полный план…</div>}
          <textarea
            className="gg-input"
            value={feedback}
            onChange={e => setFeedback(e.target.value)}
            placeholder="Замечания для «Доработать» (необязательно)…"
            rows={3}
            style={{ width: '100%', resize: 'vertical' }}
          />
        </div>

        <div className="gg-modal-footer">
          <button className="gg-btn gg-btn-danger" onClick={() => void resolve('reject')}>Отклонить</button>
          <button className="gg-btn" onClick={() => void resolve('revise')}>Доработать</button>
          <button className="gg-btn gg-btn-success" disabled={!plan || plan.quality?.status === 'block'} onClick={() => void resolve('approve')}>Одобрить</button>
        </div>
      </div>
    </div>
  )
}
