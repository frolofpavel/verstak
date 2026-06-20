import { spawn } from 'child_process'
import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  fetchAllReleaseNotesMerged,
  fetchReleaseNoteMerged,
  fetchReleaseNotesSince,
  fetchReleaseArtifactMeta,
  fetchRemoteVersion,
  normalizeVersion,
  rateLimitWaitMinutes,
  resolveInstallableUpdate,
  semverGt,
} from '../update-remote'
import { resolveSystemNode } from '../system-node'
import { downloadInstaller } from './download'
import {
  autoUpdateRoot,
  currentInstallDir,
  helperPath,
  legacyStagingRoot,
  legacyUpdaterRoot,
  payloadRoot,
  payloadVersionDir,
  sevenZipPath,
} from './paths'
import { verifyPayloadRoot } from './payload'
import { logAutoUpdate } from './log'
import { acquireLock, nowState, readJson, readState, resetState, writeState } from './state'
import type { AutoUpdateState, AutoUpdateStep, UiUpdateSnapshot } from './types'

const PERIODIC_CHECK_MS = 4 * 60 * 60 * 1000

let releaseNotesIpcRegistered = false
let updaterIpcRegistered = false

function mapStep(step?: AutoUpdateStep): UiUpdateSnapshot['stagingStep'] {
  if (step === 'extract') return 'payload'
  if (step === 'verify') return 'verify'
  if (step === 'done') return 'done'
  return 'setup'
}

export function toUiSnapshot(state: AutoUpdateState | null): UiUpdateSnapshot {
  const s = state ?? { schemaVersion: 1, status: 'idle', updatedAt: Date.now() } as AutoUpdateState
  const version = s.version || s.remoteVersion
  if (s.status === 'checking') return { phase: 'checking', version, installedVersion: s.installedVersion, remoteVersion: s.remoteVersion }
  if (s.status === 'update_available') return { phase: 'available', version, pendingRelease: s.pendingRelease, installedVersion: s.installedVersion, remoteVersion: s.remoteVersion }
  if (s.status === 'downloading' || s.status === 'downloaded') return { phase: 'downloading', version, percent: s.percent, pendingRelease: s.pendingRelease }
  if (s.status === 'extracting') return { phase: 'staging', version, percent: s.percent, stagingStep: mapStep(s.step), pendingRelease: s.pendingRelease }
  if (s.status === 'payload_ready') return { phase: 'ready', version, percent: 100, stagingStep: 'done', pendingRelease: false }
  if (s.status === 'install_requested' || s.status === 'installing' || s.status === 'installed_pending_restart') return { phase: 'installing', version, percent: 100 }
  if (s.status === 'failed_recoverable' || s.status === 'failed_final') {
    return {
      phase: 'error',
      version,
      error: s.error,
      errorCode: s.errorCode === 'github-rate-limit' ? 'github-rate-limit' : s.errorCode === 'network' ? 'network' : undefined,
      rateLimitMinutes: s.rateLimitMinutes,
    }
  }
  if (s.status === 'complete') return { phase: 'not-available', version, installedVersion: s.installedVersion }
  return { phase: 'idle', version, installedVersion: s.installedVersion, remoteVersion: s.remoteVersion }
}

function psQuote(value: string): string {
  return value.replace(/'/g, "''")
}

async function runPowerShellWait(script: string, label: string, onPoll?: () => void): Promise<void> {
  const workDir = join(tmpdir(), 'verstak-autoupdate')
  mkdirSync(workDir, { recursive: true })
  const id = `${Date.now()}-${process.pid}`
  const scriptPath = join(workDir, `${label}-${id}.ps1`)
  const exitPath = join(workDir, `${label}-${id}.exit`)
  const errPath = join(workDir, `${label}-${id}.err`)
  const wrapped = `$ErrorActionPreference = 'Stop'
$__exitFile = '${psQuote(exitPath)}'
$__errFile = '${psQuote(errPath)}'
trap {
  [System.IO.File]::WriteAllText($__errFile, $_.Exception.Message, [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText($__exitFile, '1', [System.Text.UTF8Encoding]::new($false))
  exit 1
}
${script}
[System.IO.File]::WriteAllText($__exitFile, '0', [System.Text.UTF8Encoding]::new($false))
`
  writeFileSync(scriptPath, wrapped, 'utf8')
  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath], {
      windowsHide: true,
      stdio: 'ignore',
    })
    const started = Date.now()
    const poll = () => {
      onPoll?.()
      if (existsSync(exitPath)) {
        const code = readFileSync(exitPath, 'utf8').trim()
        const err = existsSync(errPath) ? readFileSync(errPath, 'utf8').trim() : ''
        for (const p of [scriptPath, exitPath, errPath]) try { rmSync(p, { force: true }) } catch { /* ignore */ }
        if (code === '0') resolve()
        else reject(new Error(err || `${label} failed`))
        return
      }
      if (Date.now() - started > 20 * 60 * 1000) {
        try { child.kill() } catch { /* ignore */ }
        reject(new Error(`${label} timeout`))
        return
      }
      setTimeout(poll, 300)
    }
    child.on('error', reject)
    setTimeout(poll, 300)
  })
}

