/**
 * IPC для Project Brain: warmup (прогрев), get (состояние мозга), decisions
 * (память решений). Бизнес-логика — в ai/project-brain/warmup.ts и storage.
 */

import { ipcMain } from 'electron'
import { readFile, readdir } from 'fs/promises'
import { join } from 'path'
import { safeRealJoin } from '../ai/path-policy'
import { getProjectMap } from '../ai/project-map'
import { runWarmup, isExcludedPath } from '../ai/project-brain/warmup'
import type { ProjectBrainStore, NewDecisionRecord } from '../storage/project-brain'

export interface BrainDeps {
  store: ProjectBrainStore
  getProjectRoot: () => string | null
}

/** Рекурсивный обход файлов проекта (project-relative), минус мусор. Cap по глубине/кол-ву. */
async function walkFiles(root: string, rel = '', acc: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 8 || acc.length > 5000) return acc
  let entries
  try { entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name
    if (isExcludedPath(childRel)) continue
    if (e.isDirectory()) await walkFiles(root, childRel, acc, depth + 1)
    else acc.push(childRel)
  }
  return acc
}

export function registerBrainIpc(deps: BrainDeps): void {
  // Прогрев проекта: скан → summaries → overview → context-packs → Brain.
  ipcMain.handle('brain:warmup', async () => {
    const root = deps.getProjectRoot()
    if (!root) return null
    const map = await getProjectMap(root).catch(() => null)
    const symbolsFor = (rel: string): string[] | undefined =>
      map?.files.find(f => f.path === rel)?.symbols.map(s => s.name)
    return runWarmup(root, {
      listFiles: () => walkFiles(root),
      readFile: async (rel) => {
        try { return await readFile(await safeRealJoin(root, rel), 'utf8') } catch { return null }
      },
      symbolsFor,
      store: deps.store,
    })
  })

  // Состояние мозга (для UI: есть ли прогрев, когда, overview).
  ipcMain.handle('brain:get', async () => {
    const root = deps.getProjectRoot()
    return root ? deps.store.getBrain(root) : null
  })

  // Память решений.
  ipcMain.handle('brain:decisions-list', async () => {
    const root = deps.getProjectRoot()
    return root ? deps.store.getDecisionRecords(root) : []
  })
  ipcMain.handle('brain:decisions-save', async (_e, rec: NewDecisionRecord) => {
    const root = deps.getProjectRoot()
    return root ? deps.store.saveDecisionRecord(root, rec) : null
  })
}
