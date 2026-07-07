import { spawn as spawnChild, execFileSync, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { platform } from 'os'
import { treeKill } from './child-kill'
import { scanText } from './secret-scanner'

export type ProcessStatus = 'running' | 'completed' | 'failed' | 'killed'

export interface ProcessHandle {
  id: string
  pid: number
  command: string
  cwd: string
  startedAt: number
  exitedAt?: number
  exitCode?: number
  status: ProcessStatus
  outputTail: string
  notifyOnExit: boolean
  hostStartTime?: string | null
}

export interface ProcessCompletion {
  id: string
  pid: number
  command: string
  cwd: string
  startedAt: number
  exitedAt: number
  exitCode?: number
  status: ProcessStatus
  outputTail: string
}

export interface ProcessRegistryDeps {
  now?: () => number
  treeKill?: (child: ChildProcess) => void
  getHostStartTime?: (pid: number) => string | null
}

interface InternalProcessHandle extends ProcessHandle {
  child: ChildProcess
  timeout?: NodeJS.Timeout
  completionQueued?: boolean
}

const DEFAULT_TAIL_CHARS = 30 * 1024
const DEFAULT_TTL_MS = 30 * 60_000

function trimTail(text: string, maxChars = DEFAULT_TAIL_CHARS): string {
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  return chars.slice(chars.length - maxChars).join('')
}

function cloneHandle(handle: InternalProcessHandle): ProcessHandle {
  const { child: _child, timeout: _timeout, ...safe } = handle
  return { ...safe }
}

export function getProcessStartTime(pid: number): string | null {
  try {
    if (platform() === 'win32') {
      const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CreationDate.ToUniversalTime().ToString("o")`
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      }).trim()
      return out || null
    }
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim()
    return out || null
  } catch {
    return null
  }
}

export class ProcessRegistry {
  private readonly processes = new Map<string, InternalProcessHandle>()
  private readonly now: () => number
  private readonly killTree: (child: ChildProcess) => void
  private readonly hostStartTime: (pid: number) => string | null
  private sweeper?: NodeJS.Timeout
  private readonly completions: ProcessCompletion[] = []

  constructor(deps: ProcessRegistryDeps = {}) {
    this.now = deps.now ?? Date.now
    this.killTree = deps.treeKill ?? treeKill
    this.hostStartTime = deps.getHostStartTime ?? getProcessStartTime
  }

  spawn(command: string, opts: { cwd: string; timeout?: number; notifyOnExit?: boolean }): ProcessHandle {
    const child = spawnChild(command, {
      cwd: opts.cwd,
      shell: true,
      detached: platform() !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (!child.pid) {
      throw new Error('process did not expose pid')
    }

    const id = randomUUID()
    const handle: InternalProcessHandle = {
      id,
      pid: child.pid,
      command,
      cwd: opts.cwd,
      startedAt: this.now(),
      status: 'running',
      outputTail: '',
      notifyOnExit: opts.notifyOnExit === true,
      hostStartTime: this.hostStartTime(child.pid),
      child,
    }
    this.processes.set(id, handle)

    child.stdout?.on('data', chunk => this.appendOutput(id, String(chunk)))
    child.stderr?.on('data', chunk => this.appendOutput(id, String(chunk)))
    child.on('close', code => {
      const exitCode = typeof code === 'number' ? code : -1
      this.markExited(id, exitCode)
    })
    child.on('error', error => {
      this.appendOutput(id, `\n[process error] ${error.message}`)
      this.markExited(id, -1)
    })

    if (opts.timeout && opts.timeout > 0) {
      handle.timeout = setTimeout(() => {
        void this.kill(id)
      }, opts.timeout)
      handle.timeout.unref?.()
    }

    return cloneHandle(handle)
  }

  get(id: string): ProcessHandle | undefined {
    const handle = this.processes.get(id)
    return handle ? cloneHandle(handle) : undefined
  }

  list(filter: { status?: ProcessStatus } = {}): ProcessHandle[] {
    return Array.from(this.processes.values())
      .filter(handle => !filter.status || handle.status === filter.status)
      .map(cloneHandle)
  }

  appendOutput(id: string, chunk: string): void {
    const handle = this.processes.get(id)
    if (!handle) return
    const redacted = scanText(chunk).redacted
    handle.outputTail = trimTail(handle.outputTail + redacted)
  }

  markExited(id: string, exitCode: number): void {
    const handle = this.processes.get(id)
    if (!handle || handle.exitedAt) return
    if (handle.timeout) clearTimeout(handle.timeout)
    handle.exitCode = exitCode
    handle.exitedAt = this.now()
    if (handle.status === 'killed') return
    handle.status = exitCode === 0 ? 'completed' : 'failed'
    this.queueCompletion(handle)
  }

  async kill(id: string): Promise<void> {
    const handle = this.processes.get(id)
    if (!handle || handle.status !== 'running') return
    if (!this.hostPidIsOurs(handle)) {
      handle.status = 'failed'
      handle.exitedAt = this.now()
      handle.exitCode = -1
      this.appendOutput(id, '\n[process registry] pid reuse guard blocked kill')
      return
    }
    handle.status = 'killed'
    handle.exitedAt = this.now()
    handle.exitCode = -1
    if (handle.timeout) clearTimeout(handle.timeout)
    this.queueCompletion(handle)
    this.killTree(handle.child)
  }

  drainCompletions(): ProcessCompletion[] {
    return this.completions.splice(0)
  }

  pruneFinished(ttlMs = DEFAULT_TTL_MS): number {
    const cutoff = this.now() - ttlMs
    let removed = 0
    for (const [id, handle] of this.processes) {
      if (handle.status === 'running') continue
      if ((handle.exitedAt ?? handle.startedAt) > cutoff) continue
      this.processes.delete(id)
      removed++
    }
    return removed
  }

  startSweeper(intervalMs = 60_000, ttlMs = Number(process.env.VERSTAK_PROCESS_TTL_MS || DEFAULT_TTL_MS)): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => {
      this.pruneFinished(ttlMs)
    }, intervalMs)
    this.sweeper.unref?.()
  }

  stopSweeper(): void {
    if (!this.sweeper) return
    clearInterval(this.sweeper)
    this.sweeper = undefined
  }

  private hostPidIsOurs(handle: InternalProcessHandle): boolean {
    if (!handle.hostStartTime) return true
    const current = this.hostStartTime(handle.pid)
    if (!current) return true
    return current === handle.hostStartTime
  }

  private queueCompletion(handle: InternalProcessHandle): void {
    if (!handle.notifyOnExit || handle.completionQueued || !handle.exitedAt) return
    handle.completionQueued = true
    this.completions.push({
      id: handle.id,
      pid: handle.pid,
      command: handle.command,
      cwd: handle.cwd,
      startedAt: handle.startedAt,
      exitedAt: handle.exitedAt,
      exitCode: handle.exitCode,
      status: handle.status,
      outputTail: handle.outputTail,
    })
  }
}

export const globalProcessRegistry = new ProcessRegistry()
