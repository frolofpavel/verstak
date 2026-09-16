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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'computer-unknown-'))
  db = openDb(join(dir, 'test.db'))
  storage = createBrowserTasks(db)
  storage.create({ browserTaskId: 'bt-1', projectPath: '/p', runId: 'run-1' })
  storage.appendRun({ browserTaskId: 'bt-1', runId: 'run-1' })
  backend = new FakeComputerBackend()
  controller = createComputerController({ storage, backend })
  const [candidate] = await controller.listCandidates()
  await controller.bindCandidate(candidate!.candidateId)
  expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-1' }).ok).toBe(true)
})

afterEach(async () => {
  await controller.shutdown()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function click(actionId: string) {
  const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
  return controller.dispatch({
    actionId, browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
    observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
  })
}

async function acknowledgeUncertain(): Promise<boolean> {
  const prepared = controller.prepareUncertainAcknowledgement()
  return prepared ? controller.acknowledgePreparedUncertain(prepared.challenge) : false
}

describe('ComputerController — two-phase unknown-effect boundary', () => {
  it('is definite failed before transfer', async () => {
    backend.throwBeforeTransfer = new Error('helper rejected before write')
    const result = await click('before-transfer')
    expect(result.status).toBe('failed')
    expect(storage.getAction('before-transfer')?.status).toBe('failed')
  })

  it('is uncertain after transfer and the same actionId never dispatches twice', async () => {
    const initial = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const input = {
      actionId: 'after-transfer', browserTaskId: 'bt-1', runId: 'run-1', action: 'click' as const,
      observationId: initial.observationId, elementRef: initial.elements[0]!.elementRef,
    }
    backend.throwAfterTransfer = new Error('transport lost')
    const first = await controller.dispatch(input)
    expect(first.status).toBe('uncertain')
    expect(storage.getAction('after-transfer')?.status).toBe('uncertain')
    const commitCount = backend.commitCount

    const exactReplay = await controller.dispatch(input)
    expect(exactReplay.status).toBe('uncertain')
    expect(backend.commitCount).toBe(commitCount)

    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const changedReplay = await controller.dispatch({
      actionId: 'after-transfer', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })
    expect(changedReplay.status).toBe('blocked')
    expect(changedReplay.reason).toBe('action-id-conflict')
    expect(backend.commitCount).toBe(commitCount)
  })

  it('invalidates the observation after an uncertain transfer so a new action cannot reuse it', async () => {
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    backend.throwAfterTransfer = new Error('transport lost')
    const uncertain = await controller.dispatch({
      actionId: 'uncertain-invalidates', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })
    expect(uncertain.status).toBe('uncertain')
    expect(controller.getBinding()).toMatchObject({ reconciliationRequired: true })
    const commits = backend.commitCount
    backend.throwAfterTransfer = null

    const staleRefWait = await controller.dispatch({
      actionId: 'old-ref-after-uncertain', browserTaskId: 'bt-1', runId: 'run-1', action: 'wait_for',
      waitFor: { elementRef: obs.elements[0]!.elementRef, text: 'Temporary canary' }, timeoutMs: 0,
    })
    expect(staleRefWait.status).toBe('blocked')
    expect(staleRefWait.reason).toBe('stale-observation')
    expect(storage.getAction('old-ref-after-uncertain')).toBeNull()

    const retryWithNewId = await controller.dispatch({
      actionId: 'new-id-old-observation', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })
    expect(retryWithNewId.status).toBe('blocked')
    expect(retryWithNewId.reason).toBe('uncertain-reconciliation-required')
    expect(backend.commitCount).toBe(commits)
  })

  it('keeps an uncertain binding poisoned across diagnostic observe until explicit owner acknowledgement', async () => {
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    backend.throwAfterTransfer = new Error('transport lost')
    const uncertain = await controller.dispatch({
      actionId: 'poison-source', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })
    expect(uncertain.status).toBe('uncertain')
    backend.throwAfterTransfer = null

    const diagnostic = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const commits = backend.commitCount
    const blocked = await controller.dispatch({
      actionId: 'poisoned-new-id', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: diagnostic.observationId, elementRef: diagnostic.elements[0]!.elementRef,
    })
    expect(blocked.status).toBe('blocked')
    expect(blocked.reason).toBe('uncertain-reconciliation-required')
    expect(backend.commitCount).toBe(commits)
    expect(controller.getBinding()).toMatchObject({
      reconciliationRequired: true,
      reconciliationAcknowledgementAvailable: true,
    })

    const ackStorage = vi.spyOn(storage, 'acknowledgeComputerEffect')
    const probesBeforeAck = backend.probeCount
    const acknowledged = await acknowledgeUncertain()
    expect(backend.probeCount).toBe(probesBeforeAck + 1)
    expect(ackStorage).toHaveBeenCalledWith('poison-source')
    expect(acknowledged).toBe(true)
    expect(await acknowledgeUncertain()).toBe(false)
    expect(controller.getBinding()).toMatchObject({ reconciliationRequired: false })
    const staleAfterAck = await controller.dispatch({
      actionId: 'ack-needs-fresh-observe', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: diagnostic.observationId, elementRef: diagnostic.elements[0]!.elementRef,
    })
    expect(staleAfterAck.reason).toBe('binding-not-authorized')

    expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-1' }).ok).toBe(true)
    const fresh = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const restored = await controller.dispatch({
      actionId: 'after-explicit-ack', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: fresh.observationId, elementRef: fresh.elements[0]!.elementRef,
    })
    expect(restored.status).toBe('verified')
    expect(backend.commitCount).toBe(commits + 1)
    expect(storage.getAction('poison-source')?.status).toBe('uncertain')
    expect(storage.actionEvents('poison-source').some(event => (
      event.reason === 'computer_uncertain_owner_acknowledged'
    ))).toBe(true)
  })

  it('does not let a confirmation prepared for one binding generation acknowledge after rebind', async () => {
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    backend.throwAfterTransfer = new Error('transport lost')
    await expect(controller.dispatch({
      actionId: 'prepared-before-rebind', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })).resolves.toMatchObject({ status: 'uncertain' })
    backend.throwAfterTransfer = null

    const prepared = controller.prepareUncertainAcknowledgement()
    expect(prepared).toMatchObject({ challenge: expect.any(String), bindingGeneration: 1 })

    const [candidate] = await controller.listCandidates()
    await expect(controller.bindCandidate(candidate!.candidateId)).resolves.toMatchObject({
      ok: true,
      bindingGeneration: 2,
    })

    expect(await controller.acknowledgePreparedUncertain(prepared!.challenge)).toBe(false)
    expect(storage.actionEvents('prepared-before-rebind').some(event => (
      event.reason === 'computer_uncertain_owner_acknowledged'
    ))).toBe(false)
  })

  it('expires a prepared confirmation without writing a durable acknowledgement', async () => {
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    backend.throwAfterTransfer = new Error('transport lost')
    await controller.dispatch({
      actionId: 'expired-confirmation', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const prepared = controller.prepareUncertainAcknowledgement()
      expect(prepared).not.toBeNull()
      clock.mockReturnValue(61_001)
      expect(await controller.acknowledgePreparedUncertain(prepared!.challenge)).toBe(false)
      expect(storage.actionEvents('expired-confirmation').some(event => (
        event.reason === 'computer_uncertain_owner_acknowledged'
      ))).toBe(false)
    } finally {
      clock.mockRestore()
    }
  })

  it('rejects a prepared confirmation while a desktop attempt is active', async () => {
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    backend.throwAfterTransfer = new Error('transport lost')
    await controller.dispatch({
      actionId: 'active-confirmation', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })
    backend.throwAfterTransfer = null
    const prepared = controller.prepareUncertainAcknowledgement()
    expect(prepared).not.toBeNull()
    const observationGate = deferred()
    backend.observeBarrier = observationGate
    const observesBefore = backend.observeCount
    const diagnostic = controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    await vi.waitFor(() => expect(backend.observeCount).toBeGreaterThan(observesBefore))
    try {
      expect(await controller.acknowledgePreparedUncertain(prepared!.challenge)).toBe(false)
      expect(storage.actionEvents('active-confirmation').some(event => (
        event.reason === 'computer_uncertain_owner_acknowledged'
      ))).toBe(false)
    } finally {
      observationGate.resolve()
      await diagnostic
    }
  })

  it('fails closed when the durable acknowledgement append throws', async () => {
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    backend.throwAfterTransfer = new Error('transport lost')
    await controller.dispatch({
      actionId: 'ack-write-failure', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })
    backend.throwAfterTransfer = null
    const prepared = controller.prepareUncertainAcknowledgement()
    vi.spyOn(storage, 'acknowledgeComputerEffect').mockImplementationOnce(() => {
      throw new Error('database locked')
    })

    expect(await controller.acknowledgePreparedUncertain(prepared!.challenge)).toBe(false)
    expect(storage.actionEvents('ack-write-failure').some(event => (
      event.reason === 'computer_uncertain_owner_acknowledged'
    ))).toBe(false)
    expect(controller.getBinding()).toMatchObject({ reconciliationRequired: true })
  })

  it('keeps a helper-crash-after-transfer poison across restart and a new chat until one explicit owner acknowledgement', async () => {
    storage.create({ browserTaskId: 'bt-2', projectPath: '/p', runId: 'run-2' })
    storage.appendRun({ browserTaskId: 'bt-2', runId: 'run-2' })
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const commitGate = deferred()
    backend.commitBarrier = commitGate
    const pending = controller.dispatch({
      actionId: 'crash-after-transfer', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })
    await vi.waitFor(() => expect(backend.commitCount).toBe(1))
    backend.emit({ type: 'helper-crashed' })
    commitGate.resolve()
    await expect(pending).resolves.toMatchObject({ status: 'uncertain', reason: 'helper-crashed' })
    expect(storage.getAction('crash-after-transfer')?.status).toBe('uncertain')

    await controller.shutdown()
    backend = new FakeComputerBackend()
    controller = createComputerController({ storage, backend })
    const [candidate] = await controller.listCandidates()
    await expect(controller.bindCandidate(candidate!.candidateId)).resolves.toMatchObject({ ok: true })

    expect(controller.authorizeRun({ browserTaskId: 'bt-2', runId: 'run-2' }))
      .toEqual({ ok: false, error: 'uncertain-reconciliation-required' })
    expect(controller.getBinding()).toMatchObject({ reconciliationRequired: true })
    expect(controller.getBinding()).toMatchObject({ reconciliationAcknowledgementAvailable: true })
    expect(backend.commitCount).toBe(0)

    expect(await acknowledgeUncertain()).toBe(true)
    expect(storage.getAction('crash-after-transfer')?.status).toBe('uncertain')
    expect(controller.authorizeRun({ browserTaskId: 'bt-2', runId: 'run-2' }).ok).toBe(true)
    const fresh = await controller.observe({ browserTaskId: 'bt-2', runId: 'run-2' })
    await expect(controller.dispatch({
      actionId: 'after-restart-owner-ack', browserTaskId: 'bt-2', runId: 'run-2', action: 'click',
      observationId: fresh.observationId, elementRef: fresh.elements[0]!.elementRef,
    })).resolves.toMatchObject({ status: 'verified' })

    await controller.shutdown()
    backend = new FakeComputerBackend()
    controller = createComputerController({ storage, backend })
    const [afterAckCandidate] = await controller.listCandidates()
    await controller.bindCandidate(afterAckCandidate!.candidateId)
    expect(controller.authorizeRun({ browserTaskId: 'bt-2', runId: 'run-2' }).ok).toBe(true)
  })

  it('blocks an effect when a durable unresolved row appears after authorization and before dispatch', async () => {
    const targetFingerprint = controller.getBinding()!.targetFingerprint
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    storage.create({ browserTaskId: 'other-chat', projectPath: '/p', runId: 'other-run' })
    storage.appendRun({ browserTaskId: 'other-chat', runId: 'other-run' })
    storage.proposeAction({
      actionId: 'late-durable-poison', browserTaskId: 'other-chat', runId: 'other-run',
      actionType: 'computer:key', riskLevel: 'R1', scope: { targetFingerprint },
    })
    storage.startExecute('late-durable-poison', 'attempt-before-crash-reconcile')
    const commits = backend.commitCount

    const blocked = await controller.dispatch({
      actionId: 'must-not-be-proposed', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })
    expect(blocked).toMatchObject({ status: 'blocked', reason: 'uncertain-reconciliation-required' })
    expect(storage.getAction('must-not-be-proposed')).toBeNull()
    expect(storage.getAction('late-durable-poison')?.status).toBe('executing')
    expect(backend.commitCount).toBe(commits)
    expect(await acknowledgeUncertain()).toBe(false)
  })

  it('fails closed when the durable unresolved lookup is unavailable and recovers only after a fresh lookup', async () => {
    await controller.stop()
    const lookup = vi.spyOn(storage, 'findUnacknowledgedComputerEffect')
      .mockImplementation(() => { throw new Error('database locked') })

    expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-1' }))
      .toEqual({ ok: false, error: 'uncertain-reconciliation-required' })
    expect(controller.getBinding()).toMatchObject({ reconciliationRequired: true })
    expect(await acknowledgeUncertain()).toBe(false)

    lookup.mockRestore()
    expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-1' }).ok).toBe(true)
    expect(controller.getBinding()).toMatchObject({ reconciliationRequired: false })
  })

  it('does not acknowledge target A while the selected window and native confirmation refer to target B', async () => {
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    backend.throwAfterTransfer = new Error('transport lost')
    await expect(controller.dispatch({
      actionId: 'target-a-poison', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })).resolves.toMatchObject({ status: 'uncertain' })

    await controller.shutdown()
    backend = new FakeComputerBackend()
    const targetB = {
      pid: 5252,
      processStartTime100ns: '144800000000000000',
      hwnd: '0x0000000000052525',
    }
    backend.candidates[0]!.identity = { ...targetB }
    backend.probe.identity = { ...targetB }
    controller = createComputerController({ storage, backend })
    const [candidateB] = await controller.listCandidates()
    await controller.bindCandidate(candidateB!.candidateId)

    expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-1' }))
      .toEqual({ ok: false, error: 'uncertain-reconciliation-required' })
    expect(controller.getBinding()).toMatchObject({
      reconciliationRequired: true,
      reconciliationAcknowledgementAvailable: false,
    })
    expect(await acknowledgeUncertain()).toBe(false)
    expect(storage.actionEvents('target-a-poison').some(event => (
      event.reason === 'computer_uncertain_owner_acknowledged'
    ))).toBe(false)

    storage.create({ browserTaskId: 'target-b-chat', projectPath: '/p', runId: 'target-b-run' })
    storage.appendRun({ browserTaskId: 'target-b-chat', runId: 'target-b-run' })
    expect(controller.authorizeRun({ browserTaskId: 'target-b-chat', runId: 'target-b-run' }).ok).toBe(true)
  })

  it('does not acknowledge an uncertain effect after the same native window identity shows another document title', async () => {
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    backend.throwAfterTransfer = new Error('transport lost')
    await expect(controller.dispatch({
      actionId: 'same-hwnd-other-document', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })).resolves.toMatchObject({ status: 'uncertain' })

    await controller.shutdown()
    backend = new FakeComputerBackend()
    backend.candidates[0]!.title = 'Personal.xlsx'
    backend.candidates[0]!.titleFingerprint = 'd'.repeat(64)
    backend.probe.title = 'Personal.xlsx'
    backend.probe.titleFingerprint = 'd'.repeat(64)
    controller = createComputerController({ storage, backend })
    const [sameWindowOtherDocument] = await controller.listCandidates()
    await controller.bindCandidate(sameWindowOtherDocument!.candidateId)

    expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-1' }))
      .toEqual({ ok: false, error: 'uncertain-reconciliation-required' })
    expect(controller.getBinding()).toMatchObject({
      reconciliationRequired: true,
      reconciliationAcknowledgementAvailable: false,
    })
    expect(controller.prepareUncertainAcknowledgement()).toBeNull()
    expect(storage.actionEvents('same-hwnd-other-document').some(event => (
      event.reason === 'computer_uncertain_owner_acknowledged'
    ))).toBe(false)
  })

  it('invalidates a prepared native acknowledgement when the full title changes while the dialog is open', async () => {
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    backend.throwAfterTransfer = new Error('transport lost')
    await expect(controller.dispatch({
      actionId: 'title-changed-during-dialog', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })).resolves.toMatchObject({ status: 'uncertain' })

    const prepared = controller.prepareUncertainAcknowledgement()
    expect(prepared).not.toBeNull()
    backend.probe.title = 'Another document with the same HWND'
    backend.probe.titleFingerprint = 'e'.repeat(64)

    await expect(controller.acknowledgePreparedUncertain(prepared!.challenge)).resolves.toBe(false)
    expect(storage.actionEvents('title-changed-during-dialog').some(event => (
      event.reason === 'computer_uncertain_owner_acknowledged'
    ))).toBe(false)
    expect(controller.getBinding()).toMatchObject({ reconciliationRequired: true })
  })

  it('does not let a new run of the same task adopt an uncertain binding', async () => {
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    backend.throwAfterTransfer = new Error('transport lost')
    expect((await controller.dispatch({
      actionId: 'uncertain-before-handoff', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })).status).toBe('uncertain')
    storage.appendRun({ browserTaskId: 'bt-1', runId: 'run-next' })

    expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-next' }))
      .toEqual({ ok: false, error: 'uncertain-reconciliation-required' })
  })

  it('coalesces concurrent calls with the same actionId into one commit', async () => {
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const input = {
      actionId: 'coalesced', browserTaskId: 'bt-1', runId: 'run-1', action: 'click' as const,
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    }
    const [first, second] = await Promise.all([controller.dispatch(input), controller.dispatch(input)])
    expect(first.status).toBe('verified')
    expect(second).toEqual(first)
    expect(backend.commitCount).toBe(1)
  })

  it('blocks a reused in-memory actionId when the exact semantic payload changes', async () => {
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const input = {
      actionId: 'same-id-different-private-text', browserTaskId: 'bt-1', runId: 'run-1', action: 'type' as const,
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
      text: 'private-A',
    }
    expect((await controller.dispatch(input)).status).toBe('verified')
    const commits = backend.commitCount

    const conflict = await controller.dispatch({ ...input, text: 'private-B' })
    expect(conflict.status).toBe('blocked')
    expect(conflict.reason).toBe('action-id-conflict')
    expect(backend.commitCount).toBe(commits)
  })

  it('allows only exact non-secret durable replay and fails closed for typed text after restart', async () => {
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const clickInput = {
      actionId: 'durable-exact-click', browserTaskId: 'bt-1', runId: 'run-1', action: 'click' as const,
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    }
    expect((await controller.dispatch(clickInput)).status).toBe('verified')

    const nextObs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const typeInput = {
      actionId: 'durable-private-type', browserTaskId: 'bt-1', runId: 'run-1', action: 'type' as const,
      observationId: nextObs.observationId, elementRef: nextObs.elements[0]!.elementRef,
      text: 'private-value',
    }
    expect((await controller.dispatch(typeInput)).status).toBe('verified')

    await controller.shutdown()
    backend = new FakeComputerBackend()
    controller = createComputerController({ storage, backend })
    const [restartCandidate] = await controller.listCandidates()
    await expect(controller.bindCandidate(restartCandidate!.candidateId)).resolves.toMatchObject({ ok: true })

    expect(await controller.dispatch({ ...clickInput, elementRef: 'different-element' })).toMatchObject({
      status: 'blocked',
      reason: 'action-id-conflict',
    })
    expect(await controller.dispatch(clickInput)).toMatchObject({
      actionId: clickInput.actionId,
      status: 'verified',
    })
    expect(await controller.dispatch(typeInput)).toMatchObject({
      status: 'blocked',
      reason: 'action-id-conflict',
    })
    expect(backend.commitCount).toBe(0)
  })

  it.each([
    ['readback mismatch', (fake: FakeComputerBackend) => { fake.readbackMatched = false }],
    ['readback transport loss', (fake: FakeComputerBackend) => { fake.failObserveAfterCommit = new Error('readback lost') }],
  ])('%s after commit is uncertain', async (_name, setup) => {
    setup(backend)
    const result = await click(`readback-${_name}`)
    expect(result.status).toBe('uncertain')
    expect(storage.getAction(`readback-${_name}`)?.status).toBe('uncertain')
  })

  it('treats target survival without a proven semantic effect as uncertain and invalidates the snapshot', async () => {
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    backend.effectMatched = false
    const noOp = await controller.dispatch({
      actionId: 'semantic-no-op', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })
    expect(noOp.status).toBe('uncertain')
    expect(noOp.reason).toBe('effect-not-proven')
    expect(storage.getAction('semantic-no-op')?.status).toBe('uncertain')
    const commits = backend.commitCount

    backend.effectMatched = true
    const next = await controller.dispatch({
      actionId: 'semantic-no-op-new-id', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
    })
    expect(next.status).toBe('blocked')
    expect(next.reason).toBe('uncertain-reconciliation-required')
    expect(backend.commitCount).toBe(commits)
  })

  it('never verifies an effect claim when the exact dispatch was not accepted', async () => {
    backend.dispatchAccepted = false
    backend.effectMatched = true
    const result = await click('dispatch-not-accepted')
    expect(result.status).toBe('uncertain')
    expect(result.reason).toBe('dispatch-not-accepted')
    expect(storage.getAction('dispatch-not-accepted')?.status).toBe('uncertain')
  })

  it('treats hardware-input epoch drift detected only by post-readback as uncertain', async () => {
    const originalCommit = backend.commitAction.bind(backend)
    backend.commitAction = async (prepared, options) => {
      const value = await originalCommit(prepared, options)
      backend.probe.userInputEpoch += 1
      return value
    }
    const result = await click('post-input-drift')
    expect(result.status).toBe('uncertain')
    expect(result.reason).toBe('hardware-input')
    expect(storage.getAction('post-input-drift')?.status).toBe('uncertain')
  })
})
