import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'better-sqlite3'
import { createComputerController, type ComputerController } from '../../../electron/ai/computer/controller'
import type { BackendObservedElement } from '../../../electron/ai/computer/types'
import {
  computerHandler,
  configureComputerHandler,
} from '../../../electron/ipc/tool-handlers/computer'
import type { ToolContext } from '../../../electron/ipc/tool-handlers/shared'
import { serializeProviderToolResult } from '../../../electron/ai/provider-tool-result'
import { createBrowserTasks, type BrowserTasks } from '../../../electron/storage/browser-tasks'
import { openDb } from '../../../electron/storage/db'
import { FakeComputerBackend } from '../../helpers/fake-computer-backend'

let dir: string
let db: Database
let storage: BrowserTasks
let backend: FakeComputerBackend
let controller: ComputerController

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'computer-live-calc-'))
  db = openDb(join(dir, 'test.db'))
  storage = createBrowserTasks(db)
  storage.create({ browserTaskId: 'bt-r2', projectPath: '/p', runId: 'run-r2' })
  storage.appendRun({ browserTaskId: 'bt-r2', runId: 'run-r2' })
  backend = new FakeComputerBackend()
  installCalculatorSurface(backend)
  controller = createComputerController({ storage, backend })
  const [candidate] = await controller.listCandidates()
  await controller.bindCandidate(candidate!.candidateId)
  expect(controller.authorizeRun({ browserTaskId: 'bt-r2', runId: 'run-r2' }).ok).toBe(true)
  configureComputerHandler({ controller })
})

