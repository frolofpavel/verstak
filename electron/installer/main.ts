import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getInstallDefaults, launchInstalledApp, runInstall } from './engine'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT_NAME = 'Verstak Setup'

const SPLASH_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 100%; height: 100%;
    background: #2e3440;
    color: #eceff4;
    font: 500 13px/1.4 Inter, "Segoe UI", system-ui, sans-serif;
    user-select: none;
    overflow: hidden;
  }
  .wrap {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 18px;
    padding: 24px;
  }
  .logo {
    width: 72px; height: 72px;
    border-radius: 16px;
    background: #3b4252;
    border: 1px solid #4c566a;
    display: grid; place-items: center;
    font-size: 28px; font-weight: 700; color: #88c0d0;
  }
  .title { font-size: 18px; font-weight: 600; letter-spacing: 0.02em; }
  .sub { font-size: 13px; color: #d8dee9; text-align: center; max-width: 280px; }
  .spinner {
    width: 28px; height: 28px;
    border: 3px solid #4c566a;
    border-top-color: #88c0d0;
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="wrap">
    <div class="logo">V</div>
    <div class="title">Verstak Setup</div>
    <div class="sub">Подготовка установщика…<br>Подождите несколько секунд.</div>
    <div class="spinner" aria-hidden="true"></div>
  </div>
</body>
</html>`

function readAppVersion(): string {
  const candidates = [
    join(app.getAppPath(), 'package.json'),
    join(process.resourcesPath, '..', 'package.json'),
    join(HERE, '../../package.json'),
  ]
  for (const pkgPath of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
      if (pkg.version) return pkg.version
    } catch {
      // try next
    }
  }
  return '0.0.0'
}

let splashWindow: BrowserWindow | null = null
let mainWindow: BrowserWindow | null = null

function resolvePreload(): string {
  if (process.env.ELECTRON_RENDERER_URL) {
    return join(HERE, '../preload/installer.mjs')
  }
  return join(app.getAppPath(), 'out/preload/installer.mjs')
}

function resolveRenderer(): string {
  if (process.env.ELECTRON_RENDERER_URL) {
    return `${process.env.ELECTRON_RENDERER_URL}/installer.html`
  }
  return join(app.getAppPath(), 'out/renderer/installer.html')
}

function createSplashWindow(): void {
  splashWindow = new BrowserWindow({
    width: 380,
    height: 260,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    center: true,
    show: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#2e3440',
    title: PRODUCT_NAME,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  void splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH_HTML)}`)
  splashWindow.on('closed', () => {
    splashWindow = null
  })
}

function closeSplashWindow(): void {
  if (!splashWindow) return
  const win = splashWindow
  splashWindow = null
  win.close()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 780,
    height: 520,
    minWidth: 700,
    minHeight: 480,
    resizable: false,
    maximizable: false,
    frame: false,
    show: false,
    backgroundColor: '#2e3440',
    title: PRODUCT_NAME,
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const target = resolveRenderer()
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    closeSplashWindow()
    dialog.showErrorBox('Verstak Setup', `Не удалось загрузить интерфейс (${code}): ${description}\n${url}`)
    app.quit()
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(target)
  } else {
    void mainWindow.loadFile(target).catch((err: Error) => {
      closeSplashWindow()
      dialog.showErrorBox('Verstak Setup', `loadFile: ${err.message}\n${target}`)
      app.quit()
    })
  }

  mainWindow.once('ready-to-show', () => {
    closeSplashWindow()
    mainWindow?.show()
    mainWindow?.focus()
  })

  mainWindow.on('maximize', () => mainWindow?.webContents.send('installer:window:maximized', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('installer:window:maximized', false))
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function getWindow(): BrowserWindow {
  if (!mainWindow) throw new Error('Installer window is not ready')
  return mainWindow
}

app.setName(PRODUCT_NAME)
process.title = 'VERSTAK SETUP'

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    createSplashWindow()
    createWindow()

    ipcMain.handle('installer:getDefaults', async () => getInstallDefaults(readAppVersion(), 'Verstak'))

    ipcMain.handle('installer:browseDirectory', async (_event, current: string) => {
      const result = await dialog.showOpenDialog(getWindow(), {
        title: 'Папка установки Verstak',
        defaultPath: current || undefined,
        properties: ['openDirectory', 'createDirectory'],
      })
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    })

    ipcMain.handle('installer:install', async (_event, installDir: string) => {
      const win = getWindow()
      return runInstall(installDir, readAppVersion(), (progress) => {
        win.webContents.send('installer:progress', progress)
      })
    })

    ipcMain.handle('installer:launchApp', async (_event, installDir: string) => {
      launchInstalledApp(installDir)
    })

    ipcMain.handle('installer:window:minimize', () => getWindow().minimize())
    ipcMain.handle('installer:window:maximize', () => {
      const win = getWindow()
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    })
    ipcMain.handle('installer:window:close', () => getWindow().close())
    ipcMain.handle('installer:window:isMaximized', () => getWindow().isMaximized())
  })

  app.on('window-all-closed', () => app.quit())
}

process.on('uncaughtException', (err) => {
  closeSplashWindow()
  dialog.showErrorBox('Verstak Setup', err.message)
  app.quit()
})