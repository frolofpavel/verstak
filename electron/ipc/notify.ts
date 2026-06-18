import { BrowserWindow, ipcMain } from 'electron'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { showAppToast } from '../notification-window'
import type { Settings } from '../storage/settings'

function firstExisting(dir: string, names: string[]): string | null {
  for (const name of names) {
    const path = join(dir, name)
    if (existsSync(path)) return path
  }
  return null
}

function windowsPowerShellPath(): string {
  return join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** Standard Windows notification WAV from %WINDIR%\\Media (sound-only, no OS toast). */
function playWindowsNotificationSound(isError = false): void {
  if (process.platform !== 'win32') return
  const media = join(process.env.WINDIR ?? 'C:\\Windows', 'Media')
  const wav = isError
    ? firstExisting(media, ['Windows Background.wav', 'Windows Error.wav', 'Windows Notify System Generic.wav'])
    : firstExisting(media, [
        'Windows Notify System Generic.wav',
        'Windows Notify.wav',
        'notify.wav'
      ])
  if (!wav) return
  const escaped = wav.replace(/'/g, "''")
  const script = [
    "[void][Reflection.Assembly]::LoadWithPartialName('System.Media')",
    `$p = New-Object System.Media.SoundPlayer('${escaped}')`,
    '$p.PlaySync()'
  ].join('; ')
  execFile(
    windowsPowerShellPath(),
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
    { windowsHide: true },
    () => {}
  )
}

function readTheme(settings: Settings): 'nord' | 'light' {
  const raw = settings.getSecret('theme')
  return raw === 'light' ? 'light' : 'nord'
}

export function registerNotifyIpc(getMainWindow: () => BrowserWindow | null, settings: Settings): void {
  ipcMain.handle('app:is-focused', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle('notify:play-sound', (_e, opts?: { isError?: boolean }) => {
    playWindowsNotificationSound(!!opts?.isError)
    return true
  })

  ipcMain.handle('notify:show', (_e, opts: {
    title?: string
    body: string
    projectName?: string
    projectPath?: string
    isHelp?: boolean
    helpProjectPath?: string
    isError?: boolean
  }) => {
    const title = (opts.title ?? 'Verstak').slice(0, 120)
    const body = (opts.body ?? '').slice(0, 240)
    const projectName = opts.projectName?.slice(0, 80)
    const projectPath = opts.projectPath?.slice(0, 512)
    const helpProjectPath = opts.helpProjectPath?.slice(0, 512)

    showAppToast({
      title,
      body,
      projectName,
      projectPath,
      isHelp: !!opts.isHelp,
      helpProjectPath,
      isError: !!opts.isError,
      theme: readTheme(settings)
    })

    return true
  })
}