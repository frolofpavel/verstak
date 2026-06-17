import { autoUpdater } from 'electron-updater'
import { app, BrowserWindow, ipcMain } from 'electron'
import {
  fetchAllReleaseNotesMerged,
  fetchReleaseArtifactMeta,
  fetchReleaseNoteMerged,
  fetchReleaseNotesSince,
  fetchRemoteVersion,
  isBenignUpdaterError,
  releaseArtifactsReady,
  releaseFeedBase,
  semverGt,
} from './update-remote'
import {
  clearBrokenDifferentialCache,
  clearPendingUpdateCache,
  reconcileCachedDownload,
} from './updater-cache'

autoUpdater.logger = null
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false
autoUpdater.disableDifferentialDownload = true

const PERIODIC_CHECK_MS = 4 * 60 * 60 * 1000
const DOWNLOAD_STALL_MS = 3 * 60 * 1000
const CHECK_TIMEOUT_MS = 45_000
const UPDATER_RPC_TIMEOUT_MS = 20_000

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
let downloadInFlight = false
let downloadForVersion: string | null = null
let usedGenericFeed = false
let lastProgressAt = 0
let stallTimer: ReturnType<typeof setTimeout> | null = null
let releaseNotesIpcRegistered = false
let updaterIpcRegistered = false
let checkPromise: Promise<void> | null = null

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

function isNewerThanInstalled(target: string | null | undefined): boolean {
  if (!target) return false
  return semverGt(target, app.getVersion())
}

/** Сброс кэша, если на диске лежит установщик уже установленной (или более новой) версии. */
function reconcileStaleDownloadedUpdate(target?: string | null): boolean {
  const remote = target ?? lastProbeVersion
  if (remote && isNewerThanInstalled(remote)) return false
  clearPendingUpdateCache()
  return true
}

