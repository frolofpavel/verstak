import { ipcMain } from 'electron'
import type { RunUsage } from '../storage/agent-run-usage'

/**
 * IPC persistence usage — срез 2.0.8-F (read-side). Только ЧТЕНИЕ: строки пишет хук
 * finalize в runner'ах (agentRuns.persistUsage), наружу писать нечего.
 *
 * `sinceMs` — абсолютная метка времени (UI считает её от «7/30 дней»), а НЕ длительность:
 * граница периода принадлежит вызывающему, storage не выдумывает «сегодня».
 */
export function registerUsageIpc(runUsage: RunUsage): void {
  ipcMain.handle('usage:summary', (_e, sinceMs: number) => runUsage.summary(sinceMs))
  ipcMain.handle('usage:list', (_e, opts?: { sinceMs?: number; limit?: number }) => runUsage.list(opts))
}
