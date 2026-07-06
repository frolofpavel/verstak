import { screen, type BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import type { Settings } from './storage/settings'
import { logRuntime } from './runtime-log'
import {
  DEFAULT_MAIN_WINDOW_STATE,
  MAIN_WINDOW_STATE_KEY,
  normalizeMainWindowState,
  type MainWindowState
} from './window-state-core'

export { DEFAULT_MAIN_WINDOW_STATE, MAIN_WINDOW_STATE_KEY, normalizeMainWindowState, type MainWindowState }

export function readMainWindowState(settings: Settings): MainWindowState {
  const raw = settings.getSecret(MAIN_WINDOW_STATE_KEY)
  if (!raw) return { ...DEFAULT_MAIN_WINDOW_STATE }
  try {
    return normalizeMainWindowState(JSON.parse(raw) as unknown)
  } catch {
    return { ...DEFAULT_MAIN_WINDOW_STATE }
  }
}

function isOnAnyDisplay(state: MainWindowState): boolean {
  if (state.x == null || state.y == null) return false
  const rect = { x: state.x, y: state.y, width: state.width, height: state.height }
  return screen.getAllDisplays().some(d => {
    const a = d.workArea
    return rect.x < a.x + a.width
      && rect.x + rect.width > a.x
      && rect.y < a.y + a.height
      && rect.y + rect.height > a.y
  })
}

export function mainWindowConstructorOptions(state: MainWindowState): Pick<
  BrowserWindowConstructorOptions,
  'width' | 'height' | 'x' | 'y'
> {
  const opts: Pick<BrowserWindowConstructorOptions, 'width' | 'height' | 'x' | 'y'> = {
    width: state.width,
    height: state.height
  }
  if (state.x != null && state.y != null && isOnAnyDisplay(state)) {
    opts.x = state.x
    opts.y = state.y
  }
  return opts
}

function persistState(
  win: BrowserWindow,
  settings: Settings,
  normalBounds: { x: number; y: number; width: number; height: number }
): void {
  const payload: MainWindowState = win.isMaximized()
    ? {
        width: normalBounds.width,
        height: normalBounds.height,
        x: normalBounds.x,
        y: normalBounds.y,
        isMaximized: true
      }
    : {
        ...win.getBounds(),
        isMaximized: false
      }
  settings.setSecret(MAIN_WINDOW_STATE_KEY, JSON.stringify(normalizeMainWindowState(payload)))
}

export function trackMainWindowState(win: BrowserWindow, settings: Settings, restored: MainWindowState): void {
  let normalBounds = {
    x: restored.x ?? win.getBounds().x,
    y: restored.y ?? win.getBounds().y,
    width: restored.width,
    height: restored.height
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  const scheduleSave = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => persistState(win, settings, normalBounds), 400)
  }

  win.on('resize', () => {
    if (!win.isMaximized()) normalBounds = win.getBounds()
    scheduleSave()
  })
  win.on('move', () => {
    if (!win.isMaximized()) normalBounds = win.getBounds()
    scheduleSave()
  })
  win.on('maximize', scheduleSave)
  win.on('unmaximize', () => {
    normalBounds = win.getBounds()
    scheduleSave()
  })
  win.on('close', () => {
    if (timer) clearTimeout(timer)
    persistState(win, settings, normalBounds)
  })

  let revealed = false
  const reveal = (reason: string) => {
    if (revealed || win.isDestroyed()) return
    revealed = true
    if (restored.isMaximized) win.maximize()
    win.show()
    win.focus()
    logRuntime('window.reveal', { reason, bounds: win.getBounds(), isMaximized: win.isMaximized() })
  }

  win.once('ready-to-show', () => reveal('ready-to-show'))
  win.webContents.once('did-finish-load', () => reveal('did-finish-load'))
  win.webContents.once('dom-ready', () => reveal('dom-ready'))
  setTimeout(() => reveal('fallback-timeout'), 1500)
}