function buildHelperWaitScript(nodeExe: string, args: string[]): string {
  const psArgs = args.map(a => `'${psQuote(a)}'`).join(', ')
  return `$p = Start-Process -FilePath '${psQuote(nodeExe)}' -ArgumentList @(${psArgs}) -PassThru -Wait -WindowStyle Hidden
if ($p.ExitCode -ne 0) { throw "helper exit $($p.ExitCode)" }
`
}

function startDetachedHelper(nodeExe: string, args: string[]): void {
  const child = spawn(nodeExe, args, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  })
  logAutoUpdate('install.detached_helper_started', { nodeExe, args, pid: child.pid })
  child.once('error', (err) => {
    logAutoUpdate('install.spawn_error', { nodeExe, args, error: err.message })
  })
  child.unref()
}

function readExtractProgress(version: string): { percent?: number; step?: AutoUpdateStep } {
  const progress = readJson<{ percent?: number; step?: string }>(join(payloadVersionDir(version), 'progress.json'))
  if (!progress) return {}
  const raw = progress.step
  const step: AutoUpdateStep = raw === 'payload' ? 'extract' : raw === 'verify' ? 'verify' : raw === 'done' ? 'done' : 'extract'
  return { percent: progress.percent, step }
}

type VerifiedPayloadMeta = {
  version: string
  payloadRoot: string
  appAsarSize: number
  exeSize: number
  verifiedAt: number
}

function readVerifiedPayload(version: string): VerifiedPayloadMeta | null {
  const verified = readJson<VerifiedPayloadMeta>(join(payloadVersionDir(version), 'verified.json'))
  if (!verified) return null
  if (normalizeVersion(verified.version) !== normalizeVersion(version)) return null
  if (!verified.payloadRoot || verified.appAsarSize < 10_000_000 || verified.exeSize <= 0) return null
  const exe = join(verified.payloadRoot, 'Verstak.exe')
  const appAsar = join(verified.payloadRoot, 'resources', 'app.asar')
  if (!existsSync(exe) || !existsSync(appAsar)) return null
  try {
    if (statSync(exe).size <= 0) return null
    if (statSync(appAsar).size < 10_000_000 && verified.appAsarSize < 10_000_000) return null
  } catch {
    return null
  }
  return verified
}