function clearStallTimer(): void {
  if (stallTimer) {
    clearTimeout(stallTimer)
    stallTimer = null
  }
}

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
    if (!pendingRelease && !isNewerThanInstalled(version)) {
      reconcileStaleDownloadedUpdate(version)
      announceNotAvailable()
      return
    }
    setSnapshot({ phase: 'available', version, pendingRelease })
    sendToRenderer(mainWindow, 'update:available', { version, pendingRelease })
  }

  const announceNotAvailable = () => {
    clearStallTimer()
    downloadInFlight = false
    downloadForVersion = null
    setSnapshot({ phase: 'not-available' })
    sendToRenderer(mainWindow, 'update:not-available')
  }

  const announceDownloaded = (version: string) => {
    clearStallTimer()
    downloadInFlight = false
    downloadForVersion = null
    setSnapshot({ phase: 'downloaded', version, percent: 100, pendingRelease: false })
    sendToRenderer(mainWindow, 'update:downloaded', { version })
  }

  const announceDownloadError = (version: string | undefined, message: string) => {
    clearStallTimer()
    downloadInFlight = false
    downloadForVersion = null
    setSnapshot({ phase: 'error', version, error: message })
    sendToRenderer(mainWindow, 'update:error', { error: message })
  }

  const armStallTimer = (version: string) => {
    clearStallTimer()
    lastProgressAt = Date.now()
    stallTimer = setTimeout(() => {
      if (snapshot.phase !== 'downloading') return
      if (Date.now() - lastProgressAt < DOWNLOAD_STALL_MS) return
      console.warn('[updater] download stalled, clearing broken cache')
      clearBrokenDifferentialCache()
      clearPendingUpdateCache()
      announceDownloadError(
        version,
        'Скачивание зависло. Проверьте интернет или скачайте установщик с GitHub Releases.',
      )
    }, DOWNLOAD_STALL_MS)
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

  const tryAnnounceCachedDownload = async (version: string): Promise<boolean> => {
    try {
      let meta = await fetchReleaseArtifactMeta(version)
      if (!meta) {
        const fileName = `Verstak-Setup-${version}-x64.exe`
        const cached = await reconcileCachedDownload(fileName, '', 0)
        if (!cached) return false
        console.info('[updater] using locally reconciled installer for', version)
        announceDownloaded(version)
        return true
      }
      const cached = await reconcileCachedDownload(meta.fileName, meta.sha512, meta.size)
      if (!cached) return false
      console.info('[updater] using reconciled cached installer for', version)
      announceDownloaded(version)
      return true
    } catch (err) {
      console.warn('[updater] tryAnnounceCachedDownload failed:', err)
      return false
    }
  }

  const ensureDownload = async (version: string): Promise<void> => {
    if (!isNewerThanInstalled(version)) {
      reconcileStaleDownloadedUpdate(version)
      announceNotAvailable()
      return
    }

    if (downloadInFlight && downloadForVersion === version) return
    if (snapshot.phase === 'downloaded' && snapshot.version === version) return

    if (await tryAnnounceCachedDownload(version)) return

    const hasArtifacts = await releaseArtifactsReady(version)
    if (!hasArtifacts) {
      announceAvailable(version, true)
      return
    }

    const feedReady = await tryUseReleaseFeed(version)
    if (!feedReady) {
      announceAvailable(version, true)
      return
    }

    clearBrokenDifferentialCache()
    downloadInFlight = true
    downloadForVersion = version
    setSnapshot({
      phase: 'downloading',
      version,
      percent: 0,
      pendingRelease: false,
    })
    armStallTimer(version)

    try {
      await autoUpdater.downloadUpdate()
      if (snapshot.phase !== 'downloaded' && isNewerThanInstalled(version)) {
        if (await tryAnnounceCachedDownload(version)) return
        announceDownloaded(version)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('[updater] downloadUpdate failed:', message)
      if (isBenignUpdaterError(message)) {
        downloadInFlight = false
        downloadForVersion = null
        announceAvailable(version, true)
        return
      }
      announceDownloadError(version, message)
    } finally {
      if (snapshot.phase !== 'downloading') clearStallTimer()
    }
  }

  const evaluateProbe = async (): Promise<{ newer: boolean; version: string | null; pendingRelease: boolean }> => {
    const current = app.getVersion()
    const remote = await fetchRemoteVersion()
    lastProbeVersion = remote
    if (!remote || !semverGt(remote, current)) {
      reconcileStaleDownloadedUpdate(remote)
      return { newer: false, version: remote, pendingRelease: false }
    }
    const hasArtifacts = await releaseArtifactsReady(remote)
    return { newer: true, version: remote, pendingRelease: !hasArtifacts }
  }

  const finalizeIfStillChecking = () => {
    if (snapshot.phase !== 'checking') return
    const remote = snapshot.version ?? lastProbeVersion
    if (remote && isNewerThanInstalled(remote)) {
      announceAvailable(remote, snapshot.pendingRelease ?? true)
      return
    }
    announceNotAvailable()
  }

  const runCheckBody = async () => {
    if (downloadInFlight) return
    if (!downloadInFlight) resetFeedToGithub()

    setSnapshot({ phase: 'checking' })
    sendToRenderer(mainWindow, 'update:checking')

    const probe = await evaluateProbe()

    if (!probe.newer || !probe.version) {
      announceNotAvailable()
      return
    }

    if (await tryAnnounceCachedDownload(probe.version)) return

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
      await withTimeout(
        autoUpdater.checkForUpdates(),
        UPDATER_RPC_TIMEOUT_MS,
        'checkForUpdates',
      )
    } catch (err) {
      console.warn('[updater] checkForUpdates failed:', err)
      await ensureDownload(probe.version)
    } finally {
      finalizeIfStillChecking()
    }
  }

  const runCheck = async () => {
    if (checkInFlight && checkPromise) {
      await checkPromise
      return
    }
    checkInFlight = true
    checkPromise = withTimeout(runCheckBody(), CHECK_TIMEOUT_MS, 'update check')
      .catch((err) => {
        console.warn('[updater] runCheck failed:', err)
        if (snapshot.phase === 'checking') {
          const remote = lastProbeVersion
          if (remote && isNewerThanInstalled(remote)) {
            void tryAnnounceCachedDownload(remote).then((ok) => {
              if (!ok) announceAvailable(remote, true)
            })
          } else {
            announceNotAvailable()
          }
        }
      })
      .finally(() => {
        checkInFlight = false
        checkPromise = null
      })
    await checkPromise
  }

  if (!updaterIpcRegistered) {
    updaterIpcRegistered = true

    ipcMain.handle('update:install', () => {
      const target = snapshot.version ?? lastProbeVersion
      if (!isNewerThanInstalled(target)) {
        reconcileStaleDownloadedUpdate(target)
        announceNotAvailable()
        return { ok: false as const, reason: 'already-current' as const }
      }
      autoUpdater.quitAndInstall(false, true)
      return { ok: true as const }
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
      if (downloadInFlight) return
      setSnapshot({ ...snapshot, phase: 'checking' })
      sendToRenderer(mainWindow, 'update:checking')
    })

    autoUpdater.on('update-available', (info) => {
      if (!isNewerThanInstalled(info.version)) {
        reconcileStaleDownloadedUpdate(info.version)
        announceNotAvailable()
        return
      }
      void ensureDownload(info.version)
    })

    autoUpdater.on('update-not-available', () => {
      if (downloadInFlight) return
      reconcileStaleDownloadedUpdate(lastProbeVersion)
      announceNotAvailable()
    })

    autoUpdater.on('download-progress', (progress) => {
      downloadInFlight = true
      lastProgressAt = Date.now()
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
      if (!isNewerThanInstalled(info.version)) {
        reconcileStaleDownloadedUpdate(info.version)
        announceNotAvailable()
        return
      }
      announceDownloaded(info.version)
    })

    autoUpdater.on('error', async (err) => {
      const message = err.message || 'Не удалось проверить обновления'
      console.warn('[updater] error:', message)

      const current = app.getVersion()
      const remote = snapshot.version ?? lastProbeVersion ?? await fetchRemoteVersion()

      if (snapshot.phase === 'downloading') {
        if (remote && (await tryAnnounceCachedDownload(remote))) return
        if (remote && semverGt(remote, current) && !isBenignUpdaterError(message)) {
          announceDownloadError(remote, message)
          return
        }
        if (remote && semverGt(remote, current)) {
          downloadInFlight = false
          downloadForVersion = null
          announceAvailable(remote, true)
          return
        }
      }

      if (remote && semverGt(remote, current)) {
        if (await tryAnnounceCachedDownload(remote)) return
        const pending = !(await releaseArtifactsReady(remote))
        if (!pending && snapshot.phase !== 'downloading') {
          void ensureDownload(remote)
          return
        }
        announceAvailable(remote, pending)
        return
      }

      if (isBenignUpdaterError(message)) {
        reconcileStaleDownloadedUpdate(remote)
        announceNotAvailable()
        return
      }

      announceDownloadError(remote ?? undefined, message)
    })
  }

  void evaluateProbe()
    .then(async (probe) => {
      if (!probe.newer) {
        announceNotAvailable()
        return
      }
      if (probe.version) {
        await tryAnnounceCachedDownload(probe.version)
      }
    })
    .catch((err) => {
      console.warn('[updater] startup probe failed:', err)
      announceNotAvailable()
    })

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