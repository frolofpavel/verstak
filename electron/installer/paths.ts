import { join } from 'path'
import { existsSync } from 'fs'

const APP_FOLDER = 'Verstak'
const EXE_NAME = 'Verstak.exe'

export function defaultInstallDir(): string {
  const local = process.env.LOCALAPPDATA
  if (!local) return join('C:', 'Users', 'Public', APP_FOLDER)
  return join(local, 'Programs', APP_FOLDER)
}

export function resolvePayloadRoot(): string {
  const dev = process.env.VERSTAK_INSTALLER_PAYLOAD
  if (dev && existsSync(dev)) return dev

  const packaged = join(process.resourcesPath, 'app-payload')
  if (existsSync(packaged)) return packaged

  const sibling = join(process.cwd(), 'release', 'win-unpacked')
  if (existsSync(sibling)) return sibling

  throw new Error('Не найден архив приложения (app-payload). Пересоберите установщик.')
}

export function installedExePath(installDir: string): string {
  return join(installDir, EXE_NAME)
}

export function uninstallScriptName(): string {
  return 'Uninstall Verstak.ps1'
}

export function registryUninstallKey(): string {
  return 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ru.verstak.ide'
}

export function isInstallerApp(): boolean {
  return process.env.VERSTAK_INSTALLER === '1'
}