export class AutoUpdateService {
  private periodicTimer: ReturnType<typeof setInterval> | null = null
  private autoDownloadTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly mainWindow: BrowserWindow) {}

  init(): void {
    mkdirSync(autoUpdateRoot(), { recursive: true })
    this.cleanupLegacyUpdaterRoots()
    this.recoverReadyPayload()
    this.registerIpc()
    setTimeout(() => { void this.check(false) }, 2500)
    this.periodicTimer = setInterval(() => { void this.check(false) }, PERIODIC_CHECK_MS)
    app.on('before-quit', () => {
      if (this.periodicTimer) clearInterval(this.periodicTimer)
      if (this.autoDownloadTimer) clearTimeout(this.autoDownloadTimer)
    })
  }

  private send(channel: string, data?: unknown): void {
    try {
      if (!this.mainWindow.isDestroyed()) this.mainWindow.webContents.send(channel, data)
    } catch { /* ignore */ }
  }

  private setState(patch: Omit<Partial<AutoUpdateState>, 'schemaVersion' | 'updatedAt'>): AutoUpdateState {
    logAutoUpdate('service.setState.request', { patch })
    const state = writeState(nowState(patch))
    const ui = toUiSnapshot(state)
    this.send('update:state', ui)
    if (ui.phase === 'available' && ui.version) this.send('update:available', { version: ui.version, pendingRelease: ui.pendingRelease })
    if (ui.phase === 'downloading') this.send('update:progress', { percent: ui.percent ?? 0 })
    if (ui.phase === 'ready' && ui.version) this.send('update:ready', { version: ui.version })
    if (ui.phase === 'error') this.send('update:error', { error: ui.error || 'Ошибка обновления', errorCode: ui.errorCode, rateLimitMinutes: ui.rateLimitMinutes })
    if (ui.phase === 'not-available') this.send('update:not-available')
    return state
  }

  private fail(version: string | undefined, error: unknown, recoverable = true, errorCode?: AutoUpdateState['errorCode']): AutoUpdateState {
    const message = error instanceof Error ? error.message : String(error)
    if (version) {
      const verified = readVerifiedPayload(version)
      if (verified) {
        logAutoUpdate('service.fail.suppressed_verified_payload', { version, message, errorCode, verified })
        return this.setState({
          status: 'payload_ready',
          version,
          payloadRoot: verified.payloadRoot,
          percent: 100,
          step: 'done',
          canInstall: true,
          canRetry: true,
          error: undefined,
          errorCode: undefined,
        })
      }
    }
    logAutoUpdate('service.fail', { version, message, recoverable, errorCode })
    return this.setState({
      status: recoverable ? 'failed_recoverable' : 'failed_final',
      version,
      error: message,
      errorCode,
      canRetry: recoverable,
      canInstall: recoverable,
    })
  }

  private scheduleAutoDownload(version: string): void {
    if (this.autoDownloadTimer) clearTimeout(this.autoDownloadTimer)
    this.autoDownloadTimer = setTimeout(() => {
      this.autoDownloadTimer = null
      const state = readState()
      if (state?.status !== 'update_available') return
      if (normalizeVersion(state.version || '') !== normalizeVersion(version)) return
      if (state.pendingRelease) return
      void this.ensureDownload().catch((err) => {
        console.warn('[autoupdate] auto download failed:', err)
      })
    }, 250)
  }

  private cleanupLegacyUpdaterRoots(): void {
    for (const root of [legacyStagingRoot(), legacyUpdaterRoot()]) {
      try {
        if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      } catch (err) {
        console.warn('[autoupdate] legacy cleanup failed:', root, err)
      }
    }
  }

  private recoverReadyPayload(): void {
    const state = readState()
    const version = state?.version
    if (!version) return
    // recoverReadyPayload зовётся только на старте app. Если на диске статус
    // 'installing'/'install_requested' — установка ПРЕРВАЛАСЬ (успешная увела бы
    // app.quit + перезапуск новой версии). Раньше этот статус исключался из
    // восстановления → вечный disabled-спиннер «…» на старой версии. Теперь:
    // payload цел → возвращаем рабочую кнопку «Установить»; payload пропал →
    // понятная ошибка, а не зомби.
    const stuckInstalling = state.status === 'installing' || state.status === 'install_requested'
    const verifiedMeta = readVerifiedPayload(version)
    if (verifiedMeta && state.status !== 'payload_ready') {
      logAutoUpdate('service.recover.verified_metadata', { version, verifiedMeta, previousStatus: state.status })
      this.setState({
        status: 'payload_ready',
        version,
        payloadRoot: verifiedMeta.payloadRoot,
        percent: 100,
        step: 'done',
        canInstall: true,
        canRetry: true,
        error: undefined,
        errorCode: undefined,
      })
      return
    }
    if (verifiedMeta) return
    const root = payloadRoot(version)
    const verified = verifyPayloadRoot(root, version)
    if (verified.ok && state.status !== 'payload_ready') {
      this.setState({
        status: 'payload_ready',
        version,
        payloadRoot: root,
        percent: 100,
        step: 'done',
        canInstall: true,
        canRetry: true,
      })
      return
    }
    // Застряли в installing, но payload не найден — установка прервалась без отката.
    if (stuckInstalling) {
      logAutoUpdate('service.recover.stuck_install_no_payload', { version, previousStatus: state.status })
      this.setState({
        status: 'failed_recoverable',
        version,
        error: 'Установка обновления прервалась. Проверьте обновления ещё раз или скачайте версию вручную.',
        canRetry: true,
        canInstall: false,
      })
    }
  }

  private registerIpc(): void {
    if (updaterIpcRegistered) return
    updaterIpcRegistered = true
    ipcMain.handle('update:check', async () => this.check(true))
    ipcMain.handle('update:ensure-download', async () => this.ensureDownload())
    ipcMain.handle('update:install', async () => this.install())
    ipcMain.handle('update:get-state', async () => ({
      ...toUiSnapshot(readState()),
      installedVersion: app.getVersion(),
      remoteVersion: readState()?.remoteVersion,
    }))
  }

  async check(userInitiated: boolean): Promise<{ available: boolean; version?: string; installedVersion?: string; error?: string; errorCode?: string; rateLimitMinutes?: number; phase?: string; pendingRelease?: boolean }> {
    let release: Awaited<ReturnType<typeof fetchRemoteVersion>> | null = null
    try {
      const unlock = acquireLock('check')
      try {
        this.setState({ status: 'checking', installedVersion: app.getVersion(), percent: 0, step: 'check' })
        release = await fetchRemoteVersion()
        if (!release.version) {
          if (release.rateLimit) {
            const minutes = rateLimitWaitMinutes(release.rateLimit)
            this.setState({ status: 'failed_recoverable', error: 'GitHub временно ограничил проверки обновлений.', errorCode: 'github-rate-limit', rateLimitMinutes: minutes, canRetry: true })
            return { available: false, installedVersion: app.getVersion(), error: 'rate-limit', errorCode: 'github-rate-limit', rateLimitMinutes: minutes, phase: 'error' }
          }
          this.setState({ status: 'idle', installedVersion: app.getVersion() })
          return { available: false, installedVersion: app.getVersion(), phase: 'idle' }
        }
        const resolved = await resolveInstallableUpdate(app.getVersion(), release.version)
        if (resolved.pendingVersion) {
          this.setState({ status: 'update_available', version: resolved.pendingVersion, remoteVersion: release.version, installedVersion: app.getVersion(), pendingRelease: true })
          return { available: true, version: resolved.pendingVersion, installedVersion: app.getVersion(), pendingRelease: true, phase: 'available' }
        }
        if (!resolved.installable || !semverGt(resolved.installable, app.getVersion())) {
          resetState()
          this.setState({ status: 'idle', remoteVersion: release.version, installedVersion: app.getVersion() })
          return { available: false, version: release.version, installedVersion: app.getVersion(), phase: 'not-available' }
        }
        const meta = await fetchReleaseArtifactMeta(resolved.installable)
        if (!meta) {
          this.setState({ status: 'update_available', version: resolved.installable, remoteVersion: release.version, installedVersion: app.getVersion(), pendingRelease: true })
          return { available: true, version: resolved.installable, installedVersion: app.getVersion(), pendingRelease: true, phase: 'available' }
        }
        const verifiedMeta = readVerifiedPayload(meta.version)
        if (verifiedMeta) {
          logAutoUpdate('check.verified_metadata_ready', { version: meta.version, verifiedMeta })
          this.setState({ status: 'payload_ready', version: meta.version, remoteVersion: release.version, installedVersion: app.getVersion(), payloadRoot: verifiedMeta.payloadRoot, percent: 100, step: 'done', canInstall: true, canRetry: true })
          return { available: true, version: meta.version, installedVersion: app.getVersion(), phase: 'ready' }
        }
        const ready = verifyPayloadRoot(payloadRoot(meta.version), meta.version)
        if (ready.ok) {
          this.setState({ status: 'payload_ready', version: meta.version, remoteVersion: release.version, installedVersion: app.getVersion(), payloadRoot: payloadRoot(meta.version), percent: 100, step: 'done', canInstall: true, canRetry: true })
          return { available: true, version: meta.version, installedVersion: app.getVersion(), phase: 'ready' }
        }
        this.setState({
          status: 'update_available',
          version: meta.version,
          remoteVersion: release.version,
          installedVersion: app.getVersion(),
          installerFileName: meta.fileName,
          installerSha512: meta.sha512,
          installerSize: meta.size,
          pendingRelease: false,
        })
        this.scheduleAutoDownload(meta.version)
        return { available: true, version: meta.version, installedVersion: app.getVersion(), phase: 'available' }
      } finally {
        unlock()
      }
    } catch (err) {
      if (String(err).includes('busy') && !userInitiated) return { available: false, installedVersion: app.getVersion(), phase: toUiSnapshot(readState()).phase }
      const failed = this.fail(readState()?.version || release?.version || undefined, err, true, 'network')
      return { available: false, installedVersion: app.getVersion(), error: failed.error, errorCode: failed.errorCode, phase: 'error' }
    }
  }

  async ensureDownload(): Promise<{ ok: boolean; reason?: string; phase?: string }> {
    const current = readState()
    const version = current?.version || current?.remoteVersion
    logAutoUpdate('ensureDownload.start', { current })
    if (current?.status === 'payload_ready' && version) return { ok: true, phase: 'ready' }
    if (!version || current?.pendingRelease) return { ok: false, reason: 'no-installable-update', phase: toUiSnapshot(current).phase }
    try {
      const unlock = acquireLock('download+extract', version)
      try {
        const meta = await fetchReleaseArtifactMeta(version)
        if (!meta) return { ok: false, reason: 'artifact-missing', phase: 'pending' }
        const verifiedMeta = readVerifiedPayload(meta.version)
        if (verifiedMeta) {
          logAutoUpdate('ensureDownload.verified_metadata_ready', { version: meta.version, verifiedMeta })
          this.setState({ status: 'payload_ready', version: meta.version, payloadRoot: verifiedMeta.payloadRoot, percent: 100, step: 'done', canInstall: true, canRetry: true, error: undefined, errorCode: undefined })
          return { ok: true, phase: 'ready' }
        }
        const ready = verifyPayloadRoot(payloadRoot(meta.version), meta.version)
        if (ready.ok) {
          this.setState({ status: 'payload_ready', version: meta.version, payloadRoot: payloadRoot(meta.version), percent: 100, step: 'done', canInstall: true, canRetry: true })
          return { ok: true, phase: 'ready' }
        }
        this.setState({ status: 'downloading', version: meta.version, installerFileName: meta.fileName, installerSha512: meta.sha512, installerSize: meta.size, percent: 0, step: 'download' })
        const installerPath = await downloadInstaller(meta, (p) => {
          this.setState({ status: 'downloading', version: meta.version, installerPath: undefined, percent: p.percent, step: 'download' })
          this.send('update:progress', p)
        })
        this.setState({ status: 'downloaded', version: meta.version, installerPath, percent: 100, step: 'download' })
        await this.extract(meta.version, installerPath)
        return { ok: true, phase: 'ready' }
      } finally {
        unlock()
      }
    } catch (err) {
      // Параллельная загрузка (авто + ручная) держит lock — это НЕ ошибка: вторая
      // ветка просто ждёт. Без guard'а busy превращался бы в failed_recoverable +
      // ложный тост «Ошибка обновления» поверх идущей загрузки (check() guard уже имеет).
      if (String(err).includes('busy')) return { ok: false, reason: 'busy', phase: toUiSnapshot(readState()).phase }
      const failed = this.fail(version, err, true, String(err).includes('payload') ? 'invalid-payload' : 'network')
      return { ok: false, reason: failed.error, phase: 'error' }
    }
  }

  private async extract(version: string, installerPath: string): Promise<void> {
    const node = resolveSystemNode()
    if (!node) throw new Error('Не удалось подготовить обновление автоматически. Скачайте новую версию вручную со страницы релизов на GitHub.')
    if (!existsSync(helperPath())) throw new Error('Не найден helper автообновления')
    if (!existsSync(sevenZipPath())) throw new Error('Не найден 7za.exe')
    this.setState({ status: 'extracting', version, installerPath, percent: 0, step: 'extract' })
    logAutoUpdate('extract.start', { version, installerPath, helperPath: helperPath(), sevenZipPath: sevenZipPath(), node })
    const args = [
      helperPath(),
      '--command=extract',
      `--root=${autoUpdateRoot()}`,
      `--version=${version}`,
      `--installer=${installerPath}`,
      `--seven-zip=${sevenZipPath()}`,
    ]
    await runPowerShellWait(buildHelperWaitScript(node, args), 'extract', () => {
      const p = readExtractProgress(version)
      if (p.percent != null) this.setState({ status: 'extracting', version, percent: p.percent, step: p.step || 'extract' })
    })
    const helperState = readState()
    const verified = readVerifiedPayload(version)
    logAutoUpdate('extract.helper.done', { version, helperState, verified })
    if (helperState?.status === 'payload_ready' && normalizeVersion(helperState.version || '') === normalizeVersion(version)) {
      this.setState({ status: 'payload_ready', version, payloadRoot: helperState.payloadRoot || verified?.payloadRoot || payloadRoot(version), percent: 100, step: 'done', canInstall: true, canRetry: true, error: undefined, errorCode: undefined })
      return
    }
    if (verified) {
      this.setState({ status: 'payload_ready', version, payloadRoot: verified.payloadRoot, percent: 100, step: 'done', canInstall: true, canRetry: true, error: undefined, errorCode: undefined })
      return
    }
    throw new Error('Payload helper finished without verified.json')
  }

  async install(): Promise<{ ok: boolean; reason?: string }> {
    const state = readState()
    logAutoUpdate('install.request', { state, installDir: currentInstallDir(), helperPath: helperPath() })
    // Идемпотентность: install() не под lock (UI-кнопки disabled, но IPC-канал не гейтится).
    // Двойной вызов (двойной клик / тост+Settings гонка) спавнил бы два хелпера в один
    // installDir → порча установки. Если уже идёт — ничего не делаем.
    if (state?.status === 'install_requested' || state?.status === 'installing') {
      logAutoUpdate('install.reject', { reason: 'already-installing', status: state.status })
      return { ok: true, reason: 'already-installing' }
    }
    const version = state?.version
    if (!version) {
      logAutoUpdate('install.reject', { reason: 'no-version' })
      return { ok: false, reason: 'no-version' }
    }
    const verifiedMeta = readVerifiedPayload(version)
    const root = verifiedMeta?.payloadRoot || state.payloadRoot || payloadRoot(version)
    if (verifiedMeta) {
      logAutoUpdate('install.verified_metadata', { version, verifiedMeta })
    } else {
      const verified = verifyPayloadRoot(root, version)
      if (!verified.ok) {
        this.fail(version, verified.error || 'Payload verification failed', true, 'invalid-payload')
        logAutoUpdate('install.reject', { version, root, reason: verified.error || 'Payload verification failed' })
        return { ok: false, reason: verified.error }
      }
    }
    const node = resolveSystemNode()
    if (!node) {
      this.fail(version, 'Не удалось установить обновление автоматически. Скачайте новую версию вручную со страницы релизов на GitHub.', true, 'install-failed')
      return { ok: false, reason: 'node-missing' }
    }
    if (!existsSync(helperPath())) {
      this.fail(version, 'Не найден helper автообновления', true, 'install-failed')
      logAutoUpdate('install.reject', { version, root, reason: 'helper-missing', helperPath: helperPath() })
      return { ok: false, reason: 'helper-missing' }
    }
    this.setState({ status: 'install_requested', version, payloadRoot: root, installDir: currentInstallDir(), percent: 100, step: 'install' })
    const args = [
      helperPath(),
      '--command=install',
      `--root=${autoUpdateRoot()}`,
      `--version=${version}`,
      `--payload=${root}`,
      `--install-dir=${currentInstallDir()}`,
      `--parent-pid=${process.pid}`,
    ]
    logAutoUpdate('install.spawn_helper', { version, node, args })
    startDetachedHelper(node, args)
    this.setState({ status: 'installing', version, payloadRoot: root, installDir: currentInstallDir(), percent: 100, step: 'install' })
    app.quit()
    return { ok: true }
  }
}

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
      if (opts?.all) return fetchAllReleaseNotesMerged()
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
      console.warn('[autoupdate] get-release-notes failed:', err)
      return []
    }
  })
}

export function initAutoUpdater(mainWindow: BrowserWindow): void {
  registerReleaseNotesIpc()
  if (!app.isPackaged) return
  new AutoUpdateService(mainWindow).init()
}

export function getAutoUpdateDebugState(): AutoUpdateState | null {
  return readState()
}
