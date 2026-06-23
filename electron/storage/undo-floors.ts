/**
 * Отслеживает активные floor'ы чекпоинтов на проект для защиты undo-записей от
 * prune. Несколько чатов могут держать чекпоинты в ОДНОМ проекте одновременно.
 *
 * Раньше floor был один на проект (Map<string, number>) и второй чекпоинт
 * перетирал первый: записи между двумя чекпоинтами теряли защиту и пруньялись,
 * из-за чего откат к раннему чекпоинту первого чата был неполным (частичный
 * откат без сигнала). Теперь храним ВСЕ активные floor'ы и защищаем по
 * минимуму — регион самого старого чекпоинта, чтобы выжили все. (F3, ревью 23.06)
 */

/** id больше любого реального autoincrement → «защиты нет». */
export const NO_FLOOR = Number.MAX_SAFE_INTEGER

export interface FloorTracker {
  /** Открыт чекпоинт на этом id — защитить записи новее него. */
  add(projectPath: string, floorId: number): void
  /** Чекпоинт израсходован: снять конкретный floor, или ВСЕ для проекта если id не задан. */
  remove(projectPath: string, floorId?: number): void
  /** Эффективный floor: записи с id > него не пруньются. MIN активных, иначе NO_FLOOR. */
  effective(projectPath: string): number
}

export function createFloorTracker(): FloorTracker {
  const floors = new Map<string, number[]>()
  return {
    add(projectPath, floorId) {
      const arr = floors.get(projectPath)
      if (arr) arr.push(floorId)
      else floors.set(projectPath, [floorId])
    },
    remove(projectPath, floorId) {
      if (floorId === undefined) { floors.delete(projectPath); return }
      const arr = floors.get(projectPath)
      if (!arr) return
      const i = arr.indexOf(floorId)
      if (i >= 0) arr.splice(i, 1)
      if (arr.length === 0) floors.delete(projectPath)
    },
    effective(projectPath) {
      const arr = floors.get(projectPath)
      if (!arr || arr.length === 0) return NO_FLOOR
      return Math.min(...arr)
    },
  }
}
