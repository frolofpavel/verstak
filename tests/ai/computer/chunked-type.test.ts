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
  dir = mkdtempSync(join(tmpdir(), 'computer-type-'))
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

describe('ComputerController — bounded chunked type', () => {
  it('runs 17+ scalars as backend-enforced UIA chunks and verifies the private final value state', async () => {
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const text = '0123456789abcdefZ'
    const result = await controller.dispatch({
      actionId: 'production-uia-long-type', browserTaskId: 'bt-1', runId: 'run-1', action: 'type',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
      text,
    })

    expect(result.status).toBe('verified')
    expect(backend.lastPrepared).toMatchObject({
      method: 'uia', chunkGuards: 'backend-enforced', targetCheckIntervalMs: 50,
      expectedAfterValueState: { fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), scalarLength: 17 },
    })
    expect(backend.committedChunkLengths).toEqual([16, 1])
    expect(JSON.stringify(result)).not.toContain(backend.lastPrepared?.expectedAfterValueState?.fingerprint)

    const forgedReplay = await controller.dispatch({
      actionId: 'production-uia-long-type', browserTaskId: 'bt-1', runId: 'run-1', action: 'type',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
      text, clearFirst: false,
    })
    expect(forgedReplay).toMatchObject({ status: 'blocked', reason: 'invalid-action' })
  })

  it.each([
    {
      label: 'clearFirst',
      input: { text: 'replacement', clearFirst: true },
    },
    {
      label: 'clearFirst false',
      input: { text: 'append', clearFirst: false },
    },
    {
      label: 'empty text',
      input: { text: '' },
    },
  ])('rejects model-controlled $label before helper prepare', async ({ label, input }) => {
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const result = await controller.dispatch({
      actionId: `type-invalid-${label.replace(/\s+/gu, '-')}`,
      browserTaskId: 'bt-1',
      runId: 'run-1',
      action: 'type',
      observationId: obs.observationId,
      elementRef: obs.elements[0]!.elementRef,
      ...input,
    })

    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('invalid-action')
    expect(backend.prepareCount).toBe(0)
    expect(backend.commitCount).toBe(0)
  })

  it('chunks by Unicode code points <=16 and never persists raw text', async () => {
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const text = 'abcdefghijklmnop🙂qrstuvwxyz'
    backend.observation.text = text
    backend.observation.screenshotDataUrl = 'data:image/png;base64,typed-secret'
    const result = await controller.dispatch({
      actionId: 'type-safe', browserTaskId: 'bt-1', runId: 'run-1', action: 'type',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
      text,
    })
    expect(result.status).toBe('verified')
    expect(backend.committedChunkLengths.length).toBeGreaterThan(1)
    expect(Math.max(...backend.committedChunkLengths)).toBeLessThanOrEqual(16)
    expect(backend.lastPrepared?.targetCheckIntervalMs).toBe(50)
    const row = storage.getAction('type-safe')!
    expect(row.payload).toEqual({
      elementRef: obs.elements[0]!.elementRef,
      textLength: Array.from(text).length,
      clearFirst: false,
    })
    expect(row.payload).not.toHaveProperty('textDigest')
    expect(JSON.stringify(row)).not.toContain(text)
    expect(JSON.stringify(storage.actionEvents('type-safe'))).not.toContain(text)
    expect(JSON.stringify(result)).not.toContain(text)
    expect(result.observation?.text).toBe('')
    expect(result.observation?.screenshotDataUrl).toBeNull()
    expect(result.observation?.omissions).toContain('typed-content-omitted')
  })

  it('rechecks exact target before every chunk and stops after drift', async () => {
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    backend.mutateAfterChunk = index => {
      if (index === 0) backend.probe.geometry.left += 10
    }
    const result = await controller.dispatch({
      actionId: 'type-drift', browserTaskId: 'bt-1', runId: 'run-1', action: 'type',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
      text: '0123456789abcdefSECOND-CHUNK',
    })
    expect(result.status).toBe('uncertain')
    expect(result.reason).toBe('stale-geometry')
    expect(backend.committedChunkLengths).toEqual([16])
    expect(storage.getAction('type-drift')?.status).toBe('uncertain')
  })

  it('accepts backend-enforced guards only with the <=50ms target metadata', async () => {
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    backend.forceChunkGuards = 'backend-enforced'
    let result = await controller.dispatch({
      actionId: 'backend-guarded', browserTaskId: 'bt-1', runId: 'run-1', action: 'type',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
      text: '0123456789abcdefSECOND-CHUNK',
    })
    expect(result.status).toBe('verified')

    const fresh = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    const originalPrepare = backend.prepareAction.bind(backend)
    backend.prepareAction = async request => ({
      ...(await originalPrepare(request)),
      chunkGuards: 'backend-enforced',
      targetCheckIntervalMs: 51,
    })
    result = await controller.dispatch({
      actionId: 'backend-guard-too-slow', browserTaskId: 'bt-1', runId: 'run-1', action: 'type',
      observationId: fresh.observationId, elementRef: fresh.elements[0]!.elementRef,
      text: '0123456789abcdefSECOND-CHUNK',
    })
    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('invalid-action')
  })

  it('blocks a long type when the backend proposes global SendInput instead of UIA', async () => {
    const obs = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })
    backend.forceMethod = 'send-input'
    const result = await controller.dispatch({
      actionId: 'production-long-type-blocked', browserTaskId: 'bt-1', runId: 'run-1', action: 'type',
      observationId: obs.observationId, elementRef: obs.elements[0]!.elementRef,
      text: '0123456789abcdefSECOND-CHUNK',
    })

    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('uia-priority-violated')
    expect(backend.prepareCount).toBe(1)
    expect(backend.commitCount).toBe(0)
  })

  it('persists only Unicode length for wait text, without a dictionary fingerprint', async () => {
    const secret = '123456 secret phrase'
    backend.observation.text = secret
    const result = await controller.dispatch({
      actionId: 'wait-secret', browserTaskId: 'bt-1', runId: 'run-1', action: 'wait_for',
      waitFor: { text: secret }, timeoutMs: 100,
    })
    expect(result.status).toBe('verified')
    const row = storage.getAction('wait-secret')!
    expect(row.payload).toEqual({ elementRef: null, textLength: Array.from(secret).length })
    expect(JSON.stringify(row)).not.toContain(secret)
  })

  it('matches wait_for elementRef by stable UIA semantics when helper refs rotate per observation', async () => {
    const initial = await controller.observe({ browserTaskId: 'bt-1', runId: 'run-1' })

    const result = await controller.dispatch({
      actionId: 'wait-stable-element', browserTaskId: 'bt-1', runId: 'run-1', action: 'wait_for',
      waitFor: { elementRef: initial.elements[0]!.elementRef, text: 'Temporary canary' }, timeoutMs: 0,
    })

    expect(result.status).toBe('verified')
    expect(result.observation?.elements).toHaveLength(1)
    expect(backend.observeCount).toBeGreaterThanOrEqual(2)
  })

  it.each([undefined, '', '   '])('fails closed when wait_for has no concrete non-empty condition: %j', async text => {
    const result = await controller.dispatch({
      actionId: `wait-empty-${text?.length ?? 'missing'}`,
      browserTaskId: 'bt-1',
      runId: 'run-1',
      action: 'wait_for',
      waitFor: text === undefined ? {} : { text },
      timeoutMs: 0,
    })

    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('invalid-action')
  })
})
