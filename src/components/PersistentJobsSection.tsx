/**
 * Постоянные задачи — секция на экране «Расписание».
 *
 * Живёт здесь, а не отдельным пунктом меню: по смыслу это соседи (работа без
 * человека рядом), а в боковой панели уже семнадцать пунктов. Разница с
 * расписанием названа прямо в подписи — постоянная задача ПОМНИТ, чем кончилось
 * прошлое пробуждение, и продолжает с того места.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PersistentJobV1 } from '../../shared/contracts/persistent-job'

const READ_ERROR = 'Не удалось прочитать список задач.'

const STATUS_LABEL: Record<PersistentJobV1['status'], string> = {
  active: 'спит, ждёт своего часа',
  running: 'работает',
  paused: 'на паузе',
  done: 'закончена',
  failed: 'упала',
}

interface Props {
  projectPath: string | null
}

export function PersistentJobsSection({ projectPath }: Props) {
  const [jobs, setJobs] = useState<PersistentJobV1[]>([])
  const [limits, setLimits] = useState<{ maxRunsCap: number; minIntervalMinutes: number } | null>(null)
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [everyMinutes, setEveryMinutes] = useState(60)
  const [maxRuns, setMaxRuns] = useState(10)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Мост может отсутствовать: секция живёт ВНУТРИ экрана расписания, и её
  // падение утащило бы весь экран. Соседняя функция не имеет права ломать чужую.
  const api = () => (window.api as Partial<typeof window.api>).jobs

  const reloadRef = useRef<() => Promise<void>>(async () => {})
  const reload = useCallback(() => reloadRef.current(), [])

  useEffect(() => {
    setJobs([])
    setError(null)
    const jobsApi = api()
    if (!projectPath || !jobsApi) return

    let cancelled = false
    let inFlight = false
    const refresh = async () => {
      if (cancelled || inFlight) return
      inFlight = true
      try {
        const rows = await jobsApi.list(projectPath)
        if (!cancelled) {
          setJobs(rows)
          setError(current => current === READ_ERROR ? null : current)
        }
      } catch {
        if (!cancelled) setError(READ_ERROR)
      } finally {
        inFlight = false
      }
    }
    reloadRef.current = refresh
    void refresh()
    // Фоновое пробуждение меняет БД без действий в этой секции.
    // Медленный IPC не наслаиваем; ответ прошлого проекта не применяем.
    const timer = window.setInterval(() => { void refresh() }, 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [projectPath])

  useEffect(() => { void api()?.limits().then(setLimits).catch(() => {}) }, [])

  const create = async () => {
    const jobsApi = api()
    if (!projectPath || !jobsApi) return
    setBusy(true)
    setError(null)
    try {
      const res = await jobsApi.create({ projectPath, title, goal, everyMinutes, maxRuns })
      if ('error' in res) { setError(res.error); return }
      setTitle('')
      setGoal('')
      await reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gg-jobs">
      <h3 className="gg-jobs-title">Постоянные задачи</h3>
      <p className="gg-settings-hint" style={{ marginBottom: 12 }}>
        В отличие от расписания, постоянная задача помнит, чем кончилось прошлое пробуждение,
        и продолжает с того места. Просыпается, делает один шаг и снова засыпает.
        {limits && ` Не чаще ${limits.minIntervalMinutes} минут и не больше ${limits.maxRunsCap} запусков — предел обязателен.`}
      </p>

      <div className="gg-scheduler-form">
        <input
          className="gg-input"
          placeholder="Название, например «Утренняя сводка»"
          value={title}
          onChange={e => setTitle(e.target.value)}
        />
        <input
          className="gg-input"
          placeholder="Что делать: «проверить активные задачи и подготовить краткую сводку»"
          value={goal}
          onChange={e => setGoal(e.target.value)}
        />
        <label className="gg-jobs-field">
          Раз в
          <input
            className="gg-input gg-jobs-number"
            type="number"
            min={limits?.minIntervalMinutes ?? 5}
            value={everyMinutes}
            onChange={e => setEveryMinutes(Number(e.target.value))}
          />
          мин.
        </label>
        <label className="gg-jobs-field">
          Не больше
          <input
            className="gg-input gg-jobs-number"
            type="number"
            min={1}
            max={limits?.maxRunsCap ?? 100}
            value={maxRuns}
            onChange={e => setMaxRuns(Number(e.target.value))}
          />
          раз
        </label>
        <button
          type="button"
          className="gg-btn gg-btn-primary"
          disabled={busy || !projectPath || !title.trim() || !goal.trim()}
          onClick={() => void create()}
        >
          Завести задачу
        </button>
        {error && <div className="gg-scheduler-error">⚠ {error}</div>}
      </div>

      {jobs.length === 0 ? (
        <div className="gg-skills-empty">Постоянных задач пока нет.</div>
      ) : (
        <div className="gg-skills-list">
          {jobs.map(job => (
            <div key={job.id} className="gg-cap-row">
              <div className="gg-jobs-row">
                <span className="gg-cap-name">{job.title}</span>
                <span className="gg-cap-status">{STATUS_LABEL[job.status]}</span>
                <span className="gg-cap-owner">{job.runsDone} из {job.maxRuns}</span>
                <span className="gg-cap-owner">
                  {job.nextRunAt ? new Date(job.nextRunAt).toLocaleString('ru-RU') : 'без времени'}
                </span>
                <button
                  type="button"
                  className="gg-skill-action"
                  onClick={() => { const a = api(); if (a) void (job.status === 'paused' ? a.resume(job.id) : a.pause(job.id)).then(reload) }}
                >
                  {job.status === 'paused' ? 'Продолжить' : 'Пауза'}
                </button>
                <button
                  type="button"
                  className="gg-skill-action"
                  onClick={() => { const a = api(); if (a) void a.remove(job.id).then(reload) }}
                >
                  Удалить
                </button>
              </div>
              {job.lastResult && <div className="gg-jobs-result">{job.lastResult.slice(0, 300)}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
