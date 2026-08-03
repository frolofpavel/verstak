import { ipcMain } from 'electron'
import { runtimeLogFiles } from './runtime-log'

// Вынесено из runtime-log.ts (Этап 1а headless, docs/headless-core-recon-2026-08-04.md):
// сам runtime-log импортируется агентным ядром и обязан жить без electron; ipcMain-часть
// нужна только десктопу. Канал и форма ответа не менялись.
export function registerRuntimeLogIpc(): void {
  ipcMain.handle('runtime-logs:info', () => runtimeLogFiles())
}
