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
  reminderId?: number
  chatId?: number
  kind?: 'reminder' | 'chat-reminder-sent'
  persistent?: boolean
}

contextBridge.exposeInMainWorld('toastApi', {
  onShow: (cb: (payload: ToastPayload) => void) => {
    const handler = (_e: unknown, payload: ToastPayload) => cb(payload)
    ipcRenderer.on('toast:show', handler)
    return () => { ipcRenderer.removeListener('toast:show', handler) }
  },
  focusMain: (projectPath?: string, openHelp?: boolean, chatId?: number) => {
    ipcRenderer.send('toast:focus-main', openHelp || typeof chatId === 'number' ? { projectPath, openHelp: !!openHelp, chatId } : projectPath)
  },
  reminderSnooze: (id: number) => { ipcRenderer.send('toast:reminder-snooze', id) },
  reminderDismiss: (id: number) => { ipcRenderer.send('toast:reminder-dismiss', id) },
  reminderOpen: (id: number) => { ipcRenderer.send('toast:reminder-open', id) },
  hideWindow: () => { ipcRenderer.send('toast:hide-window') }
})
