import { contextBridge, ipcRenderer } from 'electron'
import type { InstallDefaults, InstallProgress, InstallResult } from './types'

const installer = {
  getDefaults: (): Promise<InstallDefaults> => ipcRenderer.invoke('installer:getDefaults'),
  browseDirectory: (current: string): Promise<string | null> => ipcRenderer.invoke('installer:browseDirectory', current),
  install: (installDir: string): Promise<InstallResult> => ipcRenderer.invoke('installer:install', installDir),
  onProgress: (handler: (progress: InstallProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: InstallProgress) => handler(progress)
    ipcRenderer.on('installer:progress', listener)
    return () => ipcRenderer.removeListener('installer:progress', listener)
  },
  launchApp: (installDir: string): Promise<void> => ipcRenderer.invoke('installer:launchApp', installDir),
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('installer:window:minimize'),
    maximize: (): Promise<void> => ipcRenderer.invoke('installer:window:maximize'),
    close: (): Promise<void> => ipcRenderer.invoke('installer:window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('installer:window:isMaximized'),
    onMaximizedChanged: (handler: (maximized: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, maximized: boolean) => handler(maximized)
      ipcRenderer.on('installer:window:maximized', listener)
      return () => ipcRenderer.removeListener('installer:window:maximized', listener)
    },
  },
}

contextBridge.exposeInMainWorld('installer', installer)

export type InstallerApi = typeof installer