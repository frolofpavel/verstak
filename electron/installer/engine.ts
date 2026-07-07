import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname, join, relative } from 'path'

const STALE_UNPACKED = join('resources', 'app.asar.unpacked')

async function removeStaleUnpacked(installDir: string): Promise<void> {
  const unpacked = join(installDir, STALE_UNPACKED)
  await rm(unpacked, { recursive: true, force: true }).catch(() => {})
}
import { homedir } from 'os'
import type { InstallDefaults, InstallProgress, InstallResult } from './types'
import { createShortcut, psQuote, runPowerShell, setUninstallRegistry } from './shell'
import {
  defaultInstallDir,
  installedExePath,
  resolvePayloadRoot,
  uninstallScriptName,
} from './paths'

type FileEntry = { abs: string; rel: string; size: number }

async function walkFiles(root: string, dir = root): Promise<FileEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: FileEntry[] = []
  for (const entry of entries) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...await walkFiles(root, abs))
    } else if (entry.isFile()) {
      const st = await stat(abs)
      out.push({ abs, rel: relative(root, abs), size: st.size })
    }
  }
  return out
}

export async function collectPayloadStats(payloadRoot: string): Promise<{ fileCount: number; payloadBytes: number }> {
  const files = await walkFiles(payloadRoot)
  return {
    fileCount: files.length,
    payloadBytes: files.reduce((sum, f) => sum + f.size, 0),
  }
}

async function readPayloadManifest(payloadRoot: string): Promise<{ fileCount: number; payloadBytes: number } | null> {
  try {
    const raw = await readFile(join(payloadRoot, 'payload-manifest.json'), 'utf8')
    const parsed = JSON.parse(raw) as { fileCount?: number; payloadBytes?: number }
    if (typeof parsed.fileCount === 'number' && typeof parsed.payloadBytes === 'number') {
      return { fileCount: parsed.fileCount, payloadBytes: parsed.payloadBytes }
    }
  } catch {
    // fall back to directory walk
  }
  return null
}

async function readPackagedPayloadManifest(): Promise<{ fileCount: number; payloadBytes: number } | null> {
  const candidates = [
    join(process.resourcesPath, 'app-payload-manifest.json'),
    join(process.cwd(), 'release', 'app-payload-manifest.json'),
    join(process.cwd(), 'release', 'app-payload-staging', 'payload-manifest.json'),
  ]
  for (const manifestPath of candidates) {
    if (!existsSync(manifestPath)) continue
    try {
      const raw = await readFile(manifestPath, 'utf8')
      const parsed = JSON.parse(raw) as { fileCount?: number; payloadBytes?: number }
      if (typeof parsed.fileCount === 'number' && typeof parsed.payloadBytes === 'number') {
        return { fileCount: parsed.fileCount, payloadBytes: parsed.payloadBytes }
      }
    } catch {
      // try next candidate
    }
  }
  return null
}

export async function getInstallDefaults(version: string, productName: string): Promise<InstallDefaults> {
  const packagedManifest = await readPackagedPayloadManifest()
  let stats = packagedManifest
  if (!stats) {
    const payloadRoot = resolvePayloadRoot()
    stats = (await readPayloadManifest(payloadRoot)) ?? await collectPayloadStats(payloadRoot)
  }
  return {
    version,
    productName,
    defaultInstallDir: defaultInstallDir(),
    ...stats,
  }
}

function emit(
  onProgress: (p: InstallProgress) => void,
  partial: Partial<InstallProgress> & Pick<InstallProgress, 'phase'>,
  filesDone: number,
  filesTotal: number,
  bytesDone: number,
  bytesTotal: number,
  currentFile: string,
): void {
  const percent = bytesTotal > 0 ? Math.min(100, Math.round((bytesDone / bytesTotal) * 100)) : 0
  onProgress({
    filesDone,
    filesTotal,
    bytesDone,
    bytesTotal,
    currentFile,
    percent,
    ...partial,
  })
}

async function copyPayload(
  payloadRoot: string,
  installDir: string,
  onProgress: (p: InstallProgress) => void,
): Promise<void> {
  const files = await walkFiles(payloadRoot)
  const bytesTotal = files.reduce((sum, f) => sum + f.size, 0)
  let bytesDone = 0

  emit(onProgress, { phase: 'copying' }, 0, files.length, 0, bytesTotal, '')

  await mkdir(installDir, { recursive: true })

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const target = join(installDir, file.rel)
    await mkdir(dirname(target), { recursive: true })
    await cp(file.abs, target, { force: true })
    bytesDone += file.size
    emit(onProgress, { phase: 'copying' }, i + 1, files.length, bytesDone, bytesTotal, file.rel)
  }
}

