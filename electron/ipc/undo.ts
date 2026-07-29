import { ipcMain } from 'electron'
import { writeFile, unlink, stat } from 'fs/promises'
import type { UndoEntry, UndoStack } from '../storage/undo'
import { safeRealJoin } from '../ai/path-policy'

/** Результат отката к чекпоинту (shape совпадает с api.d.ts undo.revertToCheckpoint). */
export interface RevertToCheckpointResult {
  ok: boolean
  restored: string[]
  count: number
  failed?: Array<{ id: number; filePath: string; reason: string }>
}

/**
 * Откатить каждую undo-запись с id > checkpointId. Pop'ает их newest-first,
 * чтобы зависимые правки восстанавливались в правильном порядке. checkpointId=0
 * — случай «чекпоинт на пустом стеке»: у каждой записи id > 0, поэтому фильтр
 * естественно откатывает всё.
 *
 * Вынесено из ipc-хендлера, чтобы Dev Task Flow (ipc/dev-task.ts) переиспользовал
 * РОВНО ТОТ ЖЕ откат через тот же UndoStack — без дублирования логики и без
 * заведения отдельного стека. На ошибке re-push'ит непрошедшие записи для retry.
 */
export async function revertToCheckpoint(
  stack: UndoStack,
  projectPath: string,
  checkpointId: number
): Promise<RevertToCheckpointResult> {
  const all = stack.list(projectPath)
  const toRevert = all.filter(e => e.id > checkpointId)
  if (toRevert.length === 0) return { ok: true, restored: [], count: 0 }
  const restored: string[] = []
  const failed: Array<{ id: number; filePath: string; before: string | null; after: string; reason: string }> = []
  // Newest first — undo entries reflect chronological writes; reversing
  // them restores files in their proper rollback order.
  for (const entry of toRevert) {
    const popped = stack.pop(entry.id)
    if (!popped) continue
    try {
      const abs = await safeRealJoin(projectPath, popped.filePath)
      const before = popped.beforeContent
      // null = файла не было до записи → удаляем. Пустой существовавший файл
      // (before='') идёт в else и восстанавливается, а не удаляется (B4).
      if (before === null) {
        try {
          await stat(abs)
          await unlink(abs)
        } catch (err) {
          // ENOENT = файла уже нет → цель (отсутствие) достигнута, ОК. Любая
          // ДРУГАЯ ошибка (EACCES/EBUSY/EPERM — файл залочен/каталог) НЕ глотается:
          // пробрасываем в outer catch → попадёт в failed[]/ok:false для видимости
          // и ретрая (раньше молча помечалось restored — ревью 23.06 #1).
          if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
        }
      } else {
        await writeFile(abs, before, 'utf8')
      }
      restored.push(popped.filePath)
    } catch (err) {
      failed.push({
        id: popped.id,
        filePath: popped.filePath,
        before: popped.beforeContent,
        after: popped.afterContent ?? '',
        reason: err instanceof Error ? err.message : String(err)
      })
    }
  }
  // Re-push проваленных записей ДО снятия floor-защиты (ре-ревью LOW): иначе при >50
  // проваленных ревертах floor снимался первым → prune внутри push резал новые записи,
  // и часть failed[] теряла beforeContent (нечего было бы ретраить). Порядок: сначала
  // вернуть в стек, потом снять защиту.
  for (const f of failed) {
    stack.push(projectPath, f.filePath, f.before, f.after)
  }
  // Чекпоинт израсходован — снимаем защиту ИМЕННО этого чекпоинта (review fix #4).
  // floorId = checkpointId: при мульти-чате защиты других чекпоинтов остаются (F3).
  stack.clearProtection(projectPath, checkpointId)
  if (failed.length > 0) {
    return { ok: false, restored, count: restored.length, failed: failed.map(f => ({ id: f.id, filePath: f.filePath, reason: f.reason })) }
  }
  return { ok: true, restored, count: restored.length }
}

/**
 * Undo-запись БЕЗ содержимого файла — то, что видит renderer.
 *
 * Стек отката хранит СЫРОЕ «до» и «после»: с 29.07 путь записи читает файл
 * мимо secret-scanner, иначе откат писал бы на диск `[REDACTED:…]` вместо
 * живого секрета. Значит содержимое в стеке — настоящие секреты пользователя, и
 * отдавать его в renderer нельзя: это тот периметр, откуда содержимое утекает
 * наружу (запись экрана, демонстрация, RDP, DevTools и DOM, буфер обмена).
 *
 * ПОЧЕМУ ОТКАЗ, А НЕ МАСКА, КАК В ДИФФЕ. Дифф маскируют потому, что его ПОКАЗЫВАЮТ
 * — человек по нему принимает решение. Здесь показывать нечего: содержимое из
 * этого канала не читает никто (ни одного вызова `undo.list` в renderer), а весь
 * откат — `undo:revert`, `undo:revertToCheckpoint`, exact-rewind, dev-task —
 * работает со стеком внутри main напрямую. Маскировать неиспользуемое значило бы
 * гонять файл целиком через IPC без пользы и оставить сигнал «это безопасно
 * показывать», приглашая будущего потребителя отрисовать блоб не думая. Появится
 * экран истории отката — там и решать, что показывать; механика маски уже есть.
 */
