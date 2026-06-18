import { BrowserWindow, ipcMain, screen } from 'electron'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))

const TOAST_W = 420
/** Высота окна под до 3 тостов (~132px каждый + отступы). */
const TOAST_H = 440
/** Как Windows toast: вплотную к правому нижнему углу рабочей области. */
const MARGIN = 8
/** Отступ от нижнего края рабочей области — выше панели задач Windows. */
const BOTTOM = 52

export interface ToastPayload {
  title?: string
  body: string
  projectName?: string
  projectPath?: string
  isHelp?: boolean
  isError?: boolean
  theme?: 'nord' | 'light'
}

let toastWin: BrowserWindow | null = null
let getMainWindow: (() => BrowserWindow | null) | null = null
let pending: ToastPayload[] = []
let ipcReady = false
let toastShutdown = false
let onDisplayMetricsChanged: (() => void) | null = null

function positionToastWindow(win: BrowserWindow): void {
  const { workArea } = screen.getPrimaryDisplay()
  win.setBounds({
    x: workArea.x + workArea.width - TOAST_W - MARGIN,
    y: workArea.y + workArea.height - TOAST_H - BOTTOM,
    width: TOAST_W,
    height: TOAST_H
  })
}

function flushPending(win: BrowserWindow): void {
  if (pending.length === 0) return
  for (const payload of pending) {
    win.webContents.send('toast:show', payload)
  }
  pending = []
}

function ensureToastWindow(): BrowserWindow {
  if (toastShutdown) {
    throw new Error('toast window unavailable after shutdown')
  }
  if (toastWin && !toastWin.isDestroyed()) return toastWin

  toastWin = new BrowserWindow({
    width: TOAST_W,
    height: TOAST_H,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    show: false,
    hasShadow: false,
    thickFrame: false,
    webPreferences: {
      preload: join(HERE, '../preload/preload-notification.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.platform === 'win32') {
    toastWin.setAlwaysOnTop(true, 'screen-saver')
  }

  positionToastWindow(toastWin)

  onDisplayMetricsChanged = () => {
    if (toastWin && !toastWin.isDestroyed()) positionToastWindow(toastWin)
  }
  screen.on('display-metrics-changed', onDisplayMetricsChanged)

  toastWin.webContents.on('did-finish-load', () => {
    ipcReady = true
    if (toastWin && !toastWin.isDestroyed()) flushPending(toastWin)
  })

  toastWin.on('closed', () => {
    toastWin = null
    ipcReady = false
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const base = devUrl.replace(/\/$/, '')
    void toastWin.loadURL(`${base}/notification.html`)
  } else {
    void toastWin.loadFile(join(HERE, '../renderer/notification.html'))
  }

  return toastWin
}

export function initNotificationWindow(getMain: () => BrowserWindow | null): void {
  getMainWindow = getMain
}

export function destroyNotificationWindow(): void {
  toastShutdown = true
  pending = []
  ipcReady = false
  if (onDisplayMetricsChanged) {
    screen.removeListener('display-metrics-changed', onDisplayMetricsChanged)
    onDisplayMetricsChanged = null
  }
  if (toastWin && !toastWin.isDestroyed()) {
    toastWin.destroy()
  }
  toastWin = null
}

export function showAppToast(payload: ToastPayload): void {
  if (toastShutdown) return
  let win: BrowserWindow
  try {
    win = ensureToastWindow()
  } catch {
    return
  }
  if (!ipcReady || win.webContents.isLoading()) {
    pending.push(payload)
  } else {
    win.webContents.send('toast:show', payload)
  }
  if (!win.isVisible()) win.showInactive()
}

export function registerNotificationWindowIpc(): void {
  ipcMain.on('toast:focus-main', (_e, arg?: unknown) => {
    const main = getMainWindow?.()
    if (!main || main.isDestroyed()) return
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
    if (typeof arg === 'string') {
      if (arg.trim()) main.webContents.send('notify:open-project', arg.trim())
      return
    }
    if (arg && typeof arg === 'object') {
      const { projectPath, openHelp } = arg as { projectPath?: string; openHelp?: boolean }
      if (openHelp) {
        main.webContents.send('notify:open-help', projectPath?.trim() || undefined)
      } else if (projectPath?.trim()) {
        main.webContents.send('notify:open-project', projectPath.trim())
      }
    }
  })

  ipcMain.on('toast:hide-window', () => {
    if (toastWin && !toastWin.isDestroyed()) toastWin.hide()
  })
}