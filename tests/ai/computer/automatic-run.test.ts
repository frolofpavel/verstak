import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../../electron/storage/db'
import { createBrowserTasks, type BrowserTasks } from '../../../electron/storage/browser-tasks'
import { createComputerController, type ComputerController } from '../../../electron/ai/computer/controller'
import { ComputerSafetyError } from '../../../electron/ai/computer/errors'
import { FakeComputerBackend } from '../../helpers/fake-computer-backend'

let dir: string
let db: Database
let storage: BrowserTasks
let backend: FakeComputerBackend
let controller: ComputerController

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'computer-auto-run-'))
  db = openDb(join(dir, 'test.db'))
  storage = createBrowserTasks(db)
  storage.create({ browserTaskId: 'bt-auto', projectPath: '/p', runId: 'run-auto' })
  storage.appendRun({ browserTaskId: 'bt-auto', runId: 'run-auto' })
  backend = new FakeComputerBackend()
})

afterEach(async () => {
  await controller?.shutdown()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ComputerController — automatic target preparation', () => {
  it('discovers, binds, focuses and authorizes the single matching target', async () => {
    controller = createComputerController({ storage, backend })

    await expect(controller.prepareAutomaticRun({
      browserTaskId: 'bt-auto',
      runId: 'run-auto',
      originalUserText: 'Открой Блокнот и напиши: Тест Verstak Computer Use',
    })).resolves.toMatchObject({ ok: true })

    expect(backend.listCount).toBe(1)
    expect(backend.probeCount).toBeGreaterThanOrEqual(2)
    expect(backend.focusCount).toBe(1)
    expect(controller.getBinding()).toMatchObject({ processName: 'notepad.exe' })
  })

  it('launches only the allowlisted requested app when no target exists, then discovers it again', async () => {
    backend.candidates = []
    const launchApplication = vi.fn(async () => {
      backend.candidates = [backend.notepadCandidate()]
    })
    controller = createComputerController({
      storage,
      backend,
      launchApplication,
      automaticDiscoveryDelayMs: 0,
    })

    await expect(controller.prepareAutomaticRun({
      browserTaskId: 'bt-auto',
      runId: 'run-auto',
      originalUserText: 'Открой Блокнот и напиши: Тест',
    })).resolves.toMatchObject({ ok: true })

    expect(launchApplication).toHaveBeenCalledWith('notepad')
    expect(backend.listCount).toBe(2)
    expect(backend.focusCount).toBe(1)
  })

  it('fails without acting when equal candidates are ambiguous', async () => {
    backend.candidates = [
      backend.notepadCandidate({ hwnd: '101', title: 'A — Блокнот', foreground: false }),
      backend.notepadCandidate({ hwnd: '102', title: 'B — Блокнот', foreground: false }),
    ]
    controller = createComputerController({ storage, backend })

    await expect(controller.prepareAutomaticRun({
      browserTaskId: 'bt-auto',
      runId: 'run-auto',
      originalUserText: 'Напиши тест в Блокнот',
    })).resolves.toEqual({ ok: false, error: 'automatic-target-ambiguous' })

    expect(backend.focusCount).toBe(0)
    expect(controller.getBinding()).toBeNull()
  })

  it('re-discovers the foreground target once when Windows redirects automatic focus', async () => {
    const focusBinding = backend.focusBinding.bind(backend)
    let focusAttempts = 0
    vi.spyOn(backend, 'focusBinding').mockImplementation(async identity => {
      focusAttempts += 1
      if (focusAttempts === 1) {
        backend.candidates = [backend.notepadCandidate({ foreground: true })]
        throw new ComputerSafetyError('focus-lost')
      }
      return focusBinding(identity)
    })
    controller = createComputerController({ storage, backend })

    await expect(controller.prepareAutomaticRun({
      browserTaskId: 'bt-auto',
      runId: 'run-auto',
      originalUserText: 'Открой Блокнот и напиши: Тест Verstak Computer Use',
    })).resolves.toMatchObject({ ok: true })

    expect(backend.listCount).toBe(2)
    expect(focusAttempts).toBe(2)
    expect(controller.getBinding()).toMatchObject({
      source: 'automatic',
      processName: 'notepad.exe',
    })
  })

  it('reselects automatically for a later run in the same chat instead of requiring claim expiry', async () => {
    controller = createComputerController({ storage, backend })
    await expect(controller.prepareAutomaticRun({
      browserTaskId: 'bt-auto',
      runId: 'run-auto',
      originalUserText: 'Открой Блокнот и напиши первый текст',
    })).resolves.toMatchObject({ ok: true })

    storage.appendRun({ browserTaskId: 'bt-auto', runId: 'run-next' })
    await expect(controller.prepareAutomaticRun({
      browserTaskId: 'bt-auto',
      runId: 'run-next',
      originalUserText: 'Открой Блокнот и напиши второй текст',
    })).resolves.toMatchObject({ ok: true })

    expect(backend.focusCount).toBe(2)
  })

  it('releases a completed automatic claim before preparing a different chat', async () => {
    controller = createComputerController({ storage, backend })
    await expect(controller.prepareAutomaticRun({
      browserTaskId: 'bt-auto',
      runId: 'run-auto',
      originalUserText: 'Открой Блокнот и напиши первый текст',
    })).resolves.toMatchObject({ ok: true })

    storage.create({ browserTaskId: 'bt-next', projectPath: '/p', runId: 'run-next' })
    storage.appendRun({ browserTaskId: 'bt-next', runId: 'run-next' })
    await expect(controller.prepareAutomaticRun({
      browserTaskId: 'bt-next',
      runId: 'run-next',
      originalUserText: 'Открой Блокнот и напиши второй текст',
    })).resolves.toMatchObject({ ok: true })

    expect(backend.stopCount).toBe(1)
    expect(backend.focusCount).toBe(2)
    expect(controller.getBinding()).toMatchObject({ source: 'automatic' })
  })
})