export interface UndoEntrySummary {
  id: number
  filePath: string
  createdAt: number
  /**
   * Существовал ли файл ДО записи. Единственное, что решение об откате берёт из
   * содержимого: не существовал → откат УДАЛЯЕТ файл, а не восстанавливает его
   * пустым (B4). Поэтому отдаём флагом, а не текстом.
   *
   * Из `beforeHash === null` это НЕ выводится: миграция провенанса append-only,
   * у legacy-записей хеши null при живом содержимом.
   */
  existedBefore: boolean
  runId: string | null
  chatId: number | null
  messageId: number | null
  beforeHash: string | null
  afterHash: string | null
}

export function summarizeUndoEntry(entry: UndoEntry): UndoEntrySummary {
  return {
    id: entry.id,
    filePath: entry.filePath,
    createdAt: entry.createdAt,
    existedBefore: entry.beforeContent !== null,
    runId: entry.runId,
    chatId: entry.chatId,
    messageId: entry.messageId,
    beforeHash: entry.beforeHash,
    afterHash: entry.afterHash
  }
}

export function registerUndoIpc(stack: UndoStack): void {
  ipcMain.handle('undo:list', (_e, projectPath: string) => stack.list(projectPath).map(summarizeUndoEntry))
  ipcMain.handle('undo:count', (_e, projectPath: string) => stack.count(projectPath))
  ipcMain.handle('undo:clear', (_e, projectPath: string) => { stack.clearProtection(projectPath); return stack.clear(projectPath) })

  /**
   * Snap a checkpoint at the current top of the undo stack. Returns the id
   * of the latest entry, or 0 if the stack is empty (0 is below any real
   * autoincrement id, so `id > 0` matches every future entry). The renderer
   * stores 0 the same as any other id — no null sentinel needed.
   */
  ipcMain.handle('undo:checkpoint', (_e, projectPath: string) => {
    const list = stack.list(projectPath)
    const id = list.length > 0 ? list[0].id : 0
    // Защитить все будущие записи этой сессии (id > id) от prune, чтобы откат к
    // чекпоинту был полным даже при >50 правках (review fix #4).
    stack.protectFrom(projectPath, id)
    return id
  })

  /**
   * Revert every undo entry created AFTER `checkpointId`. Pops them newest-
   * first so dependent writes restore in the right order. `checkpointId=0`
   * is the "checkpoint at empty stack" case — every entry has id > 0, so the
   * filter naturally reverts everything.
   *
   * Returns the list of files restored + count, or { ok: false, reason } if
   * something blew up halfway. On failure we re-push popped-but-unrestored
   * entries so the user can retry.
   */
  ipcMain.handle('undo:revertToCheckpoint', (_e, projectPath: string, checkpointId: number) =>
    revertToCheckpoint(stack, projectPath, checkpointId)
  )

  // Pop the most recent (or specific) entry and restore the file's previous state.
  ipcMain.handle('undo:revert', async (_e, projectPath: string, id?: number) => {
    let entry = null
    if (id != null) {
      entry = stack.pop(id)
    } else {
      const list = stack.list(projectPath)
      if (list.length > 0) entry = stack.pop(list[0].id)
    }
    if (!entry) return { ok: false, reason: 'no entries' }
    try {
      // safeRealJoin: textual + symlink-aware. Same enforcement as
      // ai-tools and files.ts — no third path-policy drift.
      const abs = await safeRealJoin(projectPath, entry.filePath)
      const before = entry.beforeContent
      // null = файла не было до записи → удаляем. Пустой существовавший файл
      // (before='') восстанавливается в else, а не удаляется (B4).
      if (before === null) {
        try {
          await stat(abs)
          await unlink(abs)
        } catch (err) {
          // ENOENT = файла уже нет → цель (отсутствие) достигнута, ОК. Любая
          // ДРУГАЯ ошибка (EACCES/EBUSY/EPERM — файл залочен/каталог) НЕ глотается:
          // пробрасываем в outer catch → попадёт в failed[]/ok:false для видимости
          // и ретрая (раньше молча помечалось restored — ревью 23.06 #1).
          if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
        }
      } else {
        await writeFile(abs, before, 'utf8')
      }
      return { ok: true, filePath: entry.filePath }
    } catch (err) {
      // Put it back on the stack so the user can retry
      stack.push(projectPath, entry.filePath, entry.beforeContent, entry.afterContent ?? '')
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  })
}
