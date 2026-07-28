import { useEffect, useState } from 'react'
import { useProject } from '../store/projectStore'
import { useActiveChatField } from '../hooks/useActiveChatBundle'
import type { Plan } from '../types/api'

/**
 * #3 plan-gate: модалка одобрения плана. Агент в режиме планирования предложил
 * план и БЛОКИРОВАН до решения — Одобрить (→ выполнение) / Доработать (с
 * замечаниями) / Отклонить. «Высокий контроль»: человек одобряет план ДО старта.
 */
export function PlanConfirm() {
  // §10 хвост (дефект 4): карточка берётся из bundle АКТИВНОГО чата, а не из
  // одной глобальной ячейки. Отсюда и главное свойство: решение принимается в
  // том же чате, где висела карточка, и продолжение уезжает туда же.
  const pendingPlan = useActiveChatField('pendingPlan') ?? null
  const setPendingPlan = useProject(s => s.setPendingPlan)
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
    // §10: прогон, показавший карточку, уже завершён — резолвить внутри него
    // нечего. Решение идёт в БД, а работа продолжается отдельной отправкой с
    // якорем на чекпойнт того прогона (историю заново не пересобираем).
    const outcome = await window.api.plans.resolveApproval(ref.planId, decision, feedback.trim() || undefined)
    const store = useProject.getState()
    if (decision === 'approve' && store.activePipeline?.step === 'plan') {
      // Pipeline ведёт своё продолжение сам (execute-промпт из брифа) — второй
      // отправкой мы бы запустили тот же шаг дважды.
      await store.advancePipeline({ step: 'execute', planId: ref.planId })
      window.dispatchEvent(new CustomEvent('gg-pipeline-plan-approved'))
    } else if (outcome?.continuation) {
      // Режим едет вместе с продолжением: чат применит его и дождётся, прежде
      // чем отправлять (иначе одобренный план переспросит на первой же записи).
      window.dispatchEvent(new CustomEvent('gg-resume-send', {
        detail: {
          text: outcome.continuation.text,
          ...(outcome.continuation.resumeFromRunId ? { resumeFromRunId: outcome.continuation.resumeFromRunId } : {}),
          ...(outcome.continuation.agentMode ? { agentMode: outcome.continuation.agentMode } : {}),
        },
      }))
    }
    setPendingPlan(null)
    setFeedback('')
  }

  return (
    // §10 хвост (дефект 3): фон РЕШЕНИЯ НЕ ПРИНИМАЕТ. Раньше клик мимо окна шёл
    // как reject, а reject — это отмена плана и удаление чекпойнта прогона:
    // промах мышью необратимо убивал продолжение. Отказ остался только на
    // явной кнопке; закрыть карточку, ничего не решив, нельзя — решение по ней
    // всё равно нужно, а «спрятать и забыть» удерживало бы чекпойнт молча.
    <div className="gg-modal-backdrop">
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
