import type { TaskContractV1 } from '../types/api'

interface TaskContractReviewProps {
  contract: TaskContractV1
  onApprove: () => void
  onRefine: () => void
  onEdit: () => void
}

function List({ items, empty = '—' }: { items: string[]; empty?: string }) {
  if (items.length === 0) return <div className="gg-text-tertiary">{empty}</div>
  return <ul className="gg-outcome-list">{items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul>
}

export function TaskContractReview({ contract, onApprove, onRefine, onEdit }: TaskContractReviewProps) {
  const blocked = contract.blockingQuestions.length > 0
  return (
    <div className="gg-modal-backdrop">
      <div className="gg-modal gg-task-contract-review" role="dialog" aria-modal="true" aria-labelledby="gg-task-contract-title">
        <div className="gg-modal-header">
          <div>
            <div className="gg-modal-title" id="gg-task-contract-title">Что именно должен сделать Verstak</div>
            <div className="gg-text-tertiary">Task Contract · revision {contract.revision} · {contract.planningMode}</div>
          </div>
        </div>
        <div className="gg-modal-body gg-task-contract-body">
          <section>
            <h3>Исходная задача</h3>
            <div className="gg-outcome-raw">{contract.rawRequest}</div>
          </section>
          <section>
            <h3>Уточнённый результат</h3>
            <div>{contract.goal}</div>
          </section>
          <section>
            <h3>Готово, когда</h3>
            <List items={contract.successCriteria.map(item => `${item.text} · ${item.evidence}${item.verify ? ` · ${item.verify}` : ''}`)} />
          </section>
          <div className="gg-outcome-columns">
            <section><h3>Границы</h3><List items={contract.constraints} /></section>
            <section><h3>Не входит</h3><List items={contract.nonGoals} /></section>
          </div>
          <section>
            <h3>Что прочитано в проекте</h3>
            <List items={contract.repoEvidence.map(item => `${item.path}${item.symbol ? ` → ${item.symbol}` : ''}: ${item.why}`)} />
          </section>
          {contract.assumptions.length > 0 && (
            <section><h3>Допущения</h3><List items={contract.assumptions.map(item => `[${item.status}] ${item.text}`)} /></section>
          )}
          {blocked && (
            <section className="gg-outcome-blocked">
              <h3>Нужно уточнить до плана</h3>
              <List items={contract.blockingQuestions} />
            </section>
          )}
          <div className="gg-outcome-risk">Риск: <strong>{contract.risk}</strong></div>
        </div>
        <div className="gg-modal-footer">
          <button type="button" className="gg-btn" onClick={onEdit}>Изменить задачу</button>
          <button type="button" className="gg-btn" onClick={onRefine}>Доработать контракт</button>
          <span className="gg-modal-footer-spacer" />
          <button type="button" className="gg-btn gg-btn-primary" disabled={blocked} onClick={onApprove}>
            {blocked ? 'Сначала ответьте на вопросы' : 'Одобрить и построить план'}
          </button>
        </div>
      </div>
    </div>
  )
}
