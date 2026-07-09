import { useCallback, useEffect, useState } from 'react'
import {
  NOTIFY_SOUND_KEY,
  NOTIFY_TOAST_KEY,
  NOTIFY_UNFOCUSED_ONLY_KEY,
  invalidateNotifyPrefsCache,
  type NotifyPrefs
} from '../lib/response-notify'

export type NotifyMode = 'always' | 'unfocused' | 'quiet'
export type NotifyChannelId = 'toast' | 'sound' | 'project'
export type NotifyEventId = 'assistant' | 'error' | 'reminder' | 'queue' | 'update' | 'background'

export interface NotifyEventOption {
  id: NotifyEventId
  title: string
  description: string
}

export interface NotifyModeOption {
  id: NotifyMode
  title: string
  description: string
}

export interface NotifyChannelOption {
  id: NotifyChannelId
  label: string
  description: string
}

export type NotifyEventPrefs = Record<NotifyEventId, Record<NotifyChannelId, boolean>>

export interface NotifyQuietHours {
  enabled: boolean
  from: string
  to: string
}

export interface ExtendedNotifyPrefs extends NotifyPrefs {
  enabled: boolean
  mode: NotifyMode
  events: NotifyEventPrefs
  quietHours: NotifyQuietHours
}

export const NOTIFY_ENABLED_KEY = 'notify_enabled'
export const NOTIFY_MODE_KEY = 'notify_mode'
export const NOTIFY_EVENTS_KEY = 'notify_events'
export const NOTIFY_QUIET_ENABLED_KEY = 'notify_quiet_enabled'
export const NOTIFY_QUIET_FROM_KEY = 'notify_quiet_from'
export const NOTIFY_QUIET_TO_KEY = 'notify_quiet_to'

export const NOTIFY_MODE_OPTIONS: NotifyModeOption[] = [
  { id: 'always', title: 'Всегда', description: 'Показывать уведомления сразу' },
  { id: 'unfocused', title: 'Вне фокуса', description: 'Показывать, когда окно не активно' },
  { id: 'quiet', title: 'Тихий режим', description: 'Только ошибки, прерванные ответы и напоминания' }
]

export const NOTIFY_EVENT_OPTIONS: NotifyEventOption[] = [
  { id: 'assistant', title: 'Ответ готов', description: 'Модель закончила работу в проекте' },
  { id: 'error', title: 'Ошибка', description: 'Задача остановилась или завершилась ошибкой' },
  { id: 'reminder', title: 'Напоминание', description: 'Наступило время запланированного напоминания' },
  { id: 'queue', title: 'Очередь', description: 'Сообщение добавлено или запущено из очереди' },
  { id: 'update', title: 'Обновления', description: 'Найдена или подготовлена новая версия' },
  { id: 'background', title: 'Фоновая работа', description: 'Задача завершилась, пока открыт другой проект' }
]

export const NOTIFY_CHANNEL_OPTIONS: NotifyChannelOption[] = [
  { id: 'toast', label: 'Всплывающее', description: 'Отдельная всплывашка Verstak в правом нижнем углу' },
  { id: 'sound', label: 'Звук', description: 'Короткий звуковой сигнал' },
  { id: 'project', label: 'Проект', description: 'Статус работы проекта в левом меню' }
]

const DEFAULT_EVENT_PREFS: NotifyEventPrefs = {
  assistant: { toast: true, sound: true, project: true },
  error: { toast: true, sound: true, project: true },
  reminder: { toast: true, sound: true, project: true },
  queue: { toast: false, sound: false, project: true },
  update: { toast: true, sound: false, project: false },
  background: { toast: true, sound: false, project: true }
}

function flagOn(raw: string | null | undefined, defaultOn: boolean): boolean {
  if (raw == null || raw === '') return defaultOn
  return raw !== '0' && raw !== 'false'
}

function parseMode(raw: string | null | undefined, unfocusedOnly: boolean): NotifyMode {
  if (raw === 'always' || raw === 'unfocused' || raw === 'quiet') return raw
  return unfocusedOnly ? 'unfocused' : 'always'
}

