import { app, nativeImage } from 'electron'
import { createHash } from 'crypto'
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { join, relative, isAbsolute, sep, extname } from 'path'
import { isForbiddenPath } from '../ai/secret-scanner'
import { canonicalPathForComparison } from '../ai/path-policy'

// Ревью F7: importProjectIcon принимал любой sourcePath из рендерера. Ограничиваем
// расширения изображениями (иначе скомпрометированный рендерер использовал бы
// импорт как канал чтения произвольного файла через icon-протокол).
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico'])

export function projectIconsDir(): string {
  const dir = join(app.getPath('userData'), 'project-icons')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * True, если путь лежит ВНУТРИ папки project-icons (userData/project-icons).
 * Защита от чтения/удаления произвольного файла: filePath/iconPath приходят
 * снаружи (protocol-хендлер, БД), и без этой проверки агент/renderer мог бы
 * подсунуть любой системный путь.
 */
export function isInsideProjectIcons(p: string): boolean {
  if (!p) return false
  // Ревью F6: текстовая проверка через resolve() обходилась symlink'ом внутри
  // project-icons, ведущим наружу (→ чтение/удаление произвольного файла через
  // gg-project-icon протокол). realpathSync разворачивает ссылки на обеих
  // сторонах; для несуществующих путей — textual fallback (нечего раскрывать).
  const dir = canonicalPathForComparison(projectIconsDir())
  const target = canonicalPathForComparison(p)
  const r = relative(dir, target)
  return r !== '' && !r.startsWith('..') && !r.includes('..' + sep) && !isAbsolute(r)
}

function iconDestPath(projectPath: string): string {
  const hash = createHash('sha256').update(projectPath).digest('hex').slice(0, 20)
  return join(projectIconsDir(), `${hash}.png`)
}

/** Copy & resize user image to stable PNG in userData. Returns absolute path. */
export function importProjectIcon(projectPath: string, sourcePath: string): string {
  // Ревью F7: валидируем источник ДО чтения. Только изображения и не секреты —
  // иначе рендерер мог бы скопировать произвольный файл в .png и прочитать его
  // обратно через icon-протокол (arbitrary file read).
  if (!sourcePath || typeof sourcePath !== 'string') throw new Error('Иконка: пустой путь')
  if (!IMAGE_EXTS.has(extname(sourcePath).toLowerCase())) {
    throw new Error('Иконка: поддерживаются только изображения (png/jpg/webp/gif/bmp/ico)')
  }
  if (isForbiddenPath(sourcePath)) throw new Error('Иконка: путь заблокирован (секрет/креды)')
  const img = nativeImage.createFromPath(sourcePath)
  if (img.isEmpty()) throw new Error('Не удалось прочитать изображение')
  const size = img.getSize()
  const maxSide = Math.max(size.width, size.height)
  const resized = maxSide > 128
    ? img.resize({ width: Math.round(size.width * 128 / maxSide), height: Math.round(size.height * 128 / maxSide), quality: 'best' })
    : img
  const dest = iconDestPath(projectPath)
  writeFileSync(dest, resized.toPNG())
  return dest
}

export function deleteProjectIconFile(iconPath: string | null | undefined): void {
  // Удаляем только файлы внутри project-icons — защита от unlink произвольного
  // пути, если iconPath окажется подделан.
  if (!iconPath || !isInsideProjectIcons(iconPath)) return
  if (!existsSync(iconPath)) return
  try { unlinkSync(iconPath) } catch { /* ignore */ }
}
