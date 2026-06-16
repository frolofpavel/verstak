import { autoUpdater } from 'electron-updater'
import { app, BrowserWindow, ipcMain } from 'electron'
import {
  fetchAllReleaseNotesMerged,
  fetchReleaseNoteMerged,
  fetchReleaseNotesSince,
  fetchRemoteVersion,
  isBenignUpdaterError,
  releaseArtifactsReady,
  releaseFeedBase,
  semverGt,
} from './update-remote'

autoUpdater.logger = null
autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = false

const PERIODIC_CHECK_MS = 4 * 60 * 60 * 1000

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'

export type UpdateSnapshot = {
  phase: UpdatePhase
  version?: string
  percent?: number
  error?: string
  pendingRelease?: boolean
}

let snapshot: UpdateSnapshot = { phase: 'idle' }
let lastProbeVersion: string | null = null
let checkInFlight = false
let usedGenericFeed = false
let releaseNotesIpcRegistered = false
let updaterIpcRegistered = false

/** Release notes IPC — регистрируем до старта renderer (WhatsNewModal при запуске). */
export function registerReleaseNotesIpc(): void {
  if (releaseNotesIpcRegistered) return
  releaseNotesIpcRegistered = true

  ipcMain.handle('update:get-release-notes', async (_e, opts?: {
    sinceVersion?: string
    upToVersion?: string
    version?: string
    all?: boolean
  }) => {
    try {
      if (opts?.all) {
        return fetchAllReleaseNotesMerged()
      }
      if (opts?.version) {
        const note = await fetchReleaseNoteMerged(opts.version)
        return note ? [note] : []
      }
      if (opts?.sinceVersion && opts?.upToVersion) {
        return fetchReleaseNotesSince(opts.sinceVersion, opts.upToVersion)
      }
      const note = await fetchReleaseNoteMerged(app.getVersion())
      return note ? [note] : []
    } catch (err) {
      console.warn('[updater] get-release-notes failed:', err)
      return []
    }
  })
}

export function initAutoUpdater(mainWindow: BrowserWindow): void {
  registerReleaseNotesIpc()
  if (!app.isPackaged) return

  const pushSnapshot = () => {
    sendToRenderer(mainWindow, 'update:state', snapshot)
  }

  const setSnapshot = (next: UpdateSnapshot) => {
    snapshot = next
    pushSnapshot()
  }

  const announceAvailable = (version: string, pendingRelease = false) => {
    setSnapshot({ phase: 'available', version, pendingRelease })
    sendToRenderer(mainWindow, 'update:available', { version, pendingRelease })
  }

  const announceNotAvailable = () => {
    setSnapshot({ phase: 'not-available' })
    sendToRenderer(mainWindow, 'update:not-available')
  }

  const resetFeedToGithub = () => {
    if (!usedGenericFeed) return
    usedGenericFeed = false
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'frolofpavel',
      repo: 'verstak',
    })
  }

  const tryUseReleaseFeed = async (version: string): Promise<boolean> => {
    if (!(await releaseArtifactsReady(version))) return false
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: releaseFeedBase(version),
    })
    usedGenericFeed = true
    return true
  }

  const evaluateProbe = async (): Promise<{ newer: boolean; version: string | null; pendingRelease: boolean }> => {
    const current = app.getVersion()
    const remote = await fetchRemoteVersion()
    lastProbeVersion = remote
    if (!remote || !semverGt(remote, current)) {
      return { newer: false, version: remote, pendingRelease: false }
    }
    const hasArtifacts = await releaseArtifactsReady(remote)
    return { newer: true, version: remote, pendingRelease: !hasArtifacts }
  }

  const runCheck = async () => {
    if (checkInFlight) return
    checkInFlight = true
    resetFeedToGithub()

    try {
      setSnapshot({ phase: 'checking' })
      sendToRenderer(mainWindow, 'update:checking')

      const probe = await evaluateProbe()

      if (!probe.newer || !probe.version) {
        announceNotAvailable()
        return
      }

      if (probe.pendingRelease) {
        announceAvailable(probe.version, true)
        return
      }

      const feedReady = await tryUseReleaseFeed(probe.version)
      if (!feedReady) {
        announceAvailable(probe.version, true)
        return
      }

      try {
        await autoUpdater.checkForUpdates()
      } catch (err) {
        console.warn('[updater] checkForUpdates failed:', err)
        announceAvailable(probe.version, true)
      }
    } finally {
      checkInFlight = false
    }
  }

  if (!updaterIpcRegistered) {
    updaterIpcRegistered = true

    ipcMain.handle('update:install', () => {
      autoUpdater.quitAndInstall(false, true)
    })

    ipcMain.handle('update:get-state', () => snapshot)

    ipcMain.handle('update:check', async () => {
      await runCheck()
      const current = app.getVersion()
      const remote = snapshot.version ?? lastProbeVersion
      const available = !!remote && semverGt(remote, current)
      return {
        available,
        version: remote ?? undefined,
        phase: snapshot.phase,
        error: snapshot.error,
        pendingRelease: snapshot.pendingRelease,
      }
    })

    autoUpdater.on('checking-for-update', () => {
      setSnapshot({ ...snapshot, phase: 'checking' })
      sendToRenderer(mainWindow, 'update:checking')
    })

    autoUpdater.on('update-available', (info) => {
      setSnapshot({ phase: 'available', version: info.version, pendingRelease: false })
      sendToRenderer(mainWindow, 'update:available', {
        version: info.version,
        releaseDate: info.releaseDate,
        pendingRelease: false,
      })
    })

    autoUpdater.on('update-not-available', () => {
      announceNotAvailable()
    })

    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.round(progress.percent)
      setSnapshot({
        phase: 'downloading',
        version: snapshot.version,
        percent,
        pendingRelease: false,
      })
      sendToRenderer(mainWindow, 'update:progress', {
        percent,
        transferred: progress.transferred,
        total: progress.total,
      })
    })

    autoUpdater.on('update-downloaded', (info) => {
      const current = app.getVersion()
      if (!semverGt(info.version, current)) {
        announceNotAvailable()
        return
      }
      setSnapshot({ phase: 'downloaded', version: info.version, percent: 100, pendingRelease: false })
      sendToRenderer(mainWindow, 'update:downloaded', { version: info.version })
    })

    autoUpdater.on('error', async (err) => {
      const message = err.message || 'Не удалось проверить обновления'
      console.warn('[updater] error:', message)

      const current = app.getVersion()
      const remote = lastProbeVersion ?? await fetchRemoteVersion()
      if (remote && semverGt(remote, current)) {
        const pending = !(await releaseArtifactsReady(remote))
        announceAvailable(remote, pending)
        return
      }

      if (isBenignUpdaterError(message)) {
        announceNotAvailable()
        return
      }

      setSnapshot({ phase: 'error', error: message })
      sendToRenderer(mainWindow, 'update:error', { error: message })
    })
  }

  mainWindow.webContents.once('did-finish-load', () => {
    pushSnapshot()
    void runCheck()
  })

  setInterval(() => { void runCheck() }, PERIODIC_CHECK_MS)
}

function sendToRenderer(win: BrowserWindow, channel: string, data?: unknown): void {
  try {
    if (!win.isDestroyed()) win.webContents.send(channel, data)
  } catch { /* window might be closing */ }
}