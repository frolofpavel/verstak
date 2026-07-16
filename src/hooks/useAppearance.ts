import { useCallback, useEffect, useState } from 'react'

export type UiDensity = 'compact' | 'standard'
export type MotionLevel = 'full' | 'off'
export type ProjectStatusDisplay = 'avatar' | 'text' | 'errors'

export interface AppearancePrefs {
  uiDensity: UiDensity
  motionLevel: MotionLevel
  projectStatusDisplay: ProjectStatusDisplay
}

export const APPEARANCE_DEFAULTS: AppearancePrefs = {
  uiDensity: 'standard',
  motionLevel: 'full',
  projectStatusDisplay: 'avatar'
}

const STORAGE_KEYS = {
  uiDensity: 'appearance_ui_density',
  motionLevel: 'appearance_motion_level',
  projectStatusDisplay: 'appearance_project_status_display'
} as const

export const UI_DENSITY_OPTIONS: Array<{ id: UiDensity; label: string; description: string }> = [
  { id: 'standard', label: 'Стандартно', description: 'Обычные отступы и размер строк' },
  { id: 'compact', label: 'Компактно', description: 'Больше проектов в панели, аватарки и названия остаются видимыми' }
]

export const MOTION_LEVEL_OPTIONS: Array<{ id: MotionLevel; label: string; description: string }> = [
  { id: 'full', label: 'Полные', description: 'Плавные переходы и живые статусы' },
  { id: 'off', label: 'Выключены', description: 'Без декоративных анимаций' }
]

export const PROJECT_STATUS_DISPLAY_OPTIONS: Array<{ id: ProjectStatusDisplay; label: string; description: string }> = [
  { id: 'avatar', label: 'На аватарке', description: 'Кольца на проектах' },
  { id: 'text', label: 'Текстом в списке', description: 'Подписи рядом с названием' },
  { id: 'errors', label: 'Только ошибки', description: 'Показываются только ошибки' }
]

function normalizeUiDensity(raw: unknown): UiDensity {
  if (raw === 'spacious') return 'compact'
  return raw === 'standard' || raw === 'compact'
    ? raw
    : APPEARANCE_DEFAULTS.uiDensity
}

function normalizeMotionLevel(raw: unknown): MotionLevel {
  if (raw === 'off' || raw === 'minimal') return 'off'
  return 'full'
}

function normalizeProjectStatusDisplay(raw: unknown): ProjectStatusDisplay {
  return raw === 'avatar' || raw === 'text' || raw === 'errors'
    ? raw
    : APPEARANCE_DEFAULTS.projectStatusDisplay
}

function normalizePrefs(raw: Partial<Record<keyof AppearancePrefs, unknown>>): AppearancePrefs {
  return {
    uiDensity: normalizeUiDensity(raw.uiDensity),
    motionLevel: normalizeMotionLevel(raw.motionLevel),
    projectStatusDisplay: normalizeProjectStatusDisplay(raw.projectStatusDisplay)
  }
}

export function applyAppearancePrefs(prefs: AppearancePrefs): void {
  const root = document.documentElement
  root.setAttribute('data-ui-density', prefs.uiDensity)
  root.setAttribute('data-motion', prefs.motionLevel)
  root.setAttribute('data-project-status', prefs.projectStatusDisplay)
}

export async function bootstrapAppearance(): Promise<void> {
  try {
    const [uiDensity, motionLevel, projectStatusDisplay] = await Promise.all([
      window.api.settings.getKey(STORAGE_KEYS.uiDensity),
      window.api.settings.getKey(STORAGE_KEYS.motionLevel),
      window.api.settings.getKey(STORAGE_KEYS.projectStatusDisplay)
    ])
    applyAppearancePrefs(normalizePrefs({ uiDensity, motionLevel, projectStatusDisplay }))
  } catch {
    applyAppearancePrefs(APPEARANCE_DEFAULTS)
  }
}

export function useAppearance(): AppearancePrefs & {
  setUiDensity: (density: UiDensity) => Promise<void>
  setMotionLevel: (level: MotionLevel) => Promise<void>
  setProjectStatusDisplay: (display: ProjectStatusDisplay) => Promise<void>
  resetAppearance: () => Promise<void>
} {
  const [prefs, setPrefs] = useState<AppearancePrefs>(APPEARANCE_DEFAULTS)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.api.settings.getKey(STORAGE_KEYS.uiDensity),
      window.api.settings.getKey(STORAGE_KEYS.motionLevel),
      window.api.settings.getKey(STORAGE_KEYS.projectStatusDisplay)
    ]).then(([uiDensity, motionLevel, projectStatusDisplay]) => {
      if (cancelled) return
      const next = normalizePrefs({ uiDensity, motionLevel, projectStatusDisplay })
      setPrefs(next)
      applyAppearancePrefs(next)
    }).catch(() => {
      if (!cancelled) applyAppearancePrefs(APPEARANCE_DEFAULTS)
    })
    return () => { cancelled = true }
  }, [])

  const persist = useCallback(async (next: AppearancePrefs) => {
    setPrefs(next)
    applyAppearancePrefs(next)
    await Promise.all([
      window.api.settings.setKey(STORAGE_KEYS.uiDensity, next.uiDensity),
      window.api.settings.setKey(STORAGE_KEYS.motionLevel, next.motionLevel),
      window.api.settings.setKey(STORAGE_KEYS.projectStatusDisplay, next.projectStatusDisplay)
    ])
  }, [])

  const setUiDensity = useCallback(async (uiDensity: UiDensity) => {
    await persist({ ...prefs, uiDensity })
  }, [persist, prefs])

  const setMotionLevel = useCallback(async (motionLevel: MotionLevel) => {
    await persist({ ...prefs, motionLevel })
  }, [persist, prefs])

  const setProjectStatusDisplay = useCallback(async (projectStatusDisplay: ProjectStatusDisplay) => {
    await persist({ ...prefs, projectStatusDisplay })
  }, [persist, prefs])

  const resetAppearance = useCallback(async () => {
    await persist(APPEARANCE_DEFAULTS)
  }, [persist])

  return {
    ...prefs,
    setUiDensity,
    setMotionLevel,
    setProjectStatusDisplay,
    resetAppearance
  }
}
