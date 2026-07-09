import { getTranslations, type Lang } from '../i18n'

export const NOTIFY_SOUND_KEY = 'notify_sound'
export const NOTIFY_TOAST_KEY = 'notify_toast'
export const NOTIFY_UNFOCUSED_ONLY_KEY = 'notify_unfocused_only'
export const NOTIFY_ENABLED_KEY = 'notify_enabled'
export const NOTIFY_MODE_KEY = 'notify_mode'
export const NOTIFY_EVENTS_KEY = 'notify_events'
export const NOTIFY_QUIET_ENABLED_KEY = 'notify_quiet_enabled'
export const NOTIFY_QUIET_FROM_KEY = 'notify_quiet_from'
export const NOTIFY_QUIET_TO_KEY = 'notify_quiet_to'

export type NotifyMode = 'always' | 'unfocused' | 'quiet'

export interface NotifyPrefs {
  enabled?: boolean
  sound: boolean
  toast: boolean
  unfocusedOnly: boolean
  mode?: NotifyMode
  quietHours?: {
    enabled: boolean
    from: string
    to: string
  }
}

let prefsCache: NotifyPrefs | null = null
let prefsLoadedAt = 0

function flagOn(raw: string | null | undefined, defaultOn = true): boolean {
  if (raw == null || raw === '') return defaultOn
  return raw !== '0' && raw !== 'false'
}

function parseMode(raw: string | null | undefined, unfocusedOnly: boolean): NotifyMode {
  if (raw === 'always' || raw === 'unfocused' || raw === 'quiet') return raw
  return unfocusedOnly ? 'unfocused' : 'always'
}

function isQuietNow(from: string, to: string, now = new Date()): boolean {
  const [fromH, fromM] = from.split(':').map(Number)
  const [toH, toM] = to.split(':').map(Number)
  if (!Number.isFinite(fromH) || !Number.isFinite(fromM) || !Number.isFinite(toH) || !Number.isFinite(toM)) return false
  const current = now.getHours() * 60 + now.getMinutes()
  const start = fromH * 60 + fromM
  const end = toH * 60 + toM
  if (start === end) return true
  if (start < end) return current >= start && current < end
  return current >= start || current < end
}

function readEventChannels(raw: string | null | undefined, eventId: 'assistant' | 'error'): Partial<Pick<NotifyPrefs, 'sound' | 'toast'>> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, { sound?: boolean; toast?: boolean } | undefined>
    const prefs = parsed[eventId]
    return {
      sound: typeof prefs?.sound === 'boolean' ? prefs.sound : undefined,
      toast: typeof prefs?.toast === 'boolean' ? prefs.toast : undefined
    }
  } catch {
    return {}
  }
}

export async function loadNotifyPrefs(): Promise<NotifyPrefs> {
  if (prefsCache && Date.now() - prefsLoadedAt < 3000) return prefsCache
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
  const unfocusedOnlyOn = flagOn(unfocusedOnly, true)
  const eventChannels = readEventChannels(events, 'assistant')
  prefsCache = {
    enabled: flagOn(enabled, true),
    sound: eventChannels.sound ?? flagOn(sound, true),
    toast: eventChannels.toast ?? flagOn(toast, true),
    // Дефолт true: при открытом и сфокусированном окне попап-уведомление не нужно
    // (результат и так виден). Кому надо «всегда» — выключают в Настройках.
    unfocusedOnly: unfocusedOnlyOn,
    mode: parseMode(mode, unfocusedOnlyOn),
    quietHours: {
      enabled: flagOn(quietEnabled, false),
      from: quietFrom || '22:00',
      to: quietTo || '09:00'
    }
  }
  prefsLoadedAt = Date.now()
  return prefsCache
}

export function invalidateNotifyPrefsCache(): void {
  prefsCache = null
}

async function currentLang(): Promise<Lang> {
  const raw = await window.api.settings.getKey('language')
  return raw === 'en' ? 'en' : 'ru'
}

function buildBody(opts: {
  body?: string
  isError?: boolean
}): string {
  if (opts.body) return opts.body
  return opts.isError ? 'Не удалось завершить работу' : 'Работа завершена'
}

export async function notifyResponseReady(opts: {
  title?: string
  body?: string
  projectName?: string
  projectPath?: string
  isHelp?: boolean
  isError?: boolean
  force?: boolean
}): Promise<void> {
  const prefs = await loadNotifyPrefs()
  const soundEnabled = opts.force ? true : prefs.sound
  const toastEnabled = opts.force ? true : prefs.toast
  if (!opts.force && prefs.enabled === false) return
  if (!soundEnabled && !toastEnabled) return
  if (!opts.force && !opts.isError && prefs.mode === 'quiet') return
  if (!opts.force && !opts.isError && prefs.quietHours?.enabled && isQuietNow(prefs.quietHours.from, prefs.quietHours.to)) return

  if (!opts.force && prefs.unfocusedOnly) {
    const focused = await window.api.app.isFocused()
    if (focused) return
  }

  if (soundEnabled) void window.api.notify.playSound({ isError: !!opts.isError })

  if (toastEnabled) {
    const t = getTranslations(await currentLang())
    const isHelp = !!opts.isHelp
    void window.api.notify.show({
      title: opts.title ?? 'Verstak',
      body: isHelp && !opts.isError ? '' : buildBody(opts),
      projectName: isHelp
        ? (opts.isError ? t.help.notifyError : t.help.notifyReady)
        : opts.projectName,
      projectPath: isHelp ? undefined : opts.projectPath,
      isHelp,
      isError: !!opts.isError
    })
  }
}
