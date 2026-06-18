import { contextBridge, ipcRenderer } from 'electron'

export interface ToastPayload {
  title?: string
  body: string
  projectName?: string
  projectPath?: string
  isHelp?: boolean
  helpProjectPath?: string
  isError?: boolean
  theme?: 'nord' | 'light'
}

contextBridge.exposeInMainWorld('toastApi', {
  onShow: (cb: (payload: ToastPayload) => void) => {
    const handler = (_e: unknown, payload: ToastPayload) => cb(payload)
    ipcRenderer.on('toast:show', handler)
    return () => { ipcRenderer.removeListener('toast:show', handler) }
  },
  focusMain: (projectPath?: string, openHelp?: boolean) => {
    ipcRenderer.send('toast:focus-main', openHelp ? { projectPath, openHelp: true } : projectPath)
  },
  hideWindow: () => { ipcRenderer.send('toast:hide-window') }
})