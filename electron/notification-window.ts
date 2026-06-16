import { BrowserWindow, ipcMain, screen } from 'electron'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))

const TOAST_W = 440
const TOAST_H = 320
const MARGIN = 16
const BOTTOM = 24

export interface ToastPayload {
  title?: string
  body: string
  projectName?: string
  isError?: boolean
  theme?: 'nord' | 'light'
}

let toastWin: BrowserWindow | null = null
let getMainWindow: (() => BrowserWindow | null) | null = null
let pending: ToastPayload[] = []
let ipcReady = false

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

  screen.on('display-metrics-changed', () => {
    if (toastWin && !toastWin.isDestroyed()) positionToastWindow(toastWin)
  })

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

export function showAppToast(payload: ToastPayload): void {
  const win = ensureToastWindow()
  if (!ipcReady || win.webContents.isLoading()) {
    pending.push(payload)
  } else {
    win.webContents.send('toast:show', payload)
  }
  if (!win.isVisible()) win.showInactive()
}

export function registerNotificationWindowIpc(): void {
  ipcMain.on('toast:focus-main', () => {
    const main = getMainWindow?.()
    if (!main || main.isDestroyed()) return
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
  })

  ipcMain.on('toast:hide-window', () => {
    if (toastWin && !toastWin.isDestroyed()) toastWin.hide()
  })
}