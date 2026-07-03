import type { BrowserWindow } from 'electron'
import type { Reminders, Reminder } from './storage/reminders'
import type { Chats } from './storage/chats'
import type { ChatSessions } from './storage/chat-sessions'
import { showAppToast } from './notification-window'
import type { Settings } from './storage/settings'

const MAX_TIMEOUT = 2_147_483_647
const SNOOZE_MS = 10 * 60 * 1000
const CHAT_DELIVERY_RETRY_MS = 10_000

function readTheme(settings: Settings): 'nord' | 'light' {
  return settings.getSecret('theme') === 'light' ? 'light' : 'nord'
}

function projectName(projectPath: string): string {
  return projectPath.replace(/^.*[\\/]/, '') || projectPath
}

function reminderChatText(reminder: Reminder): string {
  return [
    `⏰ Напоминание: ${reminder.title}`,
    reminder.body?.trim() ? reminder.body.trim() : null,
    `Назначено на: ${new Date(reminder.dueAt).toLocaleString()}`
  ].filter(Boolean).join('\n')
}

function reminderUserText(reminder: Reminder): string {
  return [
    reminder.title.trim(),
    reminder.body?.trim() ? reminder.body.trim() : null
  ].filter(Boolean).join('\n\n')
}

export function createReminderService(opts: {
  reminders: Reminders
  chats: Chats
  chatSessions: ChatSessions
  settings: Settings
  getMainWindow: () => BrowserWindow | null
}) {
  let timer: ReturnType<typeof setTimeout> | null = null
  const chatDeliveryRetries = new Map<number, ReturnType<typeof setTimeout>>()

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const clearChatRetry = (id: number) => {
    const retry = chatDeliveryRetries.get(id)
    if (retry) clearTimeout(retry)
    chatDeliveryRetries.delete(id)
  }

  const scheduleChatRetry = (id: number) => {
    clearChatRetry(id)
    chatDeliveryRetries.set(id, setTimeout(() => {
      chatDeliveryRetries.delete(id)
      void processDue()
    }, CHAT_DELIVERY_RETRY_MS))
  }

  const schedule = () => {
    clear()
    const next = opts.reminders.nextPendingAfter()
    if (!next) return
    const delay = Math.max(500, Math.min(MAX_TIMEOUT, next.dueAt - Date.now()))
    timer = setTimeout(() => {
      void processDue()
    }, delay)
  }

  const showReminder = (reminder: Reminder) => {
    showAppToast({
      title: `Напоминание: ${reminder.title}`,
      body: reminder.body || 'Назначенное напоминание сработало.',
      projectName: projectName(reminder.projectPath),
      projectPath: reminder.projectPath,
      reminderId: reminder.id,
      persistent: true,
      theme: readTheme(opts.settings)
    })
  }

  const deliverChat = (reminder: Reminder) => {
    if (chatDeliveryRetries.has(reminder.id)) return
    if (!reminder.chatId) {
      showReminder(reminder)
      return
    }
    const session = opts.chatSessions.get(reminder.chatId)
    if (!session || session.projectPath !== reminder.projectPath) {
      showReminder(reminder)
      return
    }
    const main = opts.getMainWindow()
    if (!main || main.isDestroyed()) {
      showReminder(reminder)
      return
    }
    main.webContents.send('notify:send-chat-reminder', {
      reminderId: reminder.id,
      projectPath: reminder.projectPath,
      chatId: reminder.chatId,
      text: reminderUserText(reminder)
    })
    scheduleChatRetry(reminder.id)
  }

  const processDue = async () => {
    const due = opts.reminders.due()
    for (const reminder of due) {
      if (reminder.target === 'chat') {
        deliverChat(reminder)
      } else {
        showReminder(reminder)
      }
    }
    schedule()
  }

  return {
    start() {
      void processDue()
    },
    stop() {
      clear()
      for (const id of chatDeliveryRetries.keys()) clearChatRetry(id)
    },
    reschedule() {
      schedule()
    },
    processDueNow() {
      void processDue()
    },
    snooze(id: number) {
      const next = opts.reminders.snooze(id, Date.now() + SNOOZE_MS)
      schedule()
      return next
    },
    dismiss(id: number) {
      clearChatRetry(id)
      const next = opts.reminders.dismiss(id)
      schedule()
      return next
    },
    markChatDelivered(id: number) {
      clearChatRetry(id)
      const reminder = opts.reminders.get(id)
      if (!reminder || reminder.status !== 'pending') return reminder
      const delivered = opts.reminders.markDelivered(id)
      if (reminder.target === 'chat' && reminder.chatId) {
        showAppToast({
          title: 'Команда отправлена в чат',
          body: `По напоминанию: ${reminder.title}`,
          projectName: projectName(reminder.projectPath),
          projectPath: reminder.projectPath,
          reminderId: reminder.id,
          chatId: reminder.chatId,
          kind: 'chat-reminder-sent',
          theme: readTheme(opts.settings)
        })
      }
      schedule()
      return delivered
    },
    open(id: number) {
      const reminder = opts.reminders.get(id)
      if (reminder) opts.reminders.dismiss(id)
      const main = opts.getMainWindow()
      if (main && !main.isDestroyed()) {
        if (main.isMinimized()) main.restore()
        main.show()
        main.focus()
        main.webContents.send('notify:open-reminders', reminder?.projectPath)
      }
      schedule()
      return reminder
    }
  }
}

export type ReminderService = ReturnType<typeof createReminderService>
