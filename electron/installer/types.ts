export type InstallProgress = {
  phase: 'preparing' | 'copying' | 'shortcuts' | 'registry' | 'done'
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  currentFile: string
  percent: number
}

export type InstallDefaults = {
  version: string
  productName: string
  defaultInstallDir: string
  payloadBytes: number
  fileCount: number
}

export type InstallResult = {
  ok: boolean
  installDir?: string
  error?: string
}