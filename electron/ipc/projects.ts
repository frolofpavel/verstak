import { app, dialog, ipcMain, BrowserWindow, shell } from 'electron'
import { mkdirSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { spawn } from 'child_process'
import { parseRemoteSource, isRemoteSource, remoteProjectPath } from '../projects/remote-source'
import { runRemoteDoctor } from '../projects/remote-doctor'
import { setActiveProjectPath } from '../state/project-state'
import { ensureUserLayer, inspectUserLayer, PROJECT_RULE_CANDIDATES } from '../ai/user-layer'
import { warmProjectMaps } from '../ai/project-map'
import type { Database } from 'better-sqlite3'
import type { Projects } from '../storage/projects'
import type { ProjectGroups, ProjectGroupPatch } from '../storage/project-groups'
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
    title: 'Изображение проекта',
    properties: ['openFile'],
    filters: [
      { name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico'] }
    ]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

/** Клонировать репозиторий через системный git. Полный клон (проект для
 *  работы + push, не shallow). Возвращает ok | error со stderr-хвостом. */
function gitClone(url: string, dest: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise(resolve => {
    const proc = spawn('git', ['clone', url, dest], { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', c => { if (stderr.length < 8192) stderr += c.toString('utf8') })
    proc.on('error', err => resolve({ ok: false, error: err.message }))
    proc.on('close', code => resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim().slice(-400) || `exit ${code}` }))
  })
}

export function registerProjectIpc(projects: Projects, projectGroups: ProjectGroups, db: Database): void {
  function isKnownProjectPath(projectPath: string | null): boolean {
    if (!projectPath) return false
    return projects.list().some(p => p.path === projectPath)
  }

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
    // Фоновый прогрев карты проекта + графа зависимостей — чтобы к первому
    // ai:send и открытию панели Карта кэш был уже тёплым (non-blocking).
    void warmProjectMaps(picked).catch(() => { /* non-critical, фон */ })
    return picked
  })

  // Добавить удалённый проект: git-репо (клонируем локально) или ssh-сервер
  // (регистрируем, файлы остаются на сервере — правки через ssh-backend, фаза B).
  ipcMain.handle('projects:add-remote', async (_e, input: string): Promise<
    { ok: true; path: string; meta: ProjectMeta } | { ok: false; error: string }
  > => {
    const source = parseRemoteSource(input)
    if (!isRemoteSource(source)) return { ok: false, error: source.error }
    const cloneBase = join(homedir(), '.verstak', 'projects')
    const path = remoteProjectPath(source, cloneBase)

    if (source.kind === 'git') {
      if (existsSync(path)) return { ok: false, error: `Папка уже существует: ${path}. Удали её или открой как локальный проект.` }
      mkdirSync(cloneBase, { recursive: true })
      const cloned = await gitClone(source.cloneUrl, path)
      if (!cloned.ok) return { ok: false, error: `git clone не удался: ${cloned.error}` }
      const meta = projects.createRemote(path, 'git', source)
      setActiveProjectPath(path)
      void ensureUserLayer(path).catch(() => {})
      void warmProjectMaps(path).catch(() => {})
      return { ok: true, path, meta }
    }

    // ssh: файлы на сервере — регистрируем проект, локального клона нет.
    const meta = projects.createRemote(path, 'ssh', source)
    setActiveProjectPath(path)
    return { ok: true, path, meta }
  })

  ipcMain.handle('projects:remote-doctor', (_e, projectPath: string) => runRemoteDoctor(projectPath))

  ipcMain.handle('projects:set-current', (_e, path: string | null) => {
    setActiveProjectPath(path)
    if (path) {
      // upsert — touch alone silently no-ops if the project was never registered
      // (e.g. restored from last_project_path without going through pick()).
      projects.upsert(path)
      void ensureUserLayer(path).catch(() => { /* non-critical */ })
      // Открытие/смена активного проекта → фоном строим обе карты. Единая точка
      // хука: renderer setProject всегда зовёт setCurrent. Идемпотентно.
      void warmProjectMaps(path).catch(() => { /* non-critical, фон */ })
    }
  })

  ipcMain.handle('app:home-dir', () => app.getPath('home'))
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:open-external', (_e, url: string) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false
    void shell.openExternal(url)
    return true
  })

  ipcMain.handle('project-rules:status', (_e, projectPath: string | null) => {
    return inspectUserLayer(isKnownProjectPath(projectPath) ? projectPath : null)
  })

  ipcMain.handle('project-rules:ensure', async (_e, projectPath: string) => {
    if (!isKnownProjectPath(projectPath)) return { created: false, path: null }
    return ensureUserLayer(projectPath)
  })

  ipcMain.handle('project-rules:open', async (_e, projectPath: string | null, sourceId: string) => {
    const safeProjectPath = isKnownProjectPath(projectPath) ? projectPath : null
    const status = await inspectUserLayer(safeProjectPath)
    const sources = [status.global, ...status.project]
    const source = sources.find(s => s.id === sourceId)
    if (!source || !source.exists) return { ok: false, error: 'Файл правил не найден' }
    if (source.scope === 'project' && !PROJECT_RULE_CANDIDATES.includes(source.path as typeof PROJECT_RULE_CANDIDATES[number])) {
      return { ok: false, error: 'Недопустимый файл правил' }
    }
    const err = await shell.openPath(source.absPath)
    return { ok: err === '', error: err || null }
  })

  ipcMain.handle('project-rules:reveal', async (_e, projectPath: string | null, sourceId: string) => {
    const safeProjectPath = isKnownProjectPath(projectPath) ? projectPath : null
    const status = await inspectUserLayer(safeProjectPath)
    const sources = [status.global, ...status.project]
    const source = sources.find(s => s.id === sourceId)
    if (!source) return { ok: false, error: 'Источник правил не найден' }
    const err = await shell.openPath(dirname(source.absPath))
    return { ok: err === '', error: err || null }
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
    if (!displayName) return { ok: false, error: 'Укажите название проекта' }

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
      return { ok: false, error: 'Не удалось создать папку проекта на диске' }
    }

    projects.upsert(projectPath)
    let meta = projects.updateMeta(projectPath, { name: displayName })
    if (!meta) return { ok: false, error: 'Проект создан на диске, но не записался в базу' }

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

  ipcMain.handle('projects:list-groups', () => projectGroups.list())
  ipcMain.handle('projects:create-group', (_e, name: string, projectPaths: string[]) => {
    try {
      return { ok: true as const, group: projectGroups.create(name, projectPaths ?? []) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Не удалось создать группу'
      return { ok: false as const, error: msg }
    }
  })
  ipcMain.handle('projects:update-group', (_e, id: number, patch: ProjectGroupPatch) => {
    try {
      const group = projectGroups.update(id, patch)
      if (!group) return { ok: false as const, error: 'Группа не найдена' }
      return { ok: true as const, group }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Не удалось обновить группу'
      return { ok: false as const, error: msg }
    }
  })
  ipcMain.handle('projects:delete-group', (_e, id: number) => {
    projectGroups.remove(id)
    return { ok: true as const }
  })
  ipcMain.handle('projects:rename', (_e, path: string, name: string) => projects.rename(path, name))
  ipcMain.handle('projects:update-meta', (_e, path: string, patch: { name?: string; hidden?: boolean }) => {
    // Принимаем name и hidden. iconPath из renderer игнорируем — иконка ставится
    // строго через pick-icon/clear-icon (там путь генерит main внутри
    // project-icons). Иначе renderer мог бы записать произвольный путь как
    // iconPath и через protocol-хендлер прочитать любой файл.
    return projects.updateMeta(path, { name: patch?.name, hidden: patch?.hidden })
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
    if (!existing) return { ok: false, error: 'Проект не найден в списке' }

    if (existing.iconPath) deleteProjectIconFile(existing.iconPath)

    if (options?.deleteData) {
      try {
        purgeProjectAppData(db, path)
        deleteProjectDirectory(path)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Не удалось удалить данные проекта'
        return { ok: false, error: msg }
      }
    }

    projectGroups.detachProject(path)
    projects.remove(path)
    forgetMemorizedProject(path)
    return { ok: true }
  })
}
