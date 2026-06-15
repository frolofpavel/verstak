import { app, dialog, ipcMain, BrowserWindow, shell } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { setActiveProjectPath } from '../state/project-state'
import { ensureUserLayer } from '../ai/user-layer'
import type { Database } from 'better-sqlite3'
import type { Projects } from '../storage/projects'
import { deleteProjectDirectory, purgeProjectAppData } from '../storage/project-purge'
import {
  clientFolderExists,
  getClientsRoot,
  normalizeClientFolderSlug,
  scaffoldClientFolder,
  validateClientFolderSlug
} from '../storage/clients-root'
import { deleteProjectIconFile, importProjectIcon } from '../storage/project-icons'
import { forgetMemorizedProject } from './ai'
import type { ProjectMeta } from '../storage/projects'

export type CreateClientResult =
  | { ok: true; path: string; meta: ProjectMeta }
  | { ok: false; error: string }

async function pickImageFile(win: BrowserWindow): Promise<string | null> {
  const result = await dialog.showOpenDialog(win, {
    title: 'Изображение клиента',
    properties: ['openFile'],
    filters: [
      { name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico'] }
    ]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

export function registerProjectIpc(projects: Projects, db: Database): void {
  ipcMain.handle('projects:pick', async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Открыть проект'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const picked = result.filePaths[0]
    projects.upsert(picked)
    setActiveProjectPath(picked)
    void ensureUserLayer(picked).catch(() => { /* non-critical */ })
    return picked
  })

  ipcMain.handle('projects:set-current', (_e, path: string | null) => {
    setActiveProjectPath(path)
    if (path) {
      // upsert — touch alone silently no-ops if the project was never registered
      // (e.g. restored from last_project_path without going through pick()).
      projects.upsert(path)
      void ensureUserLayer(path).catch(() => { /* non-critical */ })
    }
  })

  ipcMain.handle('app:home-dir', () => app.getPath('home'))
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:open-external', (_e, url: string) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false
    void shell.openExternal(url)
    return true
  })

  ipcMain.handle('projects:clients-root', () => getClientsRoot())

  ipcMain.handle('projects:pick-image', async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    return pickImageFile(win)
  })

  ipcMain.handle('projects:create', async (_e, input: {
    name?: string
    folderSlug?: string
    iconSourcePath?: string | null
  }): Promise<CreateClientResult> => {
    const displayName = (input.name ?? '').trim()
    if (!displayName) return { ok: false, error: 'Укажите название клиента' }

    const slug = normalizeClientFolderSlug(input.folderSlug ?? '')
    const slugError = validateClientFolderSlug(slug)
    if (slugError) return { ok: false, error: slugError }

    const clientsRoot = getClientsRoot()
    mkdirSync(clientsRoot, { recursive: true })

    if (clientFolderExists(clientsRoot, slug)) {
      return { ok: false, error: `Папка «${slug}» уже есть в ${clientsRoot}` }
    }

    const projectPath = join(clientsRoot, slug)
    try {
      mkdirSync(projectPath, { recursive: false })
      scaffoldClientFolder(clientsRoot, projectPath, displayName, slug)
      void ensureUserLayer(projectPath).catch(() => { /* non-critical */ })
    } catch {
      return { ok: false, error: 'Не удалось создать папку клиента на диске' }
    }

    projects.upsert(projectPath)
    let meta = projects.updateMeta(projectPath, { name: displayName })
    if (!meta) return { ok: false, error: 'Клиент создан на диске, но не записался в базу' }

    if (input.iconSourcePath) {
      try {
        const iconPath = importProjectIcon(projectPath, input.iconSourcePath)
        meta = projects.updateMeta(projectPath, { iconPath }) ?? meta
      } catch {
        /* icon optional — client still created */
      }
    }

    setActiveProjectPath(projectPath)
    return { ok: true, path: projectPath, meta }
  })

  ipcMain.handle('projects:list', () => projects.list())
  ipcMain.handle('projects:rename', (_e, path: string, name: string) => projects.rename(path, name))
  ipcMain.handle('projects:update-meta', (_e, path: string, patch: { name?: string; iconPath?: string | null }) => {
    return projects.updateMeta(path, patch)
  })
  ipcMain.handle('projects:pick-icon', async (_e, projectPath: string) => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Иконка проекта',
      properties: ['openFile'],
      filters: [
        { name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const existing = projects.list().find(p => p.path === projectPath)
    if (existing?.iconPath) deleteProjectIconFile(existing.iconPath)
    const iconPath = importProjectIcon(projectPath, result.filePaths[0])
    return projects.updateMeta(projectPath, { iconPath })
  })
  ipcMain.handle('projects:clear-icon', (_e, projectPath: string) => {
    const existing = projects.list().find(p => p.path === projectPath)
    if (existing?.iconPath) deleteProjectIconFile(existing.iconPath)
    return projects.updateMeta(projectPath, { iconPath: null })
  })
  ipcMain.handle('projects:remove', (_e, path: string, options?: { deleteData?: boolean }) => {
    const existing = projects.list().find(p => p.path === path)
    if (!existing) return { ok: false, error: 'Клиент не найден в списке' }

    if (existing.iconPath) deleteProjectIconFile(existing.iconPath)

    if (options?.deleteData) {
      try {
        purgeProjectAppData(db, path)
        deleteProjectDirectory(path)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Не удалось удалить данные клиента'
        return { ok: false, error: msg }
      }
    }

    projects.remove(path)
    forgetMemorizedProject(path)
    return { ok: true }
  })
}