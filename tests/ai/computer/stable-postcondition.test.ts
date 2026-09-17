import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../../electron/storage/db'
import { createBrowserTasks, type BrowserTasks } from '../../../electron/storage/browser-tasks'
import { createComputerController, type ComputerController } from '../../../electron/ai/computer/controller'
import { FakeComputerBackend } from '../../helpers/fake-computer-backend'

let dir: string
let db: Database
let storage: BrowserTasks
let backend: FakeComputerBackend
let controller: ComputerController

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'computer-stable-postcondition-'))
  db = openDb(join(dir, 'test.db'))
  storage = createBrowserTasks(db)
  storage.create({ browserTaskId: 'bt-1', projectPath: '/p', runId: 'run-1' })
  storage.appendRun({ browserTaskId: 'bt-1', runId: 'run-1' })
  backend = new FakeComputerBackend()
  controller = createComputerController({ storage, backend, postconditionSettleMs: 5 })
  const [candidate] = await controller.listCandidates()
  await controller.bindCandidate(candidate!.candidateId)
  expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-1' }).ok).toBe(true)
})

afterEach(async () => {
  await controller.shutdown()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ComputerController — stable postcondition', () => {
  it('does not verify a type effect that is visible in only the first post-action observation', async () => {
    const before = { ...backend.observation.elements[0]!.valueState! }
    const observe = backend.observe.bind(backend)
    let postActionReads = 0
    backend.observe = async identity => {
      const result = await observe(identity)
      if (backend.commitCount > 0 && ++postActionReads === 1) {
        backend.observation.elements[0]!.valueState = { ...before }
      }
      return result
    }

    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const result = await controller.dispatch({
      actionId: 'transient-type', browserTaskId: 'bt-1', runId: 'run-1', action: 'type',
      observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
      text: 'stable',
    })

    expect(result).toMatchObject({ status: 'uncertain', reason: 'readback-mismatch' })
    expect(postActionReads).toBe(2)
    expect(storage.getAction('transient-type')).toMatchObject({ status: 'uncertain' })
  })

  it('Stop during the settle window aborts before a second observation and never verifies', async () => {
    await controller.shutdown()
    backend = new FakeComputerBackend()
    controller = createComputerController({ storage, backend, postconditionSettleMs: 250 })
    const [candidate] = await controller.listCandidates()
    await controller.bindCandidate(candidate!.candidateId)
    expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-1' }).ok).toBe(true)

    const observation = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const pending = controller.dispatch({
      actionId: 'stop-during-settle', browserTaskId: 'bt-1', runId: 'run-1', action: 'type',
      observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
      text: 'stable',
    })
    while (backend.observeCount < 2) await Promise.resolve()

    const stopStarted = performance.now()
    const stopped = controller.stop()
    const result = await pending
    await stopped

    expect(performance.now() - stopStarted).toBeLessThanOrEqual(500)
    expect(result).toMatchObject({ status: 'uncertain', reason: 'stopped' })
    expect(backend.observeCount).toBe(2)
    expect(storage.getAction('stop-during-settle')).toMatchObject({ status: 'uncertain' })
  })
})
