import { useEffect, useState } from 'react'
import { useProject } from '../store/projectStore'
import type { Plan, PlanStep, StepStatus, ChatMessage } from '../types/api'

const STEP_LABEL: Record<StepStatus, string> = {
  pending: 'ждёт',
  running: 'выполняется',
  done: 'готово',
  skipped: 'пропущено',
  failed: 'ошибка'
}

const STEP_COLOR: Record<StepStatus, string> = {
  pending: 'var(--text-tertiary)',
  running: 'var(--accent)',
  done: 'var(--success)',
  skipped: 'var(--text-disabled)',
  failed: 'var(--error)'
}

export function PlanView() {
  const { path, setActiveView, addMessage, setStreaming, setRunningPlanStep, runningPlanStep, isStreaming } = useProject()
  const [plans, setPlans] = useState<Plan[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [composer, setComposer] = useState<{ title: string; rawSteps: string }>({ title: '', rawSteps: '' })

  async function refresh() {
    if (!path) return
    const list = await window.api.plans.list(path)
    setPlans(list)
    if (list.length > 0 && (activeId === null || !list.some(p => p.id === activeId))) {
      setActiveId(list[0].id)
    }
  }

  useEffect(() => { void refresh() }, [path])

  if (!path) {
    return (
      <div className="gg-panel">
        <div className="gg-panel-empty" style={{ marginTop: 80 }}>Открой проект чтобы видеть планы</div>
      </div>
    )
  }

  async function createPlan() {
    const title = composer.title.trim()
    if (!title) return
    const steps = composer.rawSteps.split('\n').map(s => s.trim()).filter(Boolean).map(s => ({ title: s }))
    if (steps.length === 0) return
    await window.api.plans.create(path!, title, steps)
    setComposer({ title: '', rawSteps: '' })
    await refresh()
  }

  async function toggleStep(step: PlanStep) {
    const next: StepStatus = step.status === 'done' ? 'pending' : 'done'
    await window.api.plans.updateStep(step.id, { status: next })
    await refresh()
  }

  async function removePlan(id: number) {
    if (!window.confirm('Удалить план?')) return
    await window.api.plans.remove(id)
    await refresh()
  }

  /** Polls store until the current runningPlanStep is cleared (i.e. AI emitted 'done'). */
  function waitForStepCompletion(stepId: number): Promise<void> {
    return new Promise(resolve => {
      const tick = () => {
        const running = useProject.getState().runningPlanStep
        const streaming = useProject.getState().isStreaming
        if (running?.stepId !== stepId && !streaming) { resolve(); return }
        setTimeout(tick, 400)
      }
      tick()
    })
  }

  async function runAll(plan: Plan) {
    if (!path || isStreaming) return
    // Snapshot the pending steps in order so we don't re-pick a step that was just done
    const queue = plan.steps.filter(s => s.status === 'pending' || s.status === 'failed').map(s => s.id)
    for (const stepId of queue) {
      // Re-fetch the latest plan in case user manually toggled something
      const fresh = await window.api.plans.get(plan.id)
      if (!fresh) break
      const step = fresh.steps.find(s => s.id === stepId)
      if (!step) continue
      if (step.status !== 'pending' && step.status !== 'failed') continue
      await runStep(fresh, step)
      await waitForStepCompletion(stepId)
      await refresh()
      // Abort if user cancelled or step failed
      const updated = await window.api.plans.get(plan.id)
      const final = updated?.steps.find(s => s.id === stepId)
      if (!final || final.status === 'failed') break
    }
  }

  async function runStep(plan: Plan, step: PlanStep) {
    if (!path || isStreaming) return
    // 1) DB: mark step running
    await window.api.plans.updateStep(step.id, { status: 'running', result: null })
    // 2) Store: remember which step is being executed so Chat can finalize on 'done'
    setRunningPlanStep({ planId: plan.id, stepId: step.id, title: step.title })
    // 3) Build a focused prompt and send via the regular AI pipeline
    const remaining = plan.steps.filter(s => s.status !== 'done').slice(0, 4).map((s, i) => `${i + 1}. ${s.title}`).join('\n')
    const prompt = `Выполни ОДИН шаг плана и больше ничего.

ПЛАН: ${plan.title}
ТЕКУЩИЙ ШАГ: ${step.title}${step.detail ? `\nДЕТАЛИ: ${step.detail}` : ''}

Соседние ещё не выполненные шаги (для контекста, НЕ выполнять):
${remaining || '— нет —'}

Когда шаг готов — кратко напиши результат (что сделано, какие файлы тронуты). Не лезь в следующие шаги.`
    addMessage({ role: 'user', content: prompt })
    const activeChatId = useProject.getState().activeChatId
    if (path && activeChatId) await window.api.chats.append(activeChatId, path, 'user', prompt)
    addMessage({ role: 'assistant', content: '' })
    setStreaming(true)
    setActiveView('chat')
    const allMessages = [...useProject.getState().messages].slice(0, -1) as ChatMessage[]
    await window.api.ai.send(allMessages, path)
    // refresh on next paint cycle so user sees the step go to 'running'
    void refresh()
  }

  const active = plans.find(p => p.id === activeId) ?? null
  const doneCount = active?.steps.filter(s => s.status === 'done').length ?? 0
  const totalCount = active?.steps.length ?? 0

  return (
    <div className="gg-panel">
      <div className="gg-panel-header">
        <h2 className="gg-panel-title">Планы</h2>
        <div className="gg-panel-meta">{plans.length} плана(ов)</div>
      </div>

      <div className="gg-panel-body">
        <div className="gg-plan-compose">
          <input
            className="gg-input"
            placeholder="Название плана"
            value={composer.title}
            onChange={e => setComposer(c => ({ ...c, title: e.target.value }))}
          />
          <textarea
            className="gg-input gg-plan-steps-textarea"
            placeholder="Шаги, по одному на строку"
            value={composer.rawSteps}
            rows={3}
            onChange={e => setComposer(c => ({ ...c, rawSteps: e.target.value }))}
          />
          <button
            className="gg-btn gg-btn-primary"
            onClick={() => void createPlan()}
            disabled={!composer.title.trim() || !composer.rawSteps.trim()}
            style={{ alignSelf: 'flex-end' }}
          >
            Создать план
          </button>
        </div>

        {plans.length === 0 && (
          <div className="gg-panel-empty">
            Планов ещё нет. Создай первый сверху или попроси AI: «составь план для X».
          </div>
        )}

        {plans.length > 0 && (
          <div className="gg-plan-layout">
            <div className="gg-plan-list">
              {plans.map(p => (
                <button
                  key={p.id}
                  className={`gg-plan-list-item ${activeId === p.id ? 'is-active' : ''}`}
                  onClick={() => setActiveId(p.id)}
                >
                  <div className="gg-plan-list-title">{p.title}</div>
                  <div className="gg-plan-list-meta">
                    {p.steps.filter(s => s.status === 'done').length} / {p.steps.length}
                    {' · '}
                    {p.status}
                  </div>
                </button>
              ))}
            </div>

            {active && (
              <div className="gg-plan-detail">
                <div className="gg-plan-detail-header">
                  <div className="gg-plan-detail-title">{active.title}</div>
                  <div className="gg-plan-detail-meta">
                    {doneCount} / {totalCount} шагов · {active.status}
                  </div>
                  {active.steps.some(s => s.status === 'pending' || s.status === 'failed') && (
                    <button
                      className="gg-btn gg-btn-primary"
                      onClick={() => void runAll(active)}
                      disabled={isStreaming}
                      title="Запустить все pending-шаги по очереди"
                    >
                      ▶▶ Все шаги
                    </button>
                  )}
                  <button className="gg-btn gg-btn-ghost gg-btn-danger" onClick={() => void removePlan(active.id)}>Удалить</button>
                </div>
                <div className="gg-plan-steps">
                  {active.steps.map(step => {
                    const isRunningThisOne = runningPlanStep?.stepId === step.id
                    const canRun = step.status === 'pending' || step.status === 'failed'
                    return (
                      <div key={step.id} className={`gg-plan-step is-${step.status}`}>
                        <button
                          className={`gg-task-check ${step.status === 'done' ? 'is-done' : ''}`}
                          onClick={() => void toggleStep(step)}
                          title={STEP_LABEL[step.status]}
                        >
                          {step.status === 'done' ? '✓' : ''}
                        </button>
                        <div className="gg-plan-step-body">
                          <div className="gg-plan-step-title">{step.title}</div>
                          {step.detail && <div className="gg-plan-step-detail">{step.detail}</div>}
                          {step.result && <div className="gg-plan-step-result">{step.result}</div>}
                        </div>
                        <div className="gg-plan-step-actions">
                          {canRun && (
                            <button
                              className="gg-btn gg-btn-primary gg-plan-step-run"
                              onClick={() => void runStep(active, step)}
                              disabled={isStreaming}
                              title="Выполнить этот шаг через AI"
                            >
                              ▶ Запустить
                            </button>
                          )}
                          <div className="gg-plan-step-status" style={{ color: STEP_COLOR[step.status] }}>
                            {isRunningThisOne ? 'выполняется…' : STEP_LABEL[step.status]}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
