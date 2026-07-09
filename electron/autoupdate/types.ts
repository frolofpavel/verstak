export type AutoUpdateStatus =
  | 'idle'
  | 'checking'
  | 'update_available'
  | 'downloading'
  | 'downloaded'
  | 'extracting'
  | 'payload_ready'
  | 'install_requested'
  | 'installing'
  | 'installed_pending_restart'
  | 'complete'
  | 'failed_recoverable'
  | 'failed_final'

export type AutoUpdateStep = 'check' | 'download' | 'extract' | 'verify' | 'install' | 'cleanup' | 'done'

export type AutoUpdateState = {
  schemaVersion: 1
  status: AutoUpdateStatus
  version?: string
  installedVersion?: string
  remoteVersion?: string
  installerFileName?: string
  installerSha512?: string
  installerSize?: number
  installerPath?: string
  payloadRoot?: string
  installDir?: string
  percent?: number
  step?: AutoUpdateStep
  error?: string
  errorCode?: 'network' | 'github-rate-limit' | 'invalid-payload' | 'install-failed' | 'busy'
  rateLimitMinutes?: number
  pendingRelease?: boolean
  canRetry?: boolean
  canInstall?: boolean
  updatedAt: number
}

export type DownloadProgress = {
  percent: number
  transferred: number
  total: number
}

export type UiUpdateSnapshot = {
  phase: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'staging' | 'ready' | 'installing' | 'error'
  version?: string
  percent?: number
  stagingStep?: 'setup' | 'payload' | 'verify' | 'done'
  error?: string
  errorCode?: 'network' | 'github-rate-limit'
  rateLimitMinutes?: number
  pendingRelease?: boolean
  installedVersion?: string
  remoteVersion?: string
  updatedAt?: number
}
