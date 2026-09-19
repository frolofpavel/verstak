// Фикстура живого смоука контекстного меню: настоящий Electron, настоящий
// Chromium, настоящий правый клик. Решение о меню принимает ПРОДУКТОВАЯ
// функция (собирается esbuild'ом из electron/editable-context-menu.ts и
// передаётся сюда путём в SMOKE_MENU_MODULE) — копии логики здесь нет.
const { app, BrowserWindow, Menu, clipboard } = require('electron')
const path = require('path')

const { buildEditableContextMenu } = require(process.env.SMOKE_MENU_MODULE)
const CLIPBOARD_VALUE = process.env.SMOKE_CLIPBOARD || 'TEST_CLIPBOARD_VALUE'

const wait = ms => new Promise(r => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 600, height: 300, show: true, webPreferences: { contextIsolation: true } })
  await win.loadFile(path.join(__dirname, 'context-menu-host.html'))

  const seen = []
  win.webContents.on('context-menu', (_e, params) => {
    seen.push({
      isEditable: params.isEditable,
      editFlags: { ...params.editFlags },
      template: buildEditableContextMenu(params),
    })
  })

  const rightClick = async id => {
    const at = await win.webContents.executeJavaScript(
      `(() => { const el = document.getElementById('${id}'); el.focus && el.focus();
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`
    )
    win.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'right', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'right', clickCount: 1 })
    await wait(400)
  }

  clipboard.writeText(CLIPBOARD_VALUE)

  await rightClick('key')
  const onField = seen[seen.length - 1] || null

  // Подписи берём у РЕАЛЬНОГО меню Electron — именно их увидит человек.
  let labels = []
  let pasted = null
  let maskedAfterPaste = null
  if (onField && onField.template) {
    const menu = Menu.buildFromTemplate(onField.template)
    labels = menu.items.map(i => ({ role: i.role || i.type, label: i.label, enabled: i.enabled }))
    const before = await win.webContents.executeJavaScript(`document.getElementById('key').value`)
    // ГРАНИЦА ЗАМЕРА. Выбор пункта в нативном меню Windows автоматизировать
    // нельзя: меню принадлежит системе, а не странице, и sendInputEvent в него
    // не попадает (проверено — MenuItem.click() роль вне показанного меню тоже
    // не исполняет). Поэтому выполняем ровно то действие, которое стоит за
    // ролью `paste`: webContents.paste(). Измеряется настоящая вставка в
    // настоящее замаскированное поле; не измеряется лишь щелчок мышью по
    // системному меню.
    win.webContents.paste()
    await wait(300)
    const after = await win.webContents.executeJavaScript(`document.getElementById('key').value`)
    maskedAfterPaste = await win.webContents.executeJavaScript(`document.getElementById('key').type`)
    pasted = { before, after }
  }

  // Контроль ПОСЛЕ вставки: он уводит фокус из поля, поэтому раньше делать его
  // нельзя — иначе вставка меряется не там, где идёт правый клик.
  await rightClick('plain')
  const onPlain = seen[seen.length - 1] || null

  console.log('SMOKE ' + JSON.stringify({
    field: onField && { isEditable: onField.isEditable, canPaste: onField.editFlags.canPaste,
      canCopy: onField.editFlags.canCopy, hasTemplate: !!onField.template },
    plain: onPlain && { isEditable: onPlain.isEditable, hasTemplate: !!onPlain.template },
    labels,
    pasted,
    maskedAfterPaste,
  }))
  app.quit()
}).catch(err => {
  console.log('SMOKE ' + JSON.stringify({ error: String(err && err.stack || err) }))
  app.quit()
})
