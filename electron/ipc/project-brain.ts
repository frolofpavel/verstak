/**
 * IPC для Project Brain: warmup (прогрев), get (состояние мозга), decisions
 * (память решений). Бизнес-логика — в ai/project-brain/warmup.ts и storage.
 */

import { ipcMain } from 'electron'
import { readFile, readdir } from 'fs/promises'
import { join } from 'path'
import { safeRealJoin } from '../ai/path-policy'
import { getProjectMap } from '../ai/project-map'
import { warmBrainOnce, isExcludedPath, type WarmupDeps, type WarmupResult } from '../ai/project-brain/warmup'
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

// Store захватывается при регистрации — чтобы авто-прогрев (warmProjectBrain,
// хук в projects:set-current) мог работать без прокидывания store через все слои.
let brainStoreRef: ProjectBrainStore | null = null

// Собрать IO-зависимости прогрева для проекта: список файлов, чтение (через
// path-policy) и символы из project-map. Map тянем один раз на прогрев.
async function buildWarmupDeps(root: string, store: ProjectBrainStore): Promise<WarmupDeps> {
  const map = await getProjectMap(root).catch(() => null)
  const symbolsFor = (rel: string): string[] | undefined =>
    map?.files.find(f => f.path === rel)?.symbols.map(s => s.name)
  return {
    listFiles: () => walkFiles(root),
    readFile: async (rel) => {
      try { return await readFile(await safeRealJoin(root, rel), 'utf8') } catch { return null }
    },
    symbolsFor,
    store,
  }
}

/**
 * Авто-прогрев Brain — вызывается из projects:set-current (открытие/смена
 * проекта), рядом с warmProjectMaps. Троттлится по свежести (см. warmBrainOnce),
 * так что смена проекта туда-обратно бесплатна. Раньше прогрев был ТОЛЬКО ручной
 * (кнопка brain:warmup) — оттого панель «Мозг» стояла пустой у большинства.
 */
export async function warmProjectBrain(root: string, opts: { force?: boolean } = {}): Promise<WarmupResult | null> {
  if (!brainStoreRef) return null
  const deps = await buildWarmupDeps(root, brainStoreRef)
  return warmBrainOnce(root, deps, opts)
}

export function registerBrainIpc(deps: BrainDeps): void {
  brainStoreRef = deps.store
  // Прогрев проекта: скан → summaries → overview → context-packs → Brain.
  // Ручная кнопка — force=true (прогреваем всегда, игнорируя троттл свежести).
  ipcMain.handle('brain:warmup', async () => {
    const root = deps.getProjectRoot()
    if (!root) return null
    return warmProjectBrain(root, { force: true })
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
