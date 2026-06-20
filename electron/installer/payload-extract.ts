import { createHash } from 'crypto'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs'
import type { Dirent } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const REQUIRED_FILES = ['Verstak.exe', join('resources', 'app.asar')]
const APP_ASAR_MIN_BYTES = 10_000_000

function sevenZipExe(): string {
  const bundled = join(process.resourcesPath, '7za.exe')
  if (existsSync(bundled)) return bundled
  throw new Error('Не найден 7za.exe в установщике. Пересоберите Verstak Setup.')
}

function cacheKeyForArchive(archivePath: string): string {
  const st = statSync(archivePath)
  const raw = `${archivePath}|${st.size}|${st.mtimeMs}`
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

function cacheDirForArchive(archivePath: string): string {
  return join(tmpdir(), 'verstak-setup', cacheKeyForArchive(archivePath))
}

export function verifyPayloadRoot(root: string): void {
  for (const rel of REQUIRED_FILES) {
    const abs = join(root, rel)
    if (!existsSync(abs)) {
      throw new Error(`Повреждён архив приложения: отсутствует ${rel}. Перезапустите установщик.`)
    }
    const size = statSync(abs).size
    if (rel.includes('app.asar') && size < APP_ASAR_MIN_BYTES) {
      throw new Error(`Повреждён архив приложения: пустой файл ${rel}. Перезапустите установщик.`)
    }
    if (size <= 0) {
      throw new Error(`Повреждён архив приложения: пустой файл ${rel}. Перезапустите установщик.`)
    }
  }
}

function extract7z(archivePath: string, outDir: string): void {
  mkdirSync(outDir, { recursive: true })
  const sevenZip = sevenZipExe()
  const result = spawnSync(
    sevenZip,
    ['x', archivePath, `-o${outDir}`, '-y', '-bso0', '-bsp0'],
    { windowsHide: true, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(
      detail
        ? `Не удалось распаковать архив приложения: ${detail}`
        : 'Не удалось распаковать архив приложения (7za). Перезапустите установщик.',
    )
  }
  verifyPayloadRoot(outDir)
}

export function resolvePayloadFromArchive(archivePath: string): string {
  const cached = cacheDirForArchive(archivePath)
  try {
    verifyPayloadRoot(cached)
    return cached
  } catch {
    // cache miss or corrupt — extract again
  }

  extract7z(archivePath, cached)

  // Optional manifest sanity check (non-fatal if missing).
  try {
    const manifestPath = join(cached, 'payload-manifest.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        fileCount?: number
        payloadBytes?: number
      }
      if (typeof manifest.fileCount === 'number') {
        let actualCount = 0
        const walk = (dir: string): void => {
          for (const entry of readdirSync(dir, { withFileTypes: true }) as Dirent[]) {
            const abs = join(dir, entry.name)
            if (entry.isDirectory()) walk(abs)
            else if (entry.isFile()) actualCount += 1
          }
        }
        walk(cached)
        if (actualCount < manifest.fileCount) {
          throw new Error(
            `Неполная распаковка: ${actualCount} из ${manifest.fileCount} файлов. Перезапустите установщик.`,
          )
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Неполная распаковка')) throw err
  }

  return cached
}
