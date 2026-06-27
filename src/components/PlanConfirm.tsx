import { useState } from 'react'
import { useProject } from '../store/projectStore'

/**
 * #3 plan-gate: модалка одобрения плана. Агент в режиме планирования предложил
 * план и БЛОКИРОВАН до решения — Одобрить (→ выполнение) / Доработать (с
 * замечаниями) / Отклонить. «Высокий контроль»: человек одобряет план ДО старта.
 */
export function PlanConfirm() {
  const { pendingPlan, setPendingPlan } = useProject()
  const [feedback, setFeedback] = useState('')
  if (!pendingPlan) return null
  const ref = pendingPlan

  async function resolve(decision: 'approve' | 'revise' | 'reject') {
    await window.api.ai.resolvePlan(ref.callId, decision, feedback.trim() || undefined, ref.sendId)
    setPendingPlan(null)
    setFeedback('')
  }

  return (
    <div className="gg-modal-backdrop" onClick={() => void resolve('reject')}>
      <div className="gg-modal" onClick={e => e.stopPropagation()}>
        <div className="gg-modal-header">
          <div>
            <div className="gg-modal-title">📋 План на одобрение</div>
            <div className="gg-text-tertiary" style={{ fontSize: 'var(--text-xs)', marginTop: 4 }}>
              «{ref.title}» — {ref.stepCount} шаг(ов). Одобрить выполнение, отправить на доработку или отклонить?
            </div>
          </div>
        </div>

        <div className="gg-modal-body" style={{ padding: '16px 22px' }}>
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
          <button className="gg-btn gg-btn-success" onClick={() => void resolve('approve')}>Одобрить</button>
        </div>
      </div>
    </div>
  )
}
