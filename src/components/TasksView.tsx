import { useEffect, useState } from 'react'
import { useProject } from '../store/projectStore'
import type { Task } from '../types/api'

export function TasksView() {
  const { path } = useProject()
  const [tasks, setTasks] = useState<Task[]>([])
  const [input, setInput] = useState('')

  async function refresh() {
    if (!path) return
    const list = await window.api.tasks.list(path)
    setTasks(list)
  }

  useEffect(() => { void refresh() }, [path])

  if (!path) return <EmptyState text="Открой проект чтобы видеть чек-лист" />

  async function add() {
    const text = input.trim()
    if (!text) return
    setInput('')
    await window.api.tasks.add(path!, text)
    await refresh()
  }

  async function toggle(id: number, done: boolean) {
    await window.api.tasks.toggle(id, done)
    await refresh()
  }

  async function remove(id: number) {
    await window.api.tasks.remove(id)
    await refresh()
  }

  async function clearDone() {
    await window.api.tasks.clearDone(path!)
    await refresh()
  }

  const open = tasks.filter(t => !t.done)
  const done = tasks.filter(t => t.done)

  return (
    <div className="gg-panel">
      <div className="gg-panel-header">
        <h2 className="gg-panel-title">Чеклист</h2>
        <div className="gg-panel-meta">
          {open.length} открытых · {done.length} закрытых
        </div>
      </div>

      <div className="gg-panel-body">
        <div className="gg-task-add">
          <input
            className="gg-input"
            placeholder="Новая задача — Enter чтобы добавить"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void add() }}
          />
          <button className="gg-btn gg-btn-primary" onClick={() => void add()} disabled={!input.trim()}>
            Добавить
          </button>
        </div>

        {tasks.length === 0 && (
          <div className="gg-panel-empty">Пунктов ещё нет. Добавь первый — что нужно сделать в проекте.</div>
        )}

        {open.length > 0 && (
          <div className="gg-task-list">
            {open.map(t => <TaskRow key={t.id} task={t} onToggle={toggle} onRemove={remove} />)}
          </div>
        )}

        {done.length > 0 && (
          <div className="gg-task-section">
            <div className="gg-task-section-head">
              <span>Закрыто</span>
              <button className="gg-btn gg-btn-ghost" onClick={() => void clearDone()}>Очистить</button>
            </div>
            <div className="gg-task-list is-done">
              {done.map(t => <TaskRow key={t.id} task={t} onToggle={toggle} onRemove={remove} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function TaskRow({ task, onToggle, onRemove }: { task: Task; onToggle: (id: number, done: boolean) => Promise<void>; onRemove: (id: number) => Promise<void> }) {
  return (
    <div className={`gg-task-row ${task.done ? 'is-done' : ''}`}>
      <button
        className={`gg-task-check ${task.done ? 'is-done' : ''}`}
        onClick={() => { void onToggle(task.id, !task.done) }}
        title={task.done ? 'Открыть' : 'Закрыть'}
      >
        {task.done ? '✓' : ''}
      </button>
      <span className="gg-task-text">{task.text}</span>
      <button className="gg-task-remove" onClick={() => { void onRemove(task.id) }} title="Удалить">×</button>
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="gg-panel">
      <div className="gg-panel-empty" style={{ marginTop: 80 }}>{text}</div>
    </div>
  )
}
