import type { InstallerApi } from '../../electron/installer/preload'

declare global {
  interface Window {
    installer: InstallerApi
  }
}

export {}