import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow } from 'electron'

interface RunRequest { chatId: number; projectPath: string; text: string }
interface Pending { resolve: (value: { runId: string }) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

export function registerMobileRunProxy(window: BrowserWindow) {
  const pending = new Map<string, Pending>()
  ipcMain.removeHandler('mobile:run-started')
  ipcMain.handle('mobile:run-started', (_event, requestId: string, sendId: number, error?: string) => {
    const item = pending.get(requestId)
    if (!item) return
    clearTimeout(item.timer); pending.delete(requestId)
    if (error || !Number.isInteger(sendId) || sendId <= 0) item.reject(new Error(error || 'desktop rejected mobile run'))
    else item.resolve({ runId: String(sendId) })
  })
  return (input: RunRequest): Promise<{ runId: string }> => new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('mobile run start timed out')) }, 30_000)
    pending.set(requestId, { resolve, reject, timer })
    window.webContents.send('mobile:run-request', { requestId, ...input })
  })
}
