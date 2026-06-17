import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getInstallDefaults, launchInstalledApp, runInstall } from './engine'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT_NAME = 'Verstak Setup'

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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 480,
    minWidth: 640,
    minHeight: 420,
    resizable: false,
    maximizable: false,
    frame: false,
    show: true,
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
    dialog.showErrorBox('Verstak Setup', `Не удалось загрузить интерфейс (${code}): ${description}\n${url}`)
    app.quit()
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(target)
  } else {
    void mainWindow.loadFile(target).catch((err: Error) => {
      dialog.showErrorBox('Verstak Setup', `loadFile: ${err.message}\n${target}`)
      app.quit()
    })
  }

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
  dialog.showErrorBox('Verstak Setup', err.message)
  app.quit()
})