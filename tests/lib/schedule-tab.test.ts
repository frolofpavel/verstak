import { describe, it, expect } from 'vitest'
import { initialScheduleTab } from '../../src/lib/schedule-tab'

// Задача 8: «Напоминания» и «Расписание» слиты в один раздел с двумя вкладками.
// Стартовая вкладка зависит от того, каким view пришли: клик по пункту меню
// (reminders) → «Напоминания»; уведомление/старый роут scheduler → «Расписание».
describe('initialScheduleTab — стартовая вкладка слитого раздела', () => {
  it('scheduler → вкладка расписания', () => {
    expect(initialScheduleTab('scheduler')).toBe('scheduled')
  })
  it('reminders → вкладка напоминаний', () => {
    expect(initialScheduleTab('reminders')).toBe('reminders')
  })
  it('любой другой view → напоминания (безопасный дефолт)', () => {
    expect(initialScheduleTab('chat')).toBe('reminders')
  })
})
