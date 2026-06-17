import { createHash } from 'crypto'
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { app } from 'electron'

export type PendingUpdateMeta = {
  fileName: string
  sha512: string
  isAdminRightsRequired?: boolean
}

/** %LOCALAPPDATA%\verstak-updater — каталог electron-updater. */
export function getUpdaterCacheRoot(): string {
  return join(app.getPath('localAppData'), `${app.getName().toLowerCase()}-updater`)
}

export function getPendingUpdateDir(): string {
  return join(getUpdaterCacheRoot(), 'pending')
}

export async function hashFileSha512Base64(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    const stream = createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 })
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('base64')))
  })
}

/** Удаляет pending-установщик (петля «установить ту же версию»). */
export function clearPendingUpdateCache(): void {
  const pending = getPendingUpdateDir()
  if (!existsSync(pending)) return
  try {
    rmSync(pending, { recursive: true, force: true })
  } catch (err) {
    console.warn('[updater] clear pending cache failed:', err)
  }
}

/** Сбрасывает битый дифференциальный кэш в корне (installer.exe без update-info.json). */
export function clearBrokenDifferentialCache(): void {
  const root = getUpdaterCacheRoot()
  for (const name of ['installer.exe', 'current.blockmap']) {
    const p = join(root, name)
    if (!existsSync(p)) continue
    try {
      rmSync(p, { force: true })
    } catch (err) {
      console.warn('[updater] clear broken cache failed:', name, err)
    }
  }
}

function writePendingMeta(fileName: string, sha512: string): void {
  const pending = getPendingUpdateDir()
  mkdirSync(pending, { recursive: true })
  const meta: PendingUpdateMeta = {
    fileName,
    sha512,
    isAdminRightsRequired: false,
  }
  writeFileSync(join(pending, 'update-info.json'), JSON.stringify(meta))
}

/**
 * electron-updater иногда оставляет полный установщик вне pending/ без update-info.json
 * (дифференциальное скачивание). Если sha512 совпадает — восстанавливаем pending-кэш.
 */
export async function reconcileCachedDownload(
  fileName: string,
  sha512: string,
  expectedSize: number,
): Promise<string | null> {
  const root = getUpdaterCacheRoot()
  const pending = getPendingUpdateDir()
  const infoPath = join(pending, 'update-info.json')

  if (existsSync(infoPath)) {
    try {
      const meta = JSON.parse(readFileSync(infoPath, 'utf8')) as PendingUpdateMeta
      const cached = join(pending, meta.fileName)
      if (existsSync(cached)) {
        const size = statSync(cached).size
        if (expectedSize > 0 && size !== expectedSize) {
          /* broken pending — fall through */
        } else if (!sha512 || meta.sha512 === sha512) {
          // Уже валидный pending-кэш electron-updater — не перечитываем 250+ МБ на sha512.
          return cached
        } else {
          const hash = await hashFileSha512Base64(cached)
          if (hash === sha512) return cached
        }
      }
    } catch { /* fall through */ }
  }

  const candidates = [
    join(pending, fileName),
    join(root, fileName),
    join(root, 'installer.exe'),
    join(pending, 'installer.exe'),
  ]

  for (const source of candidates) {
    if (!existsSync(source)) continue
    if (expectedSize > 0 && statSync(source).size !== expectedSize) continue
    if (sha512) {
      const hash = await hashFileSha512Base64(source)
      if (hash !== sha512) continue
    }

    const target = join(pending, fileName)
    mkdirSync(pending, { recursive: true })
    if (source !== target) {
      copyFileSync(source, target)
    }
    const resolvedSha = sha512 || await hashFileSha512Base64(target)
    writePendingMeta(fileName, resolvedSha)
    clearBrokenDifferentialCache()
    return target
  }

  return null
}