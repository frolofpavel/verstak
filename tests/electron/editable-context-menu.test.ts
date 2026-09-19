// Правый клик в поле ввода даёт «Вставить» — 2.9.2.
//
// ЖИВОЙ ФАКТ. Пользователь @lovelymist не смог вставить ключ Verstak Gateway:
// «пытаюсь вставить ключ, но не выдаёт, если нажимаю правую кнопку»; 18.09
// подтвердил повторно — «не работает, можно в целом и вручную ввести». Ключ
// длинный, вводить руками его никто не будет, поэтому первый экран подключения
// упирался в тупик у того, кто копирует ключ из кабинета.
//
// ПРИЧИНА КЛАССА. У Electron нет контекстного меню «из коробки»: Chromium его
// рисует сам, а Electron отдаёт приложению событие `context-menu` и ждёт, что
// меню построят. В главном процессе не было ни одной подписки на это событие
// (ни `Menu.buildFromTemplate`, ни `webContents.on('context-menu')`), поэтому
// правый клик в ЛЮБОМ поле ввода не давал ничего. Ctrl+V работал всегда —
// он идёт мимо меню, и потому дефект выглядел «выборочным».
//
// ГРАНИЦА. Меню появляется ТОЛЬКО на редактируемом элементе. Правый клик по
// проекту и по чату остаётся за renderer-меню (`ProjectRail`, `Sidebar`), а
// встроенный браузер (webview) этой проводки не получает вовсе: его страницы
// недоверенные, и системное меню на них — отдельный вопрос со своей политикой.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { buildEditableContextMenu } from '../../electron/editable-context-menu'

const ROOT = join(__dirname, '..', '..')

/** Как Chromium описывает обычное текстовое поле: можно всё. */
const PLAIN_INPUT = {
  isEditable: true,
  editFlags: {
    canUndo: true, canRedo: false, canCut: true,
    canCopy: true, canPaste: true, canSelectAll: true,
  },
}

/** Как Chromium описывает <input type="password">: копировать и вырезать
 *  нельзя (браузер не отдаёт наружу содержимое пароля), а вставлять — можно.
 *  Ровно этот случай и есть поле ключа Gateway. */
const PASSWORD_INPUT = {
  isEditable: true,
  editFlags: {
    canUndo: false, canRedo: false, canCut: false,
    canCopy: false, canPaste: true, canSelectAll: true,
  },
}

