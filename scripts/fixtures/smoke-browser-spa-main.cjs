// Хост живого смоука P3 (scripts/smoke-browser-spa.mjs): поднимает окно с <webview>,
// прикладывает к слоту продовый стиль и печатает одну строку замера «SMOKE {...}».
const { app, BrowserWindow } = require('electron')
const path = require('path')

app.whenReady().then(async () => {
  // Тот же форс webPreferences, что в продукте (electron/main.ts) — условия совпадают.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (_ev, wp) => {
      delete wp.preload
      wp.nodeIntegration = false
      wp.contextIsolation = true
      wp.webSecurity = true
    })
  })

  const win = new BrowserWindow({
    width: 1200, height: 900, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, webviewTag: true }
  })
  await win.loadFile(path.join(__dirname, 'smoke-browser-spa-host.html'))

  win.webContents.on('console-message', (a, _lvl, m) => {
    const msg = (a && a.message) ? a.message : m
    if (typeof msg === 'string' && msg.startsWith('SMOKE ')) {
      console.log(msg)
      setTimeout(() => app.exit(0), 150)
    }
  })

  const args = JSON.stringify({ url: process.env.SMOKE_URL, css: process.env.SMOKE_CSS })
  win.webContents.executeJavaScript('window.__run(' + args + ')')
  setTimeout(() => app.exit(2), 80000)
})
