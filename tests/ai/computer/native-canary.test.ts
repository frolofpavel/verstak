import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { createComputerController, type ComputerController } from '../../../electron/ai/computer/controller'
import { createComputerHelperBackend } from '../../../electron/ai/computer/helper-backend'
import { ComputerHelperClient } from '../../../electron/ai/computer/helper-client'
import { createBrowserTasks } from '../../../electron/storage/browser-tasks'
import { openDb } from '../../../electron/storage/db'

const nativeCanaryEnabled = process.platform === 'win32'
  && process.env.VERSTAK_COMPUTER_NATIVE_CANARY === '1'

interface CanaryState {
  pid: number
  processStartTime100ns: string
  hwnd: string
  value: string
  valueSha256: string
  scalarLength: number
  closed: boolean
}

let dir: string | null = null
let db: Database | null = null
let controller: ComputerController | null = null
let canary: ChildProcess | null = null

afterEach(async () => {
  if (controller) await controller.shutdown()
  controller = null
  if (canary && canary.exitCode == null && canary.signalCode == null) {
    const exited = new Promise<void>(resolve => canary!.once('exit', () => resolve()))
    canary.kill('SIGTERM')
    await Promise.race([exited, delay(2_000)])
  }
  canary = null
  if (db) db.close()
  db = null
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dir = null
})

describe('computer helper/controller Windows native canary', () => {
  it.runIf(nativeCanaryEnabled)(
    'completes 10/10 exact-window types and verifies every value through an external state file',
    async () => {
      dir = mkdtempSync(join(tmpdir(), 'verstak-r2-native-canary-'))
      const sourcePath = join(process.cwd(), 'tests', 'ai', 'computer', 'fixtures', 'windows-native-canary.cs')
      const executablePath = join(dir, 'verstak-r2-native-canary.exe')
      const statePath = join(dir, 'external-state.json')
      compileCanary(sourcePath, executablePath)

      const nonce = randomUUID()
      const title = `Verstak R2 native canary ${nonce}`
      canary = spawn(executablePath, [title, statePath], {
        windowsHide: false,
        stdio: 'ignore',
      })
      const initialState = await waitForState(statePath, state => (
        state.pid === canary!.pid && state.value === '' && state.closed === false
      ))

      db = openDb(join(dir, 'canary.db'))
      const storage = createBrowserTasks(db)
      storage.create({ browserTaskId: 'bt-native', projectPath: dir, runId: 'run-native' })
      storage.appendRun({ browserTaskId: 'bt-native', runId: 'run-native' })
      const backend = new ComputerHelperClient({
        helperPath: join(process.cwd(), 'resources', 'computer-use', 'helper.ps1'),
        appVersion: '2.8.2',
        requestTimeoutMs: 15_000,
      })
      controller = createComputerController({ storage, backend: createComputerHelperBackend(backend) })

      const candidate = await waitForCandidate(controller, title, initialState.pid, initialState.hwnd)
      await expect(controller.bindCandidate(candidate.candidateId)).resolves.toMatchObject({ ok: true })
      expect(controller.getBinding()?.targetFingerprint).toBe(createHash('sha256').update(
        `${initialState.pid}\u0000${initialState.processStartTime100ns}\u0000${initialState.hwnd}`,
      ).digest('hex'))
      expect(controller.authorizeRun({ browserTaskId: 'bt-native', runId: 'run-native' }).ok).toBe(true)
      let expectedText = ''
      for (let iteration = 1; iteration <= 10; iteration += 1) {
        const observation = await controller.observe({ browserTaskId: 'bt-native', runId: 'run-native' })
        expect(observation.screenshotDataUrl).toMatch(/^data:image\/png;base64,/)
        expect(Buffer.from(observation.screenshotDataUrl!.slice('data:image/png;base64,'.length), 'base64').length)
          .toBeLessThanOrEqual(16_384)
        const field = observation.elements.find(element => (
          element.label === 'Verstak canary input' && element.supportedActions.includes('type')
        ))
        expect(field, JSON.stringify({ elements: observation.elements, omissions: observation.omissions })).toBeDefined()

        const chunk = `r2-${iteration}-${nonce};`
        expectedText += chunk
        const result = await controller.dispatch({
          actionId: `native-type-${iteration}-${nonce}`,
          browserTaskId: 'bt-native',
          runId: 'run-native',
          action: 'type',
          observationId: observation.observationId,
          elementRef: field!.elementRef,
          text: chunk,
        })
        expect(result).toMatchObject({ status: 'verified', reason: 'independent-readback-verified' })

        const externalTruth = await waitForState(statePath, state => state.value === expectedText)
        expect(externalTruth).toMatchObject({
          pid: initialState.pid,
          hwnd: initialState.hwnd,
          value: expectedText,
          valueSha256: createHash('sha256').update(expectedText, 'utf8').digest('hex'),
          scalarLength: Array.from(expectedText).length,
          closed: false,
        })
      }

      const stopStarted = performance.now()
      await expect(controller.stop()).resolves.toMatchObject({ acknowledged: true })
      expect(performance.now() - stopStarted).toBeLessThanOrEqual(500)
    },
    90_000,
  )
})

function compileCanary(sourcePath: string, executablePath: string): void {
  const windowsDirectory = process.env.WINDIR ?? 'C:\\Windows'
  const candidates = [
    join(windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windowsDirectory, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
  const compiler = candidates.find(existsSync)
  if (!compiler) throw new Error('Windows .NET Framework C# compiler not found')
  const compiled = spawnSync(compiler, [
    '/nologo', '/target:winexe', '/optimize+',
    '/reference:System.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll',
    `/out:${executablePath}`, sourcePath,
  ], { encoding: 'utf8', windowsHide: true })
  if (compiled.status !== 0 || !existsSync(executablePath)) {
    throw new Error(`native canary compilation failed: ${compiled.stderr || compiled.stdout}`)
  }
}

async function waitForCandidate(
  activeController: ComputerController,
  title: string,
  pid: number,
  hwnd: string,
): Promise<Awaited<ReturnType<ComputerController['listCandidates']>>[number]> {
  const deadline = Date.now() + 15_000
  do {
    const candidates = await activeController.listCandidates()
    const matched = candidates.find(candidate => (
      candidate.title === title
      && candidate.processName === 'verstak-r2-native-canary'
    ))
    if (matched) {
      // The external state file and helper must independently identify the
      // same specially-created process/window before any binding is allowed.
      expect(matched.candidateId).toEqual(expect.any(String))
      expect(pid).toBeGreaterThan(0)
      expect(hwnd).toMatch(/^[1-9][0-9]*$/)
      return matched
    }
    await delay(50)
  } while (Date.now() < deadline)
  throw new Error('exact native canary candidate not found')
}

async function waitForState(
  path: string,
  predicate: (state: CanaryState) => boolean,
): Promise<CanaryState> {
  const deadline = Date.now() + 15_000
  do {
    try {
      const state = JSON.parse(readFileSync(path, 'utf8')) as CanaryState
      if (predicate(state)) return state
    } catch {
      // Atomic writer may not have published the first state yet.
    }
    await delay(25)
  } while (Date.now() < deadline)
  throw new Error('native canary external state did not reach the expected value')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
