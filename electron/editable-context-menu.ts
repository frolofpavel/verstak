/**
 * Контекстное меню редактируемого поля (2.9.2).
 *
 * ЖИВОЙ ФАКТ. Пользователь @lovelymist не смог вставить ключ Verstak Gateway
 * правой кнопкой: «пытаюсь вставить ключ, но не выдаёт». У Electron нет
 * контекстного меню по умолчанию — Chromium лишь сообщает событие
 * `context-menu`, а меню обязано построить приложение. Подписки не было ни
 * одной, поэтому правый клик в любом поле ввода не давал ничего, тогда как
 * Ctrl+V работал всегда (он идёт мимо меню) — дефект выглядел «выборочным».
 *
 * ГРАНИЦА. Меню строится ТОЛЬКО для редактируемого элемента. На проекте, чате
 * и обычном тексте возвращается null: там своё renderer-меню, и системное
 * поверх него не нужно. Встроенный браузер (webview) эту проводку не получает
 * вовсе — см. ветку типа webContents в main.ts.
 *
 * СЕКРЕТЫ. Меню собрано из ролей Electron и не содержит ни выделенного текста,
 * ни значения поля: ключ из замаскированного поля не должен попасть ни в
 * подпись пункта, ни в лог. Буфер обмена здесь не читается — вставку выполняет
 * сам Chromium по роли `paste`.
 */

export type EditableMenuRole = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'

/** Что Chromium разрешает в этом поле прямо сейчас (params.editFlags). */
export interface EditableContextMenuFlags {
  canUndo?: boolean
  canRedo?: boolean
  canCut?: boolean
  canCopy?: boolean
  canPaste?: boolean
  canSelectAll?: boolean
}

/** Подмножество params события `context-menu`, которое нас касается. */
export interface EditableContextMenuInput {
  isEditable?: boolean
  editFlags?: EditableContextMenuFlags
}

export type EditableContextMenuItem =
  | { type: 'separator' }
  | { role: EditableMenuRole; label: string; enabled: boolean }

/**
 * Подписи задаются явно, а не отдаются роли. ЗАМЕР на живом Electron 40
 * (`npm run smoke:context-menu`): роль без label даёт «Undo/Cut/Paste/Select
 * All» даже на русской Windows — строки ролей Electron не локализует. В
 * русском интерфейсе такое меню выглядит чужим.
 *
 * ГРАНИЦА, названная честно: подписи здесь только русские. Английский
 * интерфейс (`app_language = en`) получит русские пункты. Язык живёт в
 * настройках renderer'а, главному процессу он сейчас не прокинут; когда
 * английская локаль станет заявленной, сюда придёт параметр языка.
 */
const LABELS: Record<EditableMenuRole, string> = {
  undo: 'Отменить',
  redo: 'Повторить',
  cut: 'Вырезать',
  copy: 'Копировать',
  paste: 'Вставить',
  selectAll: 'Выделить всё',
}

/**
 * Шаблон меню для редактируемого поля; null — меню показывать не надо.
 *
 * Флаг, которого нет, считается разрешающим: Chromium присылает editFlags
 * всегда, но меню, целиком серое из-за неожиданно пустого объекта, выглядит
 * поломкой сильнее, чем его отсутствие.
 */
export function buildEditableContextMenu(params: EditableContextMenuInput): EditableContextMenuItem[] | null {
  if (!params?.isEditable) return null
  const flags = params.editFlags ?? {}
  const allowed = (flag: boolean | undefined) => flag !== false
  const item = (role: EditableMenuRole, flag: boolean | undefined): EditableContextMenuItem =>
    ({ role, label: LABELS[role], enabled: allowed(flag) })
  return [
    item('undo', flags.canUndo),
    item('redo', flags.canRedo),
    { type: 'separator' },
    item('cut', flags.canCut),
    item('copy', flags.canCopy),
    item('paste', flags.canPaste),
    { type: 'separator' },
    item('selectAll', flags.canSelectAll),
  ]
}
