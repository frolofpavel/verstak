import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { platform, tmpdir } from 'os'
import { ProcessRegistry } from '../../electron/ai/process-registry'

function quoteArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

async function waitFor<T>(fn: () => T, predicate: (value: T) => boolean, timeoutMs = 7000): Promise<T> {
  const started = Date.now()
  let value = fn()
  while (!predicate(value)) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise(resolve => setTimeout(resolve, 50))
    value = fn()
  }
  return value
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  if (platform() === 'win32') {
    try {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      })
      return out.includes(`"${pid}"`) || out.includes(`,${pid},`)
    } catch {
      return false
    }
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killPid(pid: number): void {
  if (!pidAlive(pid)) return
  try {
    if (platform() === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 3000,
      })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    // best-effort cleanup only
  }
}

describe('ProcessRegistry anti-orphan smoke', () => {
  it('stop kills child process tree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verstak-proc-orphan-'))
    const registry = new ProcessRegistry()
    let parentPid = 0
    let grandchildPid = 0
    try {
      const parentPidFile = join(dir, 'parent.pid')
      const pidFile = join(dir, 'grandchild.pid')
      const parentScript = join(dir, 'parent.js')
      writeFileSync(parentScript, `
const { spawn } = require('child_process')
const fs = require('fs')
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  windowsHide: true,
})
fs.writeFileSync(process.argv[2], String(process.pid))
fs.writeFileSync(process.argv[3], String(child.pid))
setInterval(() => {}, 1000)
`, 'utf8')

      const handle = registry.spawn(`${quoteArg(process.execPath)} ${quoteArg(parentScript)} ${quoteArg(parentPidFile)} ${quoteArg(pidFile)}`, { cwd: dir })
      await waitFor(() => existsSync(parentPidFile), Boolean)
      await waitFor(() => existsSync(pidFile), Boolean)
      parentPid = Number(readFileSync(parentPidFile, 'utf8').trim())
      grandchildPid = Number(readFileSync(pidFile, 'utf8').trim())
      expect(pidAlive(parentPid)).toBe(true)
      expect(pidAlive(grandchildPid)).toBe(true)

      await registry.kill(handle.id)
      await waitFor(() => pidAlive(parentPid), alive => !alive)
      await waitFor(() => pidAlive(grandchildPid), alive => !alive)
    } finally {
      for (const processHandle of registry.list({ status: 'running' })) {
        await registry.kill(processHandle.id)
      }
      killPid(parentPid)
      killPid(grandchildPid)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15000)
})