function parseEventPrefs(raw: string | null | undefined, sound: boolean, toast: boolean): NotifyEventPrefs {
  const base = structuredClone(DEFAULT_EVENT_PREFS)
  base.assistant.sound = sound
  base.assistant.toast = toast
  base.error.sound = sound
  base.error.toast = toast
  if (!raw) return base
  try {
    const parsed = JSON.parse(raw) as Partial<NotifyEventPrefs>
    for (const event of NOTIFY_EVENT_OPTIONS) {
      const eventPrefs = parsed[event.id]
      if (!eventPrefs) continue
      for (const channel of NOTIFY_CHANNEL_OPTIONS) {
        if (typeof eventPrefs[channel.id] === 'boolean') {
          base[event.id][channel.id] = eventPrefs[channel.id]
        }
      }
    }
  } catch {
    return base
  }
  return base
}

async function readPrefs(): Promise<ExtendedNotifyPrefs> {
  const [enabled, sound, toast, unfocusedOnly, mode, events, quietEnabled, quietFrom, quietTo] = await Promise.all([
    window.api.settings.getKey(NOTIFY_ENABLED_KEY),
    window.api.settings.getKey(NOTIFY_SOUND_KEY),
    window.api.settings.getKey(NOTIFY_TOAST_KEY),
    window.api.settings.getKey(NOTIFY_UNFOCUSED_ONLY_KEY),
    window.api.settings.getKey(NOTIFY_MODE_KEY),
    window.api.settings.getKey(NOTIFY_EVENTS_KEY),
    window.api.settings.getKey(NOTIFY_QUIET_ENABLED_KEY),
    window.api.settings.getKey(NOTIFY_QUIET_FROM_KEY),
    window.api.settings.getKey(NOTIFY_QUIET_TO_KEY)
  ])
  const soundOn = flagOn(sound, true)
  const toastOn = flagOn(toast, true)
  const unfocusedOnlyOn = flagOn(unfocusedOnly, true)
  return {
    enabled: flagOn(enabled, true),
    sound: soundOn,
    toast: toastOn,
    unfocusedOnly: unfocusedOnlyOn,
    mode: parseMode(mode, unfocusedOnlyOn),
    events: parseEventPrefs(events, soundOn, toastOn),
    quietHours: {
      enabled: flagOn(quietEnabled, false),
      from: quietFrom || '22:00',
      to: quietTo || '09:00'
    }
  }
}

