import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
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
let clock: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'computer-identity-'))
  db = openDb(join(dir, 'test.db'))
  storage = createBrowserTasks(db)
  storage.create({ browserTaskId: 'bt-1', projectPath: '/p', runId: 'run-1' })
  storage.appendRun({ browserTaskId: 'bt-1', runId: 'run-1' })
  storage.create({ browserTaskId: 'bt-2', projectPath: '/p', runId: 'run-2' })
  storage.appendRun({ browserTaskId: 'bt-2', runId: 'run-2' })
  backend = new FakeComputerBackend()
  clock = 1_000
  controller = createComputerController({ storage, backend, now: () => clock })
})

afterEach(async () => {
  backend.stopBarrier?.resolve()
  await controller.shutdown()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function bindAndObserve() {
  const candidates = await controller.listCandidates()
  expect(candidates).toHaveLength(1)
  expect(candidates[0]).toEqual({
    candidateId: expect.stringMatching(/^wc-[0-9a-f-]{36}$/i),
    processName: 'notepad.exe',
    title: 'Temporary canary',
  })
  const binding = await controller.bindCandidate(candidates[0]!.candidateId)
  expect(binding.ok).toBe(true)
  expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-1' })).toMatchObject({ ok: true })
  return controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
}

function fullTitleFingerprint(title: string): string {
  const normalized = title.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  return createHash('sha256').update(`window-title|${normalized}`, 'utf8').digest('hex')
}

describe('ComputerController — exact Windows identity', () => {
  it('requires an explicit run authorization before the first observe', async () => {
    const candidates = await controller.listCandidates()
    await controller.bindCandidate(candidates[0]!.candidateId)
    expect(controller.getBinding()).toMatchObject({
      processName: 'notepad.exe',
      title: 'Temporary canary',
      expiresAt: null,
      reconciliationRequired: false,
    })
    const callsBefore = backend.observeCount

    await expect(controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' }))
      .rejects.toMatchObject({ code: 'binding-not-authorized' })
    expect(backend.observeCount).toBe(callsBefore)
    expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-1' })).toMatchObject({
      ok: true,
      expiresAt: 301_000,
    })
    expect(controller.getBinding()).toMatchObject({
      expiresAt: 301_000,
      reconciliationRequired: false,
    })
  })

  it('binds only an opaque listed candidate and keeps PID/HWND in main memory', async () => {
    const observation = await bindAndObserve()
    expect(observation.bindingGeneration).toBe(1)
    expect(observation.targetFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(observation)).not.toContain('4242')
    expect(JSON.stringify(observation)).not.toContain('0x0000000000012345')
  })

  it('binds the exact normalized current title and rejects a different document in the same HWND', async () => {
    backend.candidates[0]!.title = '  Temporary\r\n   canary  '
    backend.probe.title = 'Temporary canary'
    const [sameDocument] = await controller.listCandidates()
    await expect(controller.bindCandidate(sameDocument!.candidateId)).resolves.toMatchObject({
      ok: true,
      title: 'Temporary canary',
    })

    await controller.unbind()
    backend.candidates[0]!.title = 'Budget Q3.xlsx'
    backend.probe.title = 'Payroll.xlsx'
    const [differentDocument] = await controller.listCandidates()
    await expect(controller.bindCandidate(differentDocument!.candidateId)).resolves.toEqual({
      ok: false,
      error: 'target-title-changed',
    })
  })

  it('rejects different full titles that share the same first 300 display characters', async () => {
    const displayPrefix = 'A'.repeat(300)
    const listedFullTitle = `${displayPrefix} Budget.xlsx`
    const currentFullTitle = `${displayPrefix} Payroll.xlsx`
    Object.assign(backend.candidates[0]!, {
      title: displayPrefix,
      titleFingerprint: fullTitleFingerprint(listedFullTitle),
    })
    Object.assign(backend.probe, {
      title: displayPrefix,
      titleFingerprint: fullTitleFingerprint(currentFullTitle),
    })

    const [candidate] = await controller.listCandidates()
    await expect(controller.bindCandidate(candidate!.candidateId)).resolves.toEqual({
      ok: false,
      error: 'target-title-changed',
    })
  })

  it('rejects observe when the selected HWND now shows another title', async () => {
    const [candidate] = await controller.listCandidates()
    await controller.bindCandidate(candidate!.candidateId)
    expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-1' })).toMatchObject({ ok: true })
    backend.probe.title = 'Another document - Notepad'

    await expect(controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' }))
      .rejects.toMatchObject({ code: 'target-title-changed' })
  })

  it('rejects a destroyed listed lease and binds reused HWND only through a fresh helper token', async () => {
    const helperLeases = new Map<string, string>()
    let leaseNumber = 0
    backend.listCandidates = async () => backend.candidates.map(candidate => {
      const candidateToken = `helper-lease-${++leaseNumber}`
      helperLeases.set(candidateToken, candidate.identity.processStartTime100ns)
      return { ...candidate, identity: { ...candidate.identity }, candidateToken }
    })
    backend.probeBinding = async (identity, candidateToken?: string) => {
      const issuedStart = candidateToken ? helperLeases.get(candidateToken) : undefined
      if (!candidateToken || !issuedStart || issuedStart !== identity.processStartTime100ns) {
        throw new Error('stale helper candidate lease')
      }
      helperLeases.delete(candidateToken)
      return { ...backend.probe, identity: { ...backend.probe.identity }, geometry: { ...backend.probe.geometry } }
    }

    const [staleCandidate] = await controller.listCandidates()
    expect(JSON.stringify(staleCandidate)).not.toContain('helper-lease-1')

    // EVENT_OBJECT_DESTROY invalidates the old helper-side lease. The same
    // process may then recreate the same numeric HWND, leaving the tuple equal.
    helperLeases.clear()
    await expect(controller.bindCandidate(staleCandidate!.candidateId))
      .resolves.toEqual({ ok: false, error: 'target-destroyed' })

    const [freshCandidate] = await controller.listCandidates()
    expect(JSON.stringify(freshCandidate)).not.toContain('helper-lease-2')
    await expect(controller.bindCandidate(freshCandidate!.candidateId))
      .resolves.toMatchObject({ ok: true })
    expect(helperLeases.size).toBe(0)
  })

  it('keeps a listed candidate bindable when an unrelated HWND is destroyed', async () => {
    const [candidate] = await controller.listCandidates()
    backend.invalidateCandidateLeases('0x0000000000099999')

    await expect(controller.bindCandidate(candidate!.candidateId))
      .resolves.toMatchObject({ ok: true })
  })

  it('rejects a listed candidate when that exact HWND is destroyed before bind', async () => {
    const [candidate] = await controller.listCandidates()
    backend.invalidateCandidateLeases(backend.candidates[0]!.identity.hwnd)

    await expect(controller.bindCandidate(candidate!.candidateId))
      .resolves.toEqual({ ok: false, error: 'target-destroyed' })
  })

  it('unbind invalidates the capability and all observation refs', async () => {
    const observation = await bindAndObserve()
    await controller.unbind()
    expect(controller.getBinding()).toBeNull()
    const result = await controller.dispatch({
      actionId: 'after-unbind', browserTaskId: 'bt-1', runId: 'run-1', action: 'click',
      observationId: observation.observationId, elementRef: observation.elements[0]!.elementRef,
    })
    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('no-binding')
    expect(backend.commitCount).toBe(0)
  })

  it('revokes the capability synchronously but does not acknowledge unbind before backend Stop', async () => {
    await bindAndObserve()
    backend.stopBarrier = deferred()
    let settled = false
    const revoked = controller.unbind().then(() => { settled = true })
    expect(controller.getBinding()).toBeNull()
    await Promise.resolve()
    expect(backend.stopCount).toBe(1)
    expect(settled).toBe(false)

    backend.stopBarrier.resolve()
    await revoked
    expect(settled).toBe(true)
  })

  it('blocks a recreated process even when PID, HWND, title and geometry were reused', async () => {
    const observation = await bindAndObserve()
    const elementRef = observation.elements[0]!.elementRef
    backend.probe.identity.processStartTime100ns = '133700000000000999'

    const result = await controller.dispatch({
      actionId: 'identity-reuse', browserTaskId: 'bt-1', runId: 'run-1',
      action: 'click', observationId: observation.observationId, elementRef,
    })

    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('target-identity-changed')
    expect(backend.prepareCount).toBe(0)
    expect(backend.commitCount).toBe(0)
    expect(storage.getAction('identity-reuse')?.status).toBe('blocked')
  })

  it('authorizes one task/run and blocks another task from stealing the claim before backend access', async () => {
    const candidates = await controller.listCandidates()
    await controller.bindCandidate(candidates[0]!.candidateId)
    expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-1' })).toMatchObject({ ok: true })
    await expect(controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' }))
      .resolves.toMatchObject({ browserTaskId: 'bt-1', runId: 'run-1' })
    expect(controller.authorizeRun({ browserTaskId: 'bt-2', runId: 'run-2' }))
      .toEqual({ ok: false, error: 'binding-owner-mismatch' })
    await expect(controller.observe({ browserTaskId: 'bt-2', runId: 'run-2' }))
      .rejects.toMatchObject({ code: 'binding-owner-mismatch' })
    expect(backend.observeCount).toBe(1)
  })

  it('lets a new run of the same task adopt the claim only through explicit authorization', async () => {
    await bindAndObserve()
    storage.appendRun({ browserTaskId: 'bt-1', runId: 'run-next' })
    const callsBefore = backend.observeCount

    await expect(controller.observe({ browserTaskId: 'bt-1', runId: 'run-next' }))
      .rejects.toMatchObject({ code: 'binding-owner-mismatch' })
    expect(backend.observeCount).toBe(callsBefore)
    expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-next' }))
      .toMatchObject({ ok: true })
    await expect(controller.observe({ browserTaskId: 'bt-1', runId: 'run-next' }))
      .resolves.toMatchObject({ browserTaskId: 'bt-1', runId: 'run-next' })
    expect(backend.observeCount).toBe(callsBefore + 1)
  })

  it('does not transfer a claim while the old task has an executing ledger row', async () => {
    await bindAndObserve()
    storage.proposeAction({
      actionId: 'still-executing', browserTaskId: 'bt-1', runId: 'run-1',
      actionType: 'computer:click', riskLevel: 'R1', scope: {}, payload: {}, preconditions: {},
    })
    storage.startExecute('still-executing', 'attempt-still-executing')
    storage.appendRun({ browserTaskId: 'bt-1', runId: 'run-next' })

    expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-next' }))
      .toEqual({ ok: false, error: 'uncertain-reconciliation-required' })
  })

  it('rebind clears authorization and requires a new explicit grant', async () => {
    await bindAndObserve()
    const [candidate] = await controller.listCandidates()
    await controller.bindCandidate(candidate!.candidateId)
    const callsBefore = backend.observeCount

    await expect(controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' }))
      .rejects.toMatchObject({ code: 'binding-not-authorized' })
    expect(backend.observeCount).toBe(callsBefore)
  })

  it('drops stale binding state when the helper generation is lost and requires a fresh list/rebind', async () => {
    await bindAndObserve()

    backend.emit({ type: 'helper-crashed' })
    expect(controller.getBinding()).toBeNull()
    await expect(controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' }))
      .rejects.toMatchObject({ code: 'no-binding' })

    const [freshCandidate] = await controller.listCandidates()
    await expect(controller.bindCandidate(freshCandidate!.candidateId)).resolves.toMatchObject({ ok: true })
    expect(controller.authorizeRun({ browserTaskId: 'bt-1', runId: 'run-1' })).toMatchObject({ ok: true })
    await expect(controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' }))
      .resolves.toMatchObject({ browserTaskId: 'bt-1', runId: 'run-1' })
  })

  it('expires the fixed five-minute claim fail-closed and invalidates the binding', async () => {
    await bindAndObserve()
    const callsBefore = backend.observeCount
    clock += 5 * 60_000

    await expect(controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' }))
      .rejects.toMatchObject({ code: 'binding-expired' })
    expect(controller.getBinding()).toBeNull()
    expect(backend.observeCount).toBe(callsBefore)
  })
})
