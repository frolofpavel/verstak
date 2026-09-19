import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { createComputerController, type ComputerController } from '../../../electron/ai/computer/controller'
import { createComputerHelperBackend } from '../../../electron/ai/computer/helper-backend'
import { ComputerHelperClient } from '../../../electron/ai/computer/helper-client'
import type { AutomaticComputerApp } from '../../../electron/ai/computer/automatic-target'
import { openDb } from '../../../electron/storage/db'
import { createBrowserTasks } from '../../../electron/storage/browser-tasks'

const enabled = process.platform === 'win32'
  && process.env.VERSTAK_COMPUTER_NATIVE_ACCEPTANCE === '1'

let dir: string
let db: Database
let controller: ComputerController
let beforePids: Set<number>
let lastCommit: unknown

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verstak-auto-apps-'))
  db = openDb(join(dir, 'acceptance.db'))
  beforePids = applicationPids()
  lastCommit = null
})

afterEach(async () => {
  await controller?.shutdown()
  db?.close()
  stopNewApplicationProcesses(beforePids)
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('Computer Use automatic Windows app acceptance', () => {
  it.runIf(enabled)('opens Notepad, selects and focuses it, types text, and reads it back', async () => {
    controller = createNativeController()
    const prepared = await controller.prepareAutomaticRun({
      browserTaskId: 'bt-auto-native',
      runId: 'run-auto-native',
      originalUserText: 'Открой Блокнот и напиши: Тест Verstak Computer Use',
    })
    expect(prepared).toMatchObject({ ok: true })

    const observation = await controller.observe({ browserTaskId: 'bt-auto-native', runId: 'run-auto-native' })
    const field = observation.elements.find(element => element.supportedActions.includes('type'))
    expect(field, JSON.stringify(observation.elements)).toBeDefined()
    const result = await controller.dispatch({
      actionId: 'native-auto-notepad-type',
      browserTaskId: 'bt-auto-native',
      runId: 'run-auto-native',
      action: 'type',
      observationId: observation.observationId,
      elementRef: field!.elementRef,
      text: 'Тест Verstak Computer Use',
    })
    expect(result).toMatchObject({ status: 'verified', reason: 'independent-readback-verified' })
    const readback = await controller.observe({ browserTaskId: 'bt-auto-native', runId: 'run-auto-native' })
    expect(readback.text).toContain('Тест Verstak Computer Use')
  }, 60_000)

  it.runIf(enabled)('opens Calculator, clicks 125 × 47, and reads back 5875', async () => {
    controller = createNativeController()
    const prepared = await controller.prepareAutomaticRun({
      browserTaskId: 'bt-auto-native',
      runId: 'run-auto-native',
      originalUserText: 'Открой калькулятор и посчитай 125 × 47.',
    })
    expect(prepared).toMatchObject({ ok: true })

    // Fresh Calculator starts at a clean zero. Clear would be idempotent and
    // therefore correctly fail the engine's independent-effect proof. The
    // ordinary agent flow must begin with the first operand instead.
    for (const labels of [
      ['One', 'Один'],
      ['Two', 'Два'],
      ['Five', 'Пять'],
      ['Multiply by', 'Умножить на'],
      ['Four', 'Четыре'],
      ['Seven', 'Семь'],
      ['Equals', 'Равно'],
    ]) {
      const observation = await controller.observe({ browserTaskId: 'bt-auto-native', runId: 'run-auto-native' })
      const button = observation.elements.find(element => (
        normalized(element.role) === normalized('Button')
        && element.supportedActions.includes('click')
        && labels.some(label => normalized(element.label) === normalized(label))
      ))
      expect(button, JSON.stringify({ labels, elements: observation.elements })).toBeDefined()
      const result = await controller.dispatch({
        actionId: `native-auto-calculator-${labels.at(-1)}`,
        browserTaskId: 'bt-auto-native',
        runId: 'run-auto-native',
        action: 'click',
        observationId: observation.observationId,
        elementRef: button!.elementRef,
      })
      const failureReadback = result.status === 'verified'
        ? null
        : await controller.observe({ browserTaskId: 'bt-auto-native', runId: 'run-auto-native' })
      expect(result, JSON.stringify({ labels, button, result, lastCommit, failureReadback })).toMatchObject({
        status: 'verified',
        reason: 'independent-readback-verified',
      })
    }

    const readback = await controller.observe({ browserTaskId: 'bt-auto-native', runId: 'run-auto-native' })
    expect(readback.text.replace(/[\s,.]/gu, '')).toContain('5875')
  }, 90_000)
})

function createNativeController(): ComputerController {
  const storage = createBrowserTasks(db)
  storage.create({ browserTaskId: 'bt-auto-native', projectPath: dir, runId: 'run-auto-native' })
  storage.appendRun({ browserTaskId: 'bt-auto-native', runId: 'run-auto-native' })
  const client = new ComputerHelperClient({
    helperPath: join(process.cwd(), 'resources', 'computer-use', 'helper.ps1'),
    appVersion: '2.9.1',
    requestTimeoutMs: 15_000,
  })
  const backend = createComputerHelperBackend(client)
  const commitAction = backend.commitAction.bind(backend)
  backend.commitAction = async (...args) => {
    const commit = await commitAction(...args)
    lastCommit = commit
    return commit
  }
  return createComputerController({
    storage,
    backend,
    launchApplication: launch,
    automaticDiscoveryDelayMs: 200,
  })
}

async function launch(app: AutomaticComputerApp): Promise<void> {
  const executable = app === 'notepad' ? 'notepad.exe' : 'calc.exe'
  const child = spawn(executable, [], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/\s+/gu, ' ').trim()
}

function applicationPids(): Set<number> {
  const found = new Set<number>()
  for (const name of ['notepad', 'calculatorapp']) {
    try {
      const result = spawnSync('tasklist.exe', [
        '/FI', `IMAGENAME eq ${name}.exe`, '/FO', 'CSV', '/NH',
      ], { encoding: 'utf8', windowsHide: true })
      for (const line of String(result.stdout ?? '').split(/\r?\n/u)) {
        const match = line.match(/^"[^"]+","(\d+)"/u)
        if (match) found.add(Number(match[1]))
      }
    } catch { /* best-effort test cleanup */ }
  }
  return found
}

function stopNewApplicationProcesses(existing: Set<number>): void {
  for (const pid of applicationPids()) {
    if (existing.has(pid)) continue
    try {
      process.kill(pid)
    } catch { /* process already exited */ }
  }
}