function buildUninstallScript(installDir: string): string {
  const desktop = join(homedir(), 'Desktop', 'Verstak.lnk')
  const startMenu = join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Verstak.lnk')
  return `# Verstak uninstall helper
$ErrorActionPreference = 'Stop'
$dir = '${psQuote(installDir)}'
$shortcuts = @(
  '${psQuote(desktop)}',
  '${psQuote(startMenu)}'
)
foreach ($lnk in $shortcuts) {
  if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force }
}
if (Test-Path -LiteralPath $dir) {
  Remove-Item -LiteralPath $dir -Recurse -Force
}
Remove-Item -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ru.verstak.ide' -Recurse -Force -ErrorAction SilentlyContinue
`
}

async function writeUninstaller(installDir: string): Promise<string> {
  const scriptPath = join(installDir, uninstallScriptName())
  await writeFile(scriptPath, buildUninstallScript(installDir), 'utf8')
  return scriptPath
}

async function createShortcuts(installDir: string): Promise<void> {
  const exe = installedExePath(installDir)
  const shortcuts = [
    join(homedir(), 'Desktop', 'Verstak.lnk'),
    join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Verstak.lnk'),
  ]
  for (const lnk of shortcuts) {
    await mkdir(dirname(lnk), { recursive: true })
    createShortcut(lnk, exe)
  }
}

/** Папку безопасно стереть целиком при откате ТОЛЬКО если установщик её создал
 *  (не существовала) или она была ПУСТА. Иначе (обновление поверх старой версии
 *  или пользователь выбрал папку с личными файлами) — трогать чужое нельзя (B1). */
export async function dirIsOursToWipe(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir)
    return entries.length === 0
  } catch {
    return true // папки нет — создаст установщик, при откате можно убрать
  }
}

/** Откат установки. ownDir → убрать папку целиком; иначе удалить ТОЛЬКО
 *  записанные payload-файлы + uninstall-скрипт, не затрагивая чужие файлы. */
export async function rollbackInstall(installDir: string, payloadRoot: string, ownDir: boolean): Promise<void> {
  if (ownDir) {
    await rm(installDir, { recursive: true, force: true })
    return
  }
  let files: FileEntry[] = []
  try {
    files = await walkFiles(payloadRoot)
  } catch {
    return // нет payload-манифеста — безопаснее ничего не удалять
  }
  for (const f of files) {
    await rm(join(installDir, f.rel), { force: true }).catch(() => {})
  }
  await rm(join(installDir, uninstallScriptName()), { force: true }).catch(() => {})
}

export async function runInstall(
  installDir: string,
  version: string,
  onProgress: (p: InstallProgress) => void,
): Promise<InstallResult> {
  const normalized = installDir.trim()
  if (!normalized) return { ok: false, error: 'Укажите папку установки.' }
  // B1: фиксируем ДО любых записей, можно ли при откате стирать папку целиком —
  // иначе сбой копирования в существующую непустую папку удалял бы чужие данные.
  const ownDir = await dirIsOursToWipe(normalized)
  let payloadRoot = ''
  try {
    emit(onProgress, { phase: 'preparing' }, 0, 0, 0, 0, '')
    payloadRoot = resolvePayloadRoot()

    await removeStaleUnpacked(normalized)
    await copyPayload(payloadRoot, normalized, onProgress)

    emit(onProgress, { phase: 'shortcuts' }, 0, 0, 0, 0, '')
    await createShortcuts(normalized)

    const uninstallPs1 = await writeUninstaller(normalized)
    const exe = installedExePath(normalized)
    const uninstallString = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${uninstallPs1}"`

    emit(onProgress, { phase: 'registry' }, 0, 0, 0, 0, '')
    setUninstallRegistry({
      displayName: 'Verstak',
      displayVersion: version,
      publisher: 'Pavel Frolov',
      installLocation: normalized,
      uninstallString,
      displayIcon: `${exe},0`,
    })

    emit(onProgress, { phase: 'done', percent: 100 }, 0, 0, 0, 0, '')
    return { ok: true, installDir: normalized }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    try {
      await rollbackInstall(normalized, payloadRoot, ownDir)
    } catch {
      // ignore cleanup errors
    }
    return { ok: false, error: message }
  }
}

export function launchInstalledApp(installDir: string): void {
  const exe = installedExePath(installDir)
  runPowerShell(`Start-Process -FilePath '${psQuote(exe)}'`)
}
