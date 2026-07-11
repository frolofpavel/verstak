import { useEffect, useState } from 'react'
import { useProject } from '../store/projectStore'
import type { ScheduledTask, SchedulerHealth } from '../types/api'
import { SCHEDULER_PRESETS, buildScheduledFixPrompt } from '../lib/scheduler-presets'

function formatAge(ms: number | null): string {
  if (ms == null) return 'нет heartbeat'
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds} сек назад`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes} мин назад`
  const hours = Math.floor(minutes / 60)
  return `${hours} ч ${minutes % 60} мин назад`
}

/**
 * NL-cron (флагман) — вкладка расписаний. Создание задачи на естественном языке
 * («каждое утро», «по будням в 8»), список с тумблером/запуском/удалением. Прогон
 * идёт без UI и пушит итог в Telegram (если настроен). Только исходящая автоматизация.
 */
export function ScheduledTasksView() {
  const projectPath = useProject(s => s.path)
  const setActiveView = useProject(s => s.setActiveView)
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [nl, setNl] = useState('')
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [health, setHealth] = useState<SchedulerHealth | null>(null)

  async function load() {
    if (!projectPath) { setTasks([]); setHealth(null); return }
    try {
      const [nextTasks, nextHealth] = await Promise.all([
        window.api.scheduler.list(projectPath),
        window.api.scheduler.health(),
      ])
      setTasks(nextTasks)
      setHealth(nextHealth)
    } catch { /* ignore */ }
  }
  useEffect(() => { void load() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [projectPath])

  async function create() {
    if (!projectPath || !nl.trim() || !prompt.trim()) return
    setBusy(true); setError(null)
    try {
      const res = await window.api.scheduler.create({ projectPath, prompt: prompt.trim(), nl: nl.trim() })
      if (res.error) { setError(res.error); return }
      setNl(''); setPrompt(''); await load()
    } finally { setBusy(false) }
  }

  // Мост «дозор → контролируемый фикс» (1.9.9 срез 2): находка read-only прогона →
  // засев в композер основного чата + переключение на chat. Фикс идёт под контролем.
  function fixInChat(task: ScheduledTask) {
    window.dispatchEvent(new CustomEvent('gg-inject-prompt', { detail: buildScheduledFixPrompt(task) }))
    setActiveView('chat')
  }

  if (!projectPath) {
    return <div className="gg-view-pad gg-text-tertiary">Открой проект, чтобы настроить расписание.</div>
  }

  return (
    <div className="gg-view-pad gg-scheduler">
      <h2 className="gg-view-title">🕒 Расписание</h2>
      <p className="gg-settings-hint" style={{ marginBottom: 16 }}>
        Задачи выполняются по расписанию без вашего участия (читают код/коннекторы, НЕ пишут).
        Итог приходит в Telegram, если настроены уведомления. Только исходящая автоматизация.
      </p>

      {health && (
        <div className={`gg-scheduler-health ${health.stalled ? 'is-stalled' : ''}`}>
          {health.stalled ? '⚠ Планировщик застрял' : '✓ Планировщик работает'}
          <span>{formatAge(health.heartbeatAgeMs)}</span>
        </div>
      )}

      <div className="gg-scheduler-presets">
        <div className="gg-scheduler-presets-label">AI-дежурный — готовые сценарии:</div>
        <div className="gg-scheduler-presets-chips">
          {SCHEDULER_PRESETS.map(p => (
            <button
              key={p.id}
              type="button"
              className="gg-scheduler-preset-chip"
              title={p.hint}
              onClick={() => { setNl(p.nl); setPrompt(p.prompt); setError(null) }}
            >
              <span className="gg-scheduler-preset-icon">{p.icon}</span> {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="gg-scheduler-form">
        <input
          className="gg-input"
          placeholder="Когда? напр. «каждое утро», «по будням в 8», «каждые 2 часа»"
          value={nl}
          onChange={e => setNl(e.target.value)}
        />
        <textarea
          className="gg-input"
          placeholder="Что сделать? напр. «проверь новые заказы Ozon за вчера и дай краткую сводку»"
          value={prompt}
          rows={2}
          onChange={e => setPrompt(e.target.value)}
        />
        <button className="gg-btn gg-btn-primary" disabled={busy || !nl.trim() || !prompt.trim()} onClick={() => void create()}>
          Добавить расписание
        </button>
        {error && <div className="gg-scheduler-error">⚠ {error}</div>}
      </div>

      <div className="gg-scheduler-list">
        {tasks.length === 0 && <div className="gg-text-tertiary" style={{ padding: '12px 0' }}>Пока нет расписаний.</div>}
        {tasks.map(t => (
          <div key={t.id} className={`gg-scheduler-item ${t.enabled ? '' : 'is-off'}`}>
            <div className="gg-scheduler-item-main">
              <div className="gg-scheduler-when">{t.human || t.cron}</div>
              <div className="gg-scheduler-prompt">{t.prompt}</div>
              {t.last_run_at && (
                <div className="gg-scheduler-last">
                  {t.last_status === 'error' ? '⚠ ошибка' : '✓'} последний запуск: {new Date(t.last_run_at).toLocaleString('ru-RU')}
                </div>
              )}
              {t.last_result && t.last_result.trim() && (
                <div className="gg-scheduler-finding">
                  <div className="gg-scheduler-finding-text">{t.last_result.trim()}</div>
                  <button
                    type="button"
                    className="gg-btn gg-btn-primary gg-btn-sm gg-scheduler-fix"
                    title="Разобрать находку в чате — под вашим контролем, с подтверждением правок"
                    onClick={() => fixInChat(t)}
                  >
                    🩹 Починить в чате
                  </button>
                </div>
              )}
              {t.next_run_at && (
                <div className="gg-scheduler-last">
                  следующий слот: {new Date(t.next_run_at).toLocaleString('ru-RU')}
                </div>
              )}
            </div>
            <div className="gg-scheduler-actions">
              <label className="gg-scheduler-toggle" title={t.enabled ? 'Выключить' : 'Включить'}>
                <input
                  type="checkbox"
                  checked={t.enabled}
                  onChange={async () => { await window.api.scheduler.toggle(t.id, !t.enabled); await load() }}
                />
              </label>
              <button className="gg-btn gg-btn-ghost gg-btn-sm" title="Запустить сейчас"
                onClick={async () => { await window.api.scheduler.runNow(t.id); await load() }}>▶</button>
              <button className="gg-btn gg-btn-ghost gg-btn-sm" title="Удалить"
                onClick={async () => { await window.api.scheduler.remove(t.id); await load() }}>🗑</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
