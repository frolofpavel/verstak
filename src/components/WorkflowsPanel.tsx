import { useEffect, useState } from 'react'
import { useProject } from '../store/projectStore'
import type { WorkflowSummary } from '../types/api'

/**
 * WorkflowsPanel — каталог-лаунчер Agency Workflows.
 *
 * Показывает карточки готовых workflow'ов (id/name/description/N шагов). У каждой
 * — поле для брифа и кнопка «Запустить»: вызывает window.api.workflows.start,
 * получает готовый промпт + детерминированно созданный план, инжектит промпт в
 * композер основного чата (через gg-inject-prompt, как DesignView) и переключает
 * на вкладку Chat. Сам прогон стартует штатным send — core chat flow не трогаем.
 *
 * Это другой компонент, чем WorkflowView (read-only история пайплайнов): здесь
 * запуск, там — визуализация уже идущих/завершённых планов. Запущенный workflow
 * создаёт план → он появляется в WorkflowView ниже. Синергия.
 */

function WorkflowCard({ wf, onLaunch, onDelete }: { wf: WorkflowSummary; onLaunch: (id: string, brief: string) => Promise<void>; onDelete: (userId: number) => Promise<void> }) {
  const [brief, setBrief] = useState('')
  const [busy, setBusy] = useState(false)

  async function launch() {
    if (busy) return
    setBusy(true)
    try {
      await onLaunch(wf.id, brief)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gg-wfcat-card">
      <div className="gg-wfcat-card-head">
        <span className="gg-wfcat-card-icon">{wf.icon ?? '⚙️'}</span>
        <span className="gg-wfcat-card-title">{wf.name}</span>
        {/* Задача 7A: пользовательские workflow (сохранённые из прогона) помечены и удаляемы. */}
        {wf.source === 'user' && <span className="gg-wfcat-card-badge">мой</span>}
        <span className="gg-wfcat-card-steps">{wf.stepCount} шагов</span>
      </div>
      <div className="gg-wfcat-card-desc">{wf.description}</div>
      <textarea
        className="gg-input gg-wfcat-brief"
        placeholder={wf.source === 'user' ? 'Бриф (необязательно) — уточни детали под этот запуск…' : 'Бриф клиента: ниша, продукт, аудитория, гео, цель аудита…'}
        value={brief}
        onChange={e => setBrief(e.target.value)}
        rows={3}
      />
      <div className="gg-wfcat-card-actions">
        <button className="gg-btn gg-btn-primary" onClick={() => void launch()} disabled={busy}>
          {busy ? 'Запуск…' : '▶ Запустить'}
        </button>
        {wf.source === 'user' && wf.userId != null && (
          <button className="gg-btn gg-btn-ghost" onClick={() => void onDelete(wf.userId!)} title="Удалить сохранённый workflow">Удалить</button>
        )}
      </div>
    </div>
  )
}

export function WorkflowsPanel() {
  const path = useProject(s => s.path)
  const setActiveView = useProject(s => s.setActiveView)
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([])

  const refresh = () => window.api.workflows.list()
    .then(setWorkflows)
    .catch(() => { /* IPC может быть недоступен в dev — каталог пустой */ })

  useEffect(() => { void refresh() }, [path])

  async function remove(userId: number) {
    await window.api.workflows.removeUser(userId).catch(() => {})
    await refresh()
  }

  async function launch(workflowId: string, brief: string) {
    if (!path) return
    const res = await window.api.workflows.start(workflowId, path, brief)
    if ('error' in res) return
    // Инжектим готовый промпт в композер чата и переходим в чат — пользователь
    // видит заполненный промпт и отправляет его штатным send (core flow не трогаем).
    window.dispatchEvent(new CustomEvent('gg-inject-prompt', { detail: res.prompt }))
    setActiveView('chat')
  }

  if (!path) {
    return (
      <div className="gg-wfcat">
        <div className="gg-panel-empty">Открой проект чтобы запускать workflow'ы</div>
      </div>
    )
  }

  return (
    <div className="gg-wfcat">
      <div className="gg-wfcat-head">
        <h2 className="gg-wfcat-title">Agency Workflows</h2>
        <p className="gg-wfcat-subtitle">Готовые сценарии агентства + ваши сохранённые прогоны. Заполни бриф и запусти — агент пройдёт все шаги и соберёт итог. Свой workflow сохраняется из прогона в «Истории работы» кнопкой «В workflow».</p>
      </div>
      {workflows.length === 0 && <div className="gg-panel-empty">Каталог workflow'ов пуст.</div>}
      <div className="gg-wfcat-grid">
        {workflows.map(wf => <WorkflowCard key={wf.id} wf={wf} onLaunch={launch} onDelete={remove} />)}
      </div>
    </div>
  )
}
