import { useEffect, useState } from 'react'
import { useProject } from '../store/projectStore'
import { RemindersView } from './RemindersView'
import { ScheduledTasksView } from './ScheduledTasksView'
import { initialScheduleTab, type ScheduleTab } from '../lib/schedule-tab'

/**
 * Задача 8: единый раздел «Напоминания + Расписание» — две вкладки вместо двух
 * пунктов меню. «Напоминания» (заметки со временем) и «Расписание» (NL-cron
 * автозадачи) — обе про время, пользователю ни к чему два соседних пункта.
 * Стартовая вкладка зависит от того, каким view вошли (клик по пункту меню
 * `reminders` → напоминания; уведомление автозадачи / старый роут `scheduler`
 * → расписание), и переключается, если view сменился, пока раздел смонтирован.
 */
export function ScheduleView() {
  const activeView = useProject(s => s.activeView)
  const [tab, setTab] = useState<ScheduleTab>(() => initialScheduleTab(activeView))

  useEffect(() => {
    if (activeView === 'scheduler' || activeView === 'reminders') {
      setTab(initialScheduleTab(activeView))
    }
  }, [activeView])

  return (
    <div className="gg-schedule-view">
      <div className="gg-schedule-tabbar" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'reminders'}
          className={`gg-run-tab ${tab === 'reminders' ? 'is-active' : ''}`}
          onClick={() => setTab('reminders')}
        >Напоминания</button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'scheduled'}
          className={`gg-run-tab ${tab === 'scheduled' ? 'is-active' : ''}`}
          onClick={() => setTab('scheduled')}
        >Расписание</button>
      </div>
      <div className="gg-schedule-body">
        {tab === 'reminders' ? <RemindersView /> : <ScheduledTasksView />}
      </div>
    </div>
  )
}
