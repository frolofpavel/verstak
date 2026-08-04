import type { ViewId } from '../store/projectStore'

export type ScheduleTab = 'reminders' | 'scheduled'

/**
 * Задача 8: слитый раздел «Напоминания + Расписание» — какая вкладка открыта на входе.
 * `scheduler` (старый роут/уведомление автозадачи) → «Расписание»; всё остальное,
 * включая `reminders` (пункт меню, клик по напоминанию), → «Напоминания».
 */
export function initialScheduleTab(view: ViewId): ScheduleTab {
  return view === 'scheduler' ? 'scheduled' : 'reminders'
}
