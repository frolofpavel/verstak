import { useEffect, useState, useCallback } from 'react'

export type ThemeId = 'dark' | 'light' | 'dracula' | 'nord' | 'tokyo-night' | 'gruvbox'

export interface ThemeMeta {
  id: ThemeId
  /** Russian label shown in the picker */
  label: string
  /** true = light surfaces (affects swatch contrast hints) */
  light: boolean
  /** [bg, surface, accent] — drives the swatch preview in Settings */
  swatch: [string, string, string]
}

/** Single source of truth for the picker. Colours mirror theme.css. */
export const THEMES: ThemeMeta[] = [
  { id: 'dark', label: 'Verstak Dark', light: false, swatch: ['#0b0b0c', '#111113', '#c4a35a'] },
  { id: 'light', label: 'Verstak Light', light: true, swatch: ['#ffffff', '#eef0f4', '#3a6ee8'] },
  { id: 'dracula', label: 'Dracula', light: false, swatch: ['#21222c', '#282a36', '#bd93f9'] },
  { id: 'nord', label: 'Nord', light: false, swatch: ['#2e3440', '#3b4252', '#88c0d0'] },
  { id: 'tokyo-night', label: 'Tokyo Night', light: false, swatch: ['#1a1b26', '#24283b', '#7aa2f7'] },
  { id: 'gruvbox', label: 'Gruvbox', light: false, swatch: ['#282828', '#3c3836', '#fabd2f'] }
]

const VALID = new Set<ThemeId>(THEMES.map(t => t.id))

const STORAGE_KEY = 'theme'
const RADIUS_KEY = 'theme_radius'
const DEFAULT_THEME: ThemeId = 'dark'

function normalize(v: unknown): ThemeId {
  return typeof v === 'string' && VALID.has(v as ThemeId) ? (v as ThemeId) : DEFAULT_THEME
}

function applyTheme(theme: ThemeId): void {
  document.documentElement.setAttribute('data-theme', theme)
}

function applyRadius(square: boolean): void {
  if (square) document.documentElement.setAttribute('data-radius', 'square')
  else document.documentElement.removeAttribute('data-radius')
}

/**
 * Apply the saved theme as early as possible (before first paint of components
 * that read CSS variables). Called from main.tsx.
 */
export async function bootstrapTheme(): Promise<void> {
  try {
    const stored = await window.api.settings.getKey(STORAGE_KEY)
    applyTheme(normalize(stored))
    const radius = await window.api.settings.getKey(RADIUS_KEY)
    applyRadius(radius === 'square')
  } catch {
    applyTheme(DEFAULT_THEME)
  }
}

export function useTheme(): {
  theme: ThemeId
  setTheme: (t: ThemeId) => Promise<void>
  squareCorners: boolean
  setSquareCorners: (v: boolean) => Promise<void>
} {
  const [theme, setLocal] = useState<ThemeId>(DEFAULT_THEME)
  const [squareCorners, setSquare] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.api.settings.getKey(STORAGE_KEY).then(v => {
      if (cancelled) return
      const next = normalize(v)
      setLocal(next)
      applyTheme(next)
    })
    void window.api.settings.getKey(RADIUS_KEY).then(v => {
      if (cancelled) return
      const sq = v === 'square'
      setSquare(sq)
      applyRadius(sq)
    })
    return () => { cancelled = true }
  }, [])

  const setTheme = useCallback(async (next: ThemeId) => {
    setLocal(next)
    applyTheme(next)
    await window.api.settings.setKey(STORAGE_KEY, next)
  }, [])

  const setSquareCorners = useCallback(async (v: boolean) => {
    setSquare(v)
    applyRadius(v)
    await window.api.settings.setKey(RADIUS_KEY, v ? 'square' : 'round')
  }, [])

  return { theme, setTheme, squareCorners, setSquareCorners }
}