export function useNotifySettings(): {
  notifyPrefs: ExtendedNotifyPrefs
  setNotifySound: (v: boolean) => Promise<void>
  setNotifyToast: (v: boolean) => Promise<void>
  setNotifyUnfocusedOnly: (v: boolean) => Promise<void>
  setNotifyEnabled: (v: boolean) => Promise<void>
  setNotifyMode: (v: NotifyMode) => Promise<void>
  setNotifyEventChannel: (eventId: NotifyEventId, channelId: NotifyChannelId, v: boolean) => Promise<void>
  setQuietHoursEnabled: (v: boolean) => Promise<void>
  setQuietHoursTime: (field: 'from' | 'to', v: string) => Promise<void>
  testNotification: () => Promise<boolean>
} {
  const [notifyPrefs, setNotifyPrefs] = useState<ExtendedNotifyPrefs>({
    enabled: true,
    sound: true,
    toast: true,
    unfocusedOnly: true,
    mode: 'unfocused',
    events: DEFAULT_EVENT_PREFS,
    quietHours: {
      enabled: false,
      from: '22:00',
      to: '09:00'
    }
  })

  useEffect(() => {
    void readPrefs().then(setNotifyPrefs)
  }, [])

  const persist = useCallback(async (patch: Partial<ExtendedNotifyPrefs>) => {
    const next = { ...notifyPrefs, ...patch }
    setNotifyPrefs(next)
    invalidateNotifyPrefsCache()
    const tasks: Promise<void>[] = []
    if ('enabled' in patch) tasks.push(window.api.settings.setKey(NOTIFY_ENABLED_KEY, next.enabled ? '1' : '0'))
    if ('sound' in patch) tasks.push(window.api.settings.setKey(NOTIFY_SOUND_KEY, next.sound ? '1' : '0'))
    if ('toast' in patch) tasks.push(window.api.settings.setKey(NOTIFY_TOAST_KEY, next.toast ? '1' : '0'))
    if ('unfocusedOnly' in patch) {
      tasks.push(window.api.settings.setKey(NOTIFY_UNFOCUSED_ONLY_KEY, next.unfocusedOnly ? '1' : '0'))
    }
    if ('mode' in patch) {
      tasks.push(window.api.settings.setKey(NOTIFY_MODE_KEY, next.mode))
      tasks.push(window.api.settings.setKey(NOTIFY_UNFOCUSED_ONLY_KEY, next.mode === 'unfocused' ? '1' : '0'))
    }
    if ('events' in patch) tasks.push(window.api.settings.setKey(NOTIFY_EVENTS_KEY, JSON.stringify(next.events)))
    if ('quietHours' in patch) {
      tasks.push(window.api.settings.setKey(NOTIFY_QUIET_ENABLED_KEY, next.quietHours.enabled ? '1' : '0'))
      tasks.push(window.api.settings.setKey(NOTIFY_QUIET_FROM_KEY, next.quietHours.from))
      tasks.push(window.api.settings.setKey(NOTIFY_QUIET_TO_KEY, next.quietHours.to))
    }
    await Promise.all(tasks)
  }, [notifyPrefs])

  const setNotifySound = useCallback((v: boolean) => persist({ sound: v }), [persist])
  const setNotifyToast = useCallback((v: boolean) => persist({ toast: v }), [persist])
  const setNotifyUnfocusedOnly = useCallback((v: boolean) => persist({ unfocusedOnly: v }), [persist])
  const setNotifyEnabled = useCallback((v: boolean) => persist({ enabled: v }), [persist])
  const setNotifyMode = useCallback((v: NotifyMode) => {
    return persist({ mode: v, unfocusedOnly: v === 'unfocused' })
  }, [persist])
  const setNotifyEventChannel = useCallback((eventId: NotifyEventId, channelId: NotifyChannelId, v: boolean) => {
    const nextEvents = structuredClone(notifyPrefs.events)
    nextEvents[eventId][channelId] = v
    const patch: Partial<ExtendedNotifyPrefs> = { events: nextEvents }
    if (eventId === 'assistant') {
      if (channelId === 'sound') patch.sound = v
      if (channelId === 'toast') patch.toast = v
    }
    return persist(patch)
  }, [notifyPrefs.events, persist])
  const setQuietHoursEnabled = useCallback((v: boolean) => {
    return persist({ quietHours: { ...notifyPrefs.quietHours, enabled: v } })
  }, [notifyPrefs.quietHours, persist])
  const setQuietHoursTime = useCallback((field: 'from' | 'to', v: string) => {
    return persist({ quietHours: { ...notifyPrefs.quietHours, [field]: v } })
  }, [notifyPrefs.quietHours, persist])

  const testNotification = useCallback(async () => {
    const [soundOk, toastOk] = await Promise.all([
      window.api.notify.playSound({ isError: false }).catch(() => false),
      window.api.notify.show({
        title: 'Verstak',
        body: 'Проверка уведомлений работает',
        projectName: 'Уведомления'
      }).catch(() => false)
    ])
    return !!soundOk || !!toastOk
  }, [])

  return {
    notifyPrefs,
    setNotifySound,
    setNotifyToast,
    setNotifyUnfocusedOnly,
    setNotifyEnabled,
    setNotifyMode,
    setNotifyEventChannel,
    setQuietHoursEnabled,
    setQuietHoursTime,
    testNotification
  }
}