describe('2.9.2 · контекстное меню редактируемого поля', () => {
  it('в поле ключа (input type=password) есть «Вставить», и он доступен', () => {
    const menu = buildEditableContextMenu(PASSWORD_INPUT)
    const paste = menu?.find(item => 'role' in item && item.role === 'paste')
    expect(paste, 'в замаскированном поле нет пункта вставки — ровно жалоба @lovelymist').toBeTruthy()
    expect(paste && 'enabled' in paste ? paste.enabled : false,
      'пункт вставки есть, но выключен — вставить ключ по-прежнему нельзя').toBe(true)
  })

  it('меню содержит шесть штатных команд правки в привычном порядке', () => {
    const roles = (buildEditableContextMenu(PLAIN_INPUT) ?? [])
      .filter(item => 'role' in item)
      .map(item => ('role' in item ? item.role : ''))
    expect(roles).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
  })

  it('пункты подписаны по-русски, как остальной интерфейс', () => {
    // ЗАМЕР на живом Electron: роль без подписи даёт «Paste» даже на русской
    // Windows — строки ролей Electron не локализует (npm run smoke:context-menu).
    const labels = (buildEditableContextMenu(PLAIN_INPUT) ?? [])
      .filter(item => 'label' in item)
      .map(item => ('label' in item ? item.label : ''))
    expect(labels).toEqual(['Отменить', 'Повторить', 'Вырезать', 'Копировать', 'Вставить', 'Выделить всё'])
  })

  it('доступность пунктов берётся из editFlags Chromium, а не назначается на глаз', () => {
    const menu = buildEditableContextMenu(PASSWORD_INPUT) ?? []
    const enabledOf = (role: string) => {
      const item = menu.find(i => 'role' in i && i.role === role)
      return item && 'enabled' in item ? item.enabled : null
    }
    // Пароль нельзя скопировать и вырезать — Chromium это и сообщает.
    expect(enabledOf('copy')).toBe(false)
    expect(enabledOf('cut')).toBe(false)
    // Контроль «происходит»: в обычном поле те же пункты живые.
    const plain = buildEditableContextMenu(PLAIN_INPUT) ?? []
    const plainCopy = plain.find(i => 'role' in i && i.role === 'copy')
    expect(plainCopy && 'enabled' in plainCopy ? plainCopy.enabled : null).toBe(true)
  })

  it('без editFlags меню остаётся рабочим, а не мёртвым', () => {
    // Флаги приходят от Chromium всегда, но предполагать это опасно: пустое
    // меню со всеми серыми пунктами выглядит поломкой сильнее, чем их отсутствие.
    const menu = buildEditableContextMenu({ isEditable: true }) ?? []
    const paste = menu.find(i => 'role' in i && i.role === 'paste')
    expect(paste && 'enabled' in paste ? paste.enabled : null).toBe(true)
  })

  it('на нередактируемом элементе меню не строится вовсе', () => {
    // Правый клик по проекту, чату, тексту ответа — чужая зона: там своё
    // renderer-меню либо ничего. Нативное поверх него быть не должно.
    expect(buildEditableContextMenu({ isEditable: false })).toBeNull()
    expect(buildEditableContextMenu({ isEditable: false, editFlags: { canPaste: true } })).toBeNull()
    expect(buildEditableContextMenu({})).toBeNull()
  })

  it('содержимое поля в меню не попадает', () => {
    // Меню строится из ролей, а не из текста. Значение секретного поля не
    // должно оказаться ни в подписи, ни в любом другом месте шаблона.
    const menu = buildEditableContextMenu({
      ...PASSWORD_INPUT,
      selectionText: 'sk-live-TOP-SECRET-VALUE',
    } as Parameters<typeof buildEditableContextMenu>[0])
    expect(JSON.stringify(menu)).not.toContain('TOP-SECRET')
  })
})

// Пин на ИСТОЧНИК: правильная функция, которую никто не зовёт, — ложная
// закрытость (приём проекта, см. main-window-navigation.test.ts). В main.ts
// тесты не заходят, поэтому проверяем текстом.
describe('2.9.2 · main.ts подключает меню к главному окну и только к нему', () => {
  const main = readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf8')

  it('подписка на context-menu стоит в ветке окна приложения', () => {
    const windowBranch = main.indexOf("contents.getType() === 'window'")
    const webviewBranch = main.indexOf("contents.getType() === 'webview'")
    const handler = main.indexOf("'context-menu'")
    expect(handler, 'обработчика context-menu в main.ts нет — правый клик по-прежнему молчит')
      .toBeGreaterThan(-1)
    expect(windowBranch).toBeGreaterThan(-1)
    expect(handler > windowBranch && (webviewBranch === -1 || handler < webviewBranch),
      'подписка стоит вне ветки главного окна — она достанется и встроенному браузеру').toBe(true)
  })

  it('решение о меню принимает buildEditableContextMenu, а не условие на месте', () => {
    expect(main).toContain('buildEditableContextMenu')
  })

  it('меню показывается только когда builder его вернул', () => {
    const idx = main.indexOf('buildEditableContextMenu(')
    const around = main.slice(idx, idx + 700)
    expect(around, 'меню строится, но не показывается').toContain('popup(')
  })

  it('во встроенный браузер меню не проводится', () => {
    const webviewBranch = main.indexOf("contents.getType() === 'webview'")
    if (webviewBranch === -1) return
    const tail = main.slice(webviewBranch)
    expect(tail, 'подписка на context-menu попала в ветку webview').not.toContain("'context-menu'")
  })
})
