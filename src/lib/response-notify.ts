import { getTranslations, type Lang } from '../i18n'

export const NOTIFY_SOUND_KEY = 'notify_sound'
export const NOTIFY_TOAST_KEY = 'notify_toast'
export const NOTIFY_UNFOCUSED_ONLY_KEY = 'notify_unfocused_only'

export interface NotifyPrefs {
  sound: boolean
  toast: boolean
  unfocusedOnly: boolean
}

let prefsCache: NotifyPrefs | null = null
let prefsLoadedAt = 0

function flagOn(raw: string | null | undefined, defaultOn = true): boolean {
  if (raw == null || raw === '') return defaultOn
  return raw !== '0' && raw !== 'false'
}

export async function loadNotifyPrefs(): Promise<NotifyPrefs> {
  if (prefsCache && Date.now() - prefsLoadedAt < 3000) return prefsCache
  const [sound, toast, unfocusedOnly] = await Promise.all([
    window.api.settings.getKey(NOTIFY_SOUND_KEY),
    window.api.settings.getKey(NOTIFY_TOAST_KEY),
    window.api.settings.getKey(NOTIFY_UNFOCUSED_ONLY_KEY)
  ])
  prefsCache = {
    sound: flagOn(sound, true),
    toast: flagOn(toast, true),
    unfocusedOnly: flagOn(unfocusedOnly, false)
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
  if (!prefs.sound && !prefs.toast) return

  if (!opts.force && prefs.unfocusedOnly) {
    const focused = await window.api.app.isFocused()
    if (focused) return
  }

  if (prefs.sound) void window.api.notify.playSound({ isError: !!opts.isError })

  if (prefs.toast) {
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