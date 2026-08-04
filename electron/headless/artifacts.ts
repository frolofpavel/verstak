import { readdirSync, statSync } from 'fs'
import { join, relative, sep } from 'path'

import { safeRealJoin } from '../ai/path-policy'
import { isForbiddenPath } from '../ai/secret-scanner'

// Файлы задачи для выдачи наружу (кабинет облачного Verstak, запрос №4 Этапа 1б).
//
// Раньше это жило в прод-слое, и гейт пути был написан там заново. Здесь он один и
// тот же, что у инструментов агента: safeRealJoin разыменовывает и цель, и корень,
// поэтому symlink изнутри workspace наружу не проходит. Плюс secret-scanner: даже
// собственный .env задачи наружу не отдаём.

export interface WorkspaceFile {
  /** Путь относительно workspace, всегда через '/'. */
  path: string
  size: number
  mtime: number
}

const MAX_DEPTH = 6
const MAX_FILES = 500

/** Плоский список файлов workspace. Каталоги обходятся вглубь до MAX_DEPTH. */
export function listWorkspaceFiles(workspace: string): WorkspaceFile[] {
  const out: WorkspaceFile[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      if (out.length >= MAX_FILES) return
      const full = join(dir, name)
      let st: ReturnType<typeof statSync>
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) { walk(full, depth + 1); continue }
      const rel = relative(workspace, full).split(sep).join('/')
      // Секрето-подобные файлы не показываем даже списком: их имя — уже подсказка.
      if (isForbiddenPath(rel)) continue
      out.push({ path: rel, size: st.size, mtime: st.mtimeMs })
    }
  }
  walk(workspace, 0)
  return out
}

/**
 * Абсолютный путь артефакта или null, если выдавать нельзя.
 *
 * Отказ (а не исключение) — сознательно: наружу уходит одинаковый 404 и для «нет
 * файла», и для «выход за workspace», чтобы ответ не подсказывал, что за границей
 * что-то есть.
 */
export async function resolveArtifactPath(workspace: string, rel: string): Promise<string | null> {
  if (!rel || rel.includes('\0')) return null
  if (isForbiddenPath(rel)) return null
  let abs: string
  try {
    abs = await safeRealJoin(workspace, rel)
  } catch {
    return null // выход за пределы workspace (в т.ч. через symlink)
  }
  try {
    // safeRealJoin возвращает путь и для ещё не существующего файла (он рассчитан
    // и на запись) — для выдачи этого мало: проверяем, что это существующий файл.
    if (!statSync(abs).isFile()) return null
  } catch {
    return null
  }
  return abs
}
