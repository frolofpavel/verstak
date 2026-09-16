import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../../electron/storage/db'
import { createBrowserTasks, type BrowserTasks } from '../../../electron/storage/browser-tasks'
import { createComputerController, type ComputerController } from '../../../electron/ai/computer/controller'
import { deferred, FakeComputerBackend } from '../../helpers/fake-computer-backend'

let dir: string
let db: Database
let storage: BrowserTasks
let backend: FakeComputerBackend
let controller: ComputerController
let runCancelEpochSizes: number[]

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'computer-cancel-'))
  db = openDb(join(dir, 'test.db'))
  storage = createBrowserTasks(db)
  storage.create({ browserTaskId: 'bt-1', projectPath: '/p', runId: 'run-1' })
  storage.appendRun({ browserTaskId: 'bt-1', runId: 'run-1' })
  storage.create({ browserTaskId: 'bt-2', projectPath: '/p', runId: 'run-2' })
  storage.appendRun({ browserTaskId: 'bt-2', runId: 'run-2' })
  backend = new FakeComputerBackend()
  runCancelEpochSizes = []
  controller = createComputerController({
    storage,
    backend,
    testOnlyOnRunCancelEpochCount: size => { runCancelEpochSizes.push(size) },
  })
  const [candidate] = await controller.listCandidates()
  await controller.bindCandidate(candidate!.candidateId)
  expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-1' }).ok).toBe(true)
})

