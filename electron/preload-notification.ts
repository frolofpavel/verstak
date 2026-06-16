import { contextBridge, ipcRenderer } from 'electron'

export interface ToastPayload {
  title?: string
  body: string
  projectName?: string
  isError?: boolean
  theme?: 'nord' | 'light'
}

contextBridge.exposeInMainWorld('toastApi', {
  onShow: (cb: (payload: ToastPayload) => void) => {
    const handler = (_e: unknown, payload: ToastPayload) => cb(payload)
    ipcRenderer.on('toast:show', handler)
    return () => { ipcRenderer.removeListener('toast:show', handler) }
  },
  focusMain: () => { ipcRenderer.send('toast:focus-main') },
  hideWindow: () => { ipcRenderer.send('toast:hide-window') }
})