afterEach(async () => {
  configureComputerHandler({})
  await controller.shutdown()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('Computer Use live path: model → wrap → handler → controller', () => {
  it('identifies the installed 2.9.1 first click as Open Navigation: 5000-char JSON drops One, chrome click stays at 0', async () => {
    const observed = await computerHandler.handle(
      { id: 'call-observe-1', name: 'computer_observe', args: {} },
      context(),
    )
    const payload = observationPayload(observed.result)
    const liveSlice = JSON.stringify(observed.result).slice(0, 5000)
    const chromeRef = payload.observation.elements[0]?.elementRef
    expect(chromeRef).toMatch(/^we-[0-9a-f-]{36}$/i)
    expect(payload.observationText).toContain(`[${chromeRef}] Button: Open Navigation`)
    expect(liveSlice).toContain(chromeRef)
    expect(liveSlice).not.toContain('Open Navigation')
    expect(buttonFromEnvelope(liveSlice, ['One', 'Один'])).toBeUndefined()

    backend.readbackMatched = false
    backend.effectMatched = false
    const clicked = await computerHandler.handle({
      id: 'call-click-chrome',
      name: 'computer_click',
      args: {
        observationId: payload.observation.observationId,
        elementRef: chromeRef!,
      },
    }, context())

    expect(clicked.result).toMatchObject({
      status: 'uncertain',
      actionId: expect.stringMatching(/^run-r2:computer-[0-9a-f]{32}$/),
    })
    expect(String((clicked.result as { detail?: string }).detail)).toMatch(/readback-mismatch/)
    expect(clicked.error).toMatch(/неизвестен|повтор запрещён/i)
    expect(backend.observation.text).toBe('0')
    expect(backend.commitCount).toBe(1)

    const replay = await computerHandler.handle({
      id: 'call-click-chrome',
      name: 'computer_click',
      args: {
        observationId: payload.observation.observationId,
        elementRef: chromeRef!,
      },
    }, context())
    expect(replay.result).toMatchObject({ status: 'uncertain' })
    expect(replay.error).toMatch(/повтор запрещён/i)
    expect(backend.commitCount).toBe(1)
    expect(backend.observation.text).toBe('0')
  })

  it('clicks Button One from the live provider envelope through the production handler', async () => {
    const observed = await computerHandler.handle(
      { id: 'call-observe-2', name: 'computer_observe', args: {} },
      context(),
    )
    const payload = observationPayload(observed.result)
    const envelope = serializeProviderToolResult(observed)
    const oneRef = buttonFromEnvelope(envelope, ['One', 'Один'])
    expect(oneRef, envelope.slice(0, 800)).toBeDefined()
    expect(oneRef).not.toBe(payload.observation.elements[0]?.elementRef)

    backend.readbackMatched = true
    backend.effectMatched = true
    const originalCommit = backend.commitAction.bind(backend)
    backend.commitAction = async (prepared, options) => {
      const label = preparedLabel(backend)
      if (['One', 'Один'].some(value => normalized(value) === normalized(label))) {
        backend.observation.text = '1'
      }
      return originalCommit(prepared, options)
    }

    const clicked = await computerHandler.handle({
      id: 'call-click-one',
      name: 'computer_click',
      args: {
        observationId: payload.observation.observationId,
        elementRef: oneRef!,
      },
    }, context())

    expect(clicked.error).toBeUndefined()
    expect(clicked.result).toMatchObject({ status: 'verified' })
    expect(backend.observation.text).toBe('1')
    expect(backend.commitCount).toBe(1)
  })
})

function context(): ToolContext {
  return {
    sendId: 17,
    runId: 'run-r2',
    browserTaskId: 'bt-r2',
    agentMode: 'auto',
    computerUseAllowedActions: ['observe', 'wait_for', 'click', 'type', 'key', 'scroll'],
    signal: new AbortController().signal,
    sender: { send: vi.fn(), exec: vi.fn() },
    recordRunEvent: vi.fn(),
    appendAudit: vi.fn(),
  } as unknown as ToolContext
}

function observationPayload(result: unknown): {
  observation: {
    observationId: string
    elements: Array<{
      elementRef: string
      role?: string
      label?: string
      supportedActions: string[]
    }>
  }
  observationText: string
} {
  expect(result).toEqual(expect.objectContaining({
    observation: expect.objectContaining({
      observationId: expect.stringMatching(/^wo-[0-9a-f-]{36}$/i),
      elements: expect.any(Array),
    }),
    observationText: expect.any(String),
  }))
  return result as {
    observation: {
      observationId: string
      elements: Array<{
        elementRef: string
        role?: string
        label?: string
        supportedActions: string[]
      }>
    }
    observationText: string
  }
}

function buttonFromEnvelope(payload: string, labels: string[]): string | undefined {
  const wanted = new Set(labels.map(normalized))
  let text = payload
  try {
    const parsed = JSON.parse(payload) as { observationText?: string }
    if (typeof parsed.observationText === 'string') text = parsed.observationText
  } catch {
    // Installed 2.9.1 gateway slice is raw JSON, not the compact envelope.
  }
  for (const match of text.matchAll(/\[(we-[^\]]+)\] ([^:]+): ([^;]+); actions=([^\n]*)/gu)) {
    const [, elementRef, role, label, actions] = match
    if (normalized(role) !== 'button') continue
    if (!actions.includes('click')) continue
    if (wanted.has(normalized(label))) return elementRef
  }
  return undefined
}

function preparedLabel(source: FakeComputerBackend): string {
  const preparedRef = source.lastPrepare?.resolvedElement?.backendRef ?? ''
  return source.observation.elements.find(element => (
    preparedRef === element.backendRef || preparedRef.startsWith(`${element.backendRef}:`)
  ))?.label ?? ''
}

function installCalculatorSurface(source: FakeComputerBackend): void {
  source.candidates = [{
    identity: source.probe.identity,
    processName: 'CalculatorApp.exe',
    title: 'Калькулятор',
    titleFingerprint: createHash('sha256').update('window-title|Калькулятор').digest('hex'),
    geometry: { left: 100, top: 80, width: 420, height: 640 },
    visible: true,
    foreground: true,
    elevated: false,
    protectedProcess: false,
    secureSurface: false,
  }]
  source.probe = {
    ...source.probe,
    title: 'Калькулятор',
    titleFingerprint: createHash('sha256').update('window-title|Калькулятор').digest('hex'),
    geometry: { left: 100, top: 80, width: 420, height: 640 },
  }
  source.observation = {
    ...source.observation,
    text: '0',
    elements: calculatorButtons(),
  }
}

function calculatorButtons(): BackendObservedElement[] {
  // ControlView BFS on a fresh Calculator starts with navigation chrome.
  // Pad filler reproduces the live 5000-char JSON cut: digit labels live in
  // observationText after the unlabeled structured array.
  const chrome = [
    button('nav', 'Open Navigation', 110, 90),
    button('history', 'History', 160, 90),
    button('memory', 'Memory', 210, 90),
    button('clear', 'Clear', 150, 180),
  ]
  const filler = Array.from({ length: 48 }, (_, index) => (
    button(`pad-${index + 1}`, `Pad ${index + 1}`, 150, 220)
  ))
  const keys = [
    button('one', 'One', 150, 420),
    button('two', 'Two', 210, 420),
    button('five', 'Five', 210, 360),
    button('multiply', 'Multiply by', 330, 360),
    button('four', 'Four', 150, 360),
    button('seven', 'Seven', 150, 300),
    button('equals', 'Equals', 330, 480),
  ]
  return [...chrome, ...filler, ...keys]
}

function button(id: string, label: string, left: number, top: number): BackendObservedElement {
  return {
    backendRef: `uia:${id}`,
    semanticFingerprint: createHash('sha256').update(`calc|${id}`).digest('hex'),
    role: 'Button',
    label,
    bounds: { left, top, width: 48, height: 48 },
    isPassword: false,
    supportedActions: ['click'],
  }
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/\s+/gu, ' ').trim()
}
