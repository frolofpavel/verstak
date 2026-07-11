import { join } from 'path'
import { existsSync } from 'fs'
import { resolvePayloadFromArchive, verifyPayloadRoot } from './payload-extract'

const APP_FOLDER = 'Verstak'
const EXE_NAME = 'Verstak.exe'

export function defaultInstallDir(): string {
  const local = process.env.LOCALAPPDATA
  if (!local) return join('C:', 'Users', 'Public', APP_FOLDER)
  return join(local, 'Programs', APP_FOLDER)
}

export function resolvePayloadRoot(): string {
  const dev = process.env.VERSTAK_INSTALLER_PAYLOAD
  if (dev && existsSync(dev)) {
    verifyPayloadRoot(dev)
    return dev
  }

  const archive = join(process.resourcesPath, 'app-payload.7z')
  if (existsSync(archive)) {
    return resolvePayloadFromArchive(archive)
  }

  const packaged = join(process.resourcesPath, 'app-payload')
  if (existsSync(packaged)) {
    verifyPayloadRoot(packaged)
    return packaged
  }

  const sibling = join(process.cwd(), 'release', 'win-unpacked')
  if (existsSync(sibling)) {
    verifyPayloadRoot(sibling)
    return sibling
  }

  throw new Error('Не найден архив приложения (app-payload). Пересоберите установщик.')
}

export function installedExePath(installDir: string): string {
  return join(installDir, EXE_NAME)
}

export function uninstallScriptName(): string {
  return 'Uninstall Verstak.ps1'
}
