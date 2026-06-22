import { ipcMain } from 'electron'
import type { Reminders, ReminderInput } from '../storage/reminders'
import type { ReminderService } from '../reminders-service'

export function registerRemindersIpc(reminders: Reminders, service: ReminderService): void {
  ipcMain.handle('reminders:list', (_e, projectPath: string, limit?: number) =>
    reminders.list(projectPath, limit)
  )
  ipcMain.handle('reminders:create', (_e, input: ReminderInput) => {
    if (!input.projectPath?.trim()) throw new Error('projectPath is required')
    if (!input.title?.trim()) throw new Error('title is required')
    if (!Number.isFinite(input.dueAt)) throw new Error('dueAt is invalid')
    if (input.target === 'chat' && !input.chatId) throw new Error('chatId is required')
    const reminder = reminders.create(input)
    if (reminder.dueAt <= Date.now()) service.processDueNow()
    else service.reschedule()
    return reminder
  })
  ipcMain.handle('reminders:snooze', (_e, id: number, minutes = 10) => {
    const reminder = reminders.snooze(id, Date.now() + Math.max(1, minutes) * 60_000)
    service.reschedule()
    return reminder
  })
  ipcMain.handle('reminders:dismiss', (_e, id: number) => {
    const reminder = reminders.dismiss(id)
    service.reschedule()
    return reminder
  })
  ipcMain.handle('reminders:remove', (_e, id: number) => {
    reminders.remove(id)
    service.reschedule()
  })
}
