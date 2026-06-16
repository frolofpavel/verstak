import { useCallback, useEffect, useState } from 'react'
import {
  NOTIFY_SOUND_KEY,
  NOTIFY_TOAST_KEY,
  NOTIFY_UNFOCUSED_ONLY_KEY,
  invalidateNotifyPrefsCache,
  type NotifyPrefs
} from '../lib/response-notify'

function flagOn(raw: string | null | undefined, defaultOn: boolean): boolean {
  if (raw == null || raw === '') return defaultOn
  return raw !== '0' && raw !== 'false'
}

async function readPrefs(): Promise<NotifyPrefs> {
  const [sound, toast, unfocusedOnly] = await Promise.all([
    window.api.settings.getKey(NOTIFY_SOUND_KEY),
    window.api.settings.getKey(NOTIFY_TOAST_KEY),
    window.api.settings.getKey(NOTIFY_UNFOCUSED_ONLY_KEY)
  ])
  return {
    sound: flagOn(sound, true),
    toast: flagOn(toast, true),
    unfocusedOnly: flagOn(unfocusedOnly, false)
  }
}

export function useNotifySettings(): {
  notifyPrefs: NotifyPrefs
  setNotifySound: (v: boolean) => Promise<void>
  setNotifyToast: (v: boolean) => Promise<void>
  setNotifyUnfocusedOnly: (v: boolean) => Promise<void>
  testNotification: () => Promise<void>
} {
  const [notifyPrefs, setNotifyPrefs] = useState<NotifyPrefs>({
    sound: true,
    toast: true,
    unfocusedOnly: false
  })

  useEffect(() => {
    void readPrefs().then(setNotifyPrefs)
  }, [])

  const persist = useCallback(async (patch: Partial<NotifyPrefs>) => {
    const next = { ...notifyPrefs, ...patch }
    setNotifyPrefs(next)
    invalidateNotifyPrefsCache()
    const tasks: Promise<void>[] = []
    if ('sound' in patch) tasks.push(window.api.settings.setKey(NOTIFY_SOUND_KEY, next.sound ? '1' : '0'))
    if ('toast' in patch) tasks.push(window.api.settings.setKey(NOTIFY_TOAST_KEY, next.toast ? '1' : '0'))
    if ('unfocusedOnly' in patch) {
      tasks.push(window.api.settings.setKey(NOTIFY_UNFOCUSED_ONLY_KEY, next.unfocusedOnly ? '1' : '0'))
    }
    await Promise.all(tasks)
  }, [notifyPrefs])

  const setNotifySound = useCallback((v: boolean) => persist({ sound: v }), [persist])
  const setNotifyToast = useCallback((v: boolean) => persist({ toast: v }), [persist])
  const setNotifyUnfocusedOnly = useCallback((v: boolean) => persist({ unfocusedOnly: v }), [persist])

  const testNotification = useCallback(async () => {
    invalidateNotifyPrefsCache()
    const { notifyResponseReady } = await import('../lib/response-notify')
    await notifyResponseReady({
      title: 'Verstak',
      projectName: 'Демо-проект',
      force: true
    })
  }, [])

  return {
    notifyPrefs,
    setNotifySound,
    setNotifyToast,
    setNotifyUnfocusedOnly,
    testNotification
  }
}