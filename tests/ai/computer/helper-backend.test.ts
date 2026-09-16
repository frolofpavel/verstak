import { describe, expect, it, vi } from 'vitest'

import { createComputerHelperBackend } from '../../../electron/ai/computer/helper-backend'
import type { ComputerPrepareRequest } from '../../../electron/ai/computer/types'

const identity = { pid: 42, processStartTime100ns: '133700', hwnd: '9001' }

describe('Computer helper → controller backend adapter', () => {
  it('keeps the fresh helper candidate token through the private backend boundary', async () => {
    const candidateToken = `candidate-lease:${'a'.repeat(24)}`
    const probeBinding = vi.fn(async () => ({ identity }))
    const client = {
      listCandidates: vi.fn(async () => [{
        candidateToken, identity, processName: 'notepad', title: 'fresh',
        productName: 'Windows Notepad', topLevelClassName: 'Notepad',
        titleFingerprint: 'b'.repeat(64),
        elevated: false, protectedProcess: false, secureSurface: false,
      }]),
      probeBinding,
      observe: vi.fn(), prepareAction: vi.fn(), commitAction: vi.fn(),
      cancel: vi.fn(), stop: vi.fn(), shutdown: vi.fn(), onEvent: vi.fn(() => () => {}),
    }
    const backend = createComputerHelperBackend(client as never)

    await expect(backend.listCandidates()).resolves.toMatchObject([{
      candidateToken,
      titleFingerprint: 'b'.repeat(64),
      productName: 'Windows Notepad',
      topLevelClassName: 'Notepad',
    }])
    await backend.probeBinding(identity, candidateToken)
    expect(probeBinding).toHaveBeenCalledWith(identity, candidateToken)
  })

  it('maps the controller action contract to the narrow wire contract', async () => {
    const prepareAction = vi.fn(async () => ({
      preparedId: 'prepared-1', attemptId: 'attempt-1', method: 'uia' as const,
      identity, requiresHitTest: false, targetCheckIntervalMs: 40,
    }))
    const client = {
      listCandidates: vi.fn(async () => []), probeBinding: vi.fn(), observe: vi.fn(),
      prepareAction,
      commitAction: vi.fn(), cancel: vi.fn(), stop: vi.fn(), shutdown: vi.fn(),
      onEvent: vi.fn(() => () => {}),
    }
    const backend = createComputerHelperBackend(client as never)
    const abort = new AbortController()
    const request: ComputerPrepareRequest = {
      attemptId: 'attempt-1', identity, action: { kind: 'click' },
      resolvedElement: {
        backendRef: 'backend-7',
        bounds: { left: 1, top: 2, width: 3, height: 4 },
        expectedTransition: { kind: 'toggle', before: 'off', after: 'on' },
      },
      uiaRequired: true,
      expected: {
        title: 'Temporary canary',
        titleFingerprint: 'b'.repeat(64),
        geometry: { left: 0, top: 0, width: 800, height: 600 }, dpi: 120,
        foreground: true, screenLocked: false, userInputEpoch: 9,
      },
      signal: abort.signal,
    }

    await backend.prepareAction(request)

    expect(prepareAction).toHaveBeenCalledWith({
      attemptId: 'attempt-1', identity,
      action: { kind: 'click' },
      resolvedElement: {
        backendRef: 'backend-7',
        expectedTransition: { kind: 'toggle', before: 'off', after: 'on' },
      },
      expected: request.expected,
      signal: abort.signal,
    })
  })

  it('adds the attempt id required by the durable controller result', async () => {
    const onTransferred = vi.fn()
    const client = {
      listCandidates: vi.fn(async () => []), probeBinding: vi.fn(), observe: vi.fn(),
      prepareAction: vi.fn(),
      commitAction: vi.fn(async (_prepared, opts) => {
        opts.onTransferred?.()
        return { readback: { matched: true, detail: 'verified' } }
      }),
      cancel: vi.fn(), stop: vi.fn(), shutdown: vi.fn(), onEvent: vi.fn(() => () => {}),
    }
    const backend = createComputerHelperBackend(client as never)
    const prepared = {
      preparedId: 'prepared-1', attemptId: 'attempt-1', method: 'uia' as const,
      identity, requiresHitTest: false,
    }
    const result = await backend.commitAction(prepared, {
      signal: new AbortController().signal,
      onTransferred,
    })

    expect(onTransferred).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ attemptId: 'attempt-1', readback: { matched: true, detail: 'verified' } })
  })
})