afterEach(async () => {
  backend.stopBarrier?.resolve()
  backend.observeBarrier?.resolve()
  backend.prepareBarrier?.resolve()
  backend.commitBarrier?.resolve()
  await controller.shutdown()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function observation() {
  return controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
}

describe('ComputerController — cancellation and one local queue', () => {
  it('bounds cancelled-lineage epochs after their queued/active work drains', async () => {
    for (let index = 0; index < 2_048; index += 1) {
      await controller.cancelRun(`foreign-task-${index}`, `foreign-run-${index}`)
    }
    await Promise.resolve()

    expect(runCancelEpochSizes.length).toBeGreaterThan(0)
    expect(Math.max(...runCancelEpochSizes)).toBeLessThanOrEqual(1)
    expect(runCancelEpochSizes.at(-1)).toBe(0)
  })

  it.each(['hardware-input', 'focus-lost', 'screen-locked'] as const)(
    '%s revokes the current lineage and blocks a successor until helper Stop ACK',
    async eventType => {
      backend.stopBarrier = deferred()
      backend.emit({ type: eventType })
      await Promise.resolve()
      expect(backend.stopCount).toBe(1)

      const sameLineage = await controller.dispatch({
        actionId: `after-${eventType}`, browserTaskId: 'bt-1', runId: 'run-1', action: 'observe',
      })
      expect(sameLineage.status).toBe('blocked')
      expect(sameLineage.reason).toBe('binding-not-authorized')

      storage.appendRun({ browserTaskId: 'bt-1', runId: 'run-next' })
      expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-next' }))
        .toEqual({ ok: false, error: 'binding-active' })
      backend.stopBarrier.resolve()
      await vi.waitFor(() => {
        expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-next' }).ok).toBe(true)
      })
    },
  )

  it.each(['observe', 'wait_for'] as const)('Stop cancels an in-flight %s and never verifies it later', async action => {
    const before = storage.get('bt-1')!
    backend.observeBarrier = deferred()
    const pending = controller.dispatch({
      actionId: `stop-${action}`, browserTaskId: 'bt-1', runId: 'run-1', action,
      ...(action === 'wait_for' ? { waitFor: { text: 'never' }, timeoutMs: 1_000 } : {}),
    })
    while (backend.observeCount === 0) await Promise.resolve()
    const stopped = controller.stop()
    backend.observeBarrier.resolve()
    const result = await pending
    await stopped
    expect(result.status).toBe('cancelled')
    expect(storage.getAction(`stop-${action}`)?.status).toBe('cancelled')
    expect(storage.get('bt-1')).toMatchObject({
      observationId: before.observationId,
      observationVersion: before.observationVersion,
    })
  })

  it('Stop during post-action readback cannot publish a title or observation after revocation', async () => {
    const obs = await observation()
    const before = storage.get('bt-1')!
    const titleBefore = controller.getBinding()!.title
    backend.commitBarrier = deferred()
    backend.observeBarrier = deferred()
    const pending = controller.dispatch({
      actionId: 'stop-post-readback', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })
    while (backend.commitCount === 0) await Promise.resolve()
    backend.commitBarrier.resolve()
    while (backend.observeCount < 2) await Promise.resolve()

    const stopped = controller.stop()
    backend.probe.title = 'Late title after Stop'
    backend.probe.titleFingerprint = 'd'.repeat(64)
    backend.observeBarrier.resolve()
    const result = await pending
    await stopped

    expect(result.status).toBe('uncertain')
    expect(controller.getBinding()).toMatchObject({ title: titleBefore, expiresAt: null })
    expect(storage.get('bt-1')).toMatchObject({
      observationId: before.observationId,
      observationVersion: before.observationVersion,
    })
  })

  it('hardware input before commit cancels without an effect', async () => {
    const obs = await observation()
    backend.prepareBarrier = deferred()
    const pending = controller.dispatch({
      actionId: 'hardware-before', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })
    await Promise.resolve()
    backend.emit({ type: 'hardware-input' })
    backend.prepareBarrier.resolve()
    const result = await pending
    expect(result.status).toBe('cancelled')
    expect(backend.commitCount).toBe(0)
    expect(storage.getAction('hardware-before')?.status).toBe('cancelled')
  })

  it('hardware input after commit transfer makes the result uncertain and cancels queued work', async () => {
    const obs = await observation()
    backend.commitBarrier = deferred()
    const first = controller.dispatch({
      actionId: 'active', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })
    const second = controller.dispatch({
      actionId: 'queued', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })
    while (backend.commitCount === 0) await Promise.resolve()
    backend.emit({ type: 'hardware-input' })
    backend.commitBarrier.resolve()
    expect((await first).status).toBe('uncertain')
    expect((await second).status).toBe('cancelled')
    expect(backend.commitCount).toBe(1)
  })

  it('Stop returns bounded-target ACK without claiming real-time and post-transfer stays uncertain', async () => {
    const obs = await observation()
    backend.commitBarrier = deferred()
    const pending = controller.dispatch({
      actionId: 'stop-active', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })
    while (backend.commitCount === 0) await Promise.resolve()
    const ack = await controller.stop()
    expect(ack).toEqual({ acknowledged: true, targetAckMs: 500, realTimeGuaranteed: false })
    backend.commitBarrier.resolve()
    expect((await pending).status).toBe('uncertain')
    expect(backend.cancelCount).toBeGreaterThanOrEqual(1)
    expect(backend.stopCount).toBeGreaterThanOrEqual(1)
  })

  it('Stop revokes the run claim so no later work starts before a fresh main-owned authorization', async () => {
    const obs = await observation()
    await controller.stop()
    expect(controller.getBinding()).toMatchObject({ expiresAt: null })

    const read = await controller.dispatch({
      actionId: 'observe-after-stop', browserTaskId: 'bt-1', runId: 'run-1', action: 'observe',
    })
    expect(read.status).toBe('blocked')
    expect(read.reason).toBe('binding-not-authorized')

    const action = await controller.dispatch({
      actionId: 'stale-after-stop', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })
    expect(action.status).toBe('blocked')
    expect(action.reason).toBe('binding-not-authorized')
    expect(backend.commitCount).toBe(0)

    expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-1' }).ok).toBe(true)
    const authorized = await controller.dispatch({
      actionId: 'observe-after-reauthorize', browserTaskId: 'bt-1', runId: 'run-1', action: 'observe',
    })
    expect(authorized.status).toBe('verified')
  })

  it('scoped chat Stop revokes its pre-model claim and waits for the helper queue ACK', async () => {
    backend.stopBarrier = deferred()
    let settled = false
    const pending = controller.cancelRun('bt-1', 'run-1').then(() => { settled = true })
    await Promise.resolve()

    expect(controller.getBinding()).toMatchObject({ expiresAt: null })
    expect(backend.stopCount).toBe(1)
    expect(settled).toBe(false)

    backend.stopBarrier.resolve()
    await pending
    const late = await controller.dispatch({
      actionId: 'after-scoped-chat-stop', browserTaskId: 'bt-1', runId: 'run-1', action: 'observe',
    })
    expect(late.status).toBe('blocked')
    expect(late.reason).toBe('binding-not-authorized')
    expect(backend.observeCount).toBe(0)
  })

  it('does not authorize a successor until the prior scoped Stop ACK is complete', async () => {
    backend.stopBarrier = deferred()
    let stopped = false
    const pendingStop = controller.cancelRun('bt-1', 'run-1').then(() => { stopped = true })
    await Promise.resolve()
    expect(backend.stopCount).toBe(1)
    expect(stopped).toBe(false)

    storage.appendRun({ browserTaskId: 'bt-1', runId: 'run-next' })
    expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-next' }))
      .toEqual({ ok: false, error: 'binding-active' })

    backend.stopBarrier.resolve()
    await pendingStop
    expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-next' }).ok).toBe(true)
  })

  it('a foreign scoped cancel cannot revoke the selected owner claim', async () => {
    await controller.cancelRun('bt-2', 'run-2')
    expect(controller.getBinding()?.expiresAt).not.toBeNull()
    expect(backend.stopCount).toBe(0)

    const owner = await controller.dispatch({
      actionId: 'owner-survives-foreign-stop', browserTaskId: 'bt-1', runId: 'run-1', action: 'observe',
    })
    expect(owner.status).toBe('verified')
  })

  it('does not acknowledge Stop until the backend confirms that input drained', async () => {
    backend.stopBarrier = deferred()
    let settled = false
    const pendingAck = controller.stop().then(value => {
      settled = true
      return value
    })
    await Promise.resolve()
    expect(backend.stopCount).toBe(1)
    expect(settled).toBe(false)

    backend.stopBarrier.resolve()
    await expect(pendingAck).resolves.toEqual({
      acknowledged: true,
      targetAckMs: 500,
      realTimeGuaranteed: false,
    })
  })

  it('does not authorize a successor while global Stop is awaiting its ACK', async () => {
    backend.stopBarrier = deferred()
    const pendingAck = controller.stop()
    await Promise.resolve()
    storage.appendRun({ browserTaskId: 'bt-1', runId: 'run-next' })

    expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-next' }))
      .toEqual({ ok: false, error: 'binding-active' })

    backend.stopBarrier.resolve()
    await pendingAck
    expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-next' }).ok).toBe(true)
  })

  it('scoped abort cancels only its queued run and does not Stop another owner active in commit', async () => {
    const ownerObservation = await observation()
    backend.commitBarrier = deferred()
    const owner = controller.dispatch({
      actionId: 'owner-active', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: ownerObservation.observationId,
      elementRef: ownerObservation.elements[0]!.elementRef,
    })
    while (backend.commitCount === 0) await Promise.resolve()

    const foreignQueued = controller.dispatch({
      actionId: 'foreign-queued', browserTaskId: 'bt-2', runId: 'run-2', action: 'click',
      observationId: ownerObservation.observationId,
      elementRef: ownerObservation.elements[0]!.elementRef,
    })
    await controller.cancelRun('bt-2', 'run-2')
    expect(backend.cancelCount).toBe(0)
    expect(backend.stopCount).toBe(0)

    backend.commitBarrier.resolve()
    expect((await owner).status).toBe('verified')
    const cancelled = await foreignQueued
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.reason).toBe('run-cancelled')
    expect(backend.commitCount).toBe(1)
    expect(runCancelEpochSizes).toContain(1)
    expect(runCancelEpochSizes.at(-1)).toBe(0)
  })

  it('does not transfer the claim to a new run while the prior run has an active action', async () => {
    const obs = await observation()
    backend.prepareBarrier = deferred()
    const pending = controller.dispatch({
      actionId: 'active-before-run-adopt', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })
    while (backend.prepareCount === 0) await Promise.resolve()
    storage.appendRun({ browserTaskId: 'bt-1', runId: 'run-next' })

    expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-next' }))
      .toEqual({ ok: false, error: 'binding-active' })
    await controller.cancelRun('bt-1', 'run-1')
    backend.prepareBarrier.resolve()
    expect((await pending).status).toBe('cancelled')
  })
})
