import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handles, listeners, showMessageBox } = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: any[]) => unknown>(),
  showMessageBox: vi.fn(async () => ({ response: 1 })),
}))

vi.mock('electron', () => ({
  dialog: { showMessageBox },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handles.set(channel, handler)
    }),
    on: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      listeners.set(channel, handler)
    }),
  },
}))

import { registerComputerUseIpc } from '../../electron/ipc/computer-use'

describe('Computer Use renderer IPC', () => {
  beforeEach(() => {
    handles.clear()
    listeners.clear()
    showMessageBox.mockReset()
    showMessageBox.mockResolvedValue({ response: 1 })
  })

  function install() {
    const isChatTainted = vi.fn((chatId: number) => chatId === 17)
    const controller = {
      getBinding: vi.fn(() => ({
        candidateId: 'opaque-selected',
        bindingGeneration: 7,
        targetFingerprint: 'must-stay-main-only',
        identity: { pid: 4242, processStartTime100ns: '123', hwnd: '0x1234' },
        processName: 'notepad.exe',
        title: 'Temporary R2 document',
        expiresAt: 123456789 as number | null,
        reconciliationRequired: false,
        reconciliationAcknowledgementAvailable: false,
      })),
      listCandidates: vi.fn(async () => [{
        candidateId: 'opaque-1',
        processName: 'notepad.exe',
        title: 'Temporary R2 document',
        blockedReason: null,
        pid: 4242,
        hwnd: '0x1234',
      }]),
      bindCandidate: vi.fn(async () => ({
        ok: true,
        bindingGeneration: 8,
        targetFingerprint: 'must-stay-main-only',
      })),
      prepareUncertainAcknowledgement: vi.fn(() => null as null | {
        challenge: string
        bindingGeneration: number
        processName: string
        title: string
      }),
      acknowledgePreparedUncertain: vi.fn(async (_challenge: string) => true),
      unbind: vi.fn(),
      stop: vi.fn(() => ({ acknowledged: true, targetAckMs: 500, realTimeGuaranteed: false })),
    }
    registerComputerUseIpc({ controller: controller as never, supported: true, isChatTainted })
    return { ...controller, isChatTainted }
  }

  it('exposes only the main-owned durable taint verdict and fails closed on invalid input or lookup error', async () => {
    const deps = install()
    const isTainted = handles.get('computer-use:is-chat-tainted')!

    expect(await isTainted({}, 17)).toBe(true)
    expect(await isTainted({}, 18)).toBe(false)
    expect(deps.isChatTainted).toHaveBeenCalledWith(17)
    expect(deps.isChatTainted).toHaveBeenCalledWith(18)

    expect(await isTainted({}, 0)).toBe(true)
    expect(await isTainted({}, '17')).toBe(true)
    deps.isChatTainted.mockImplementationOnce(() => { throw new Error('ledger unavailable') })
    expect(await isTainted({}, 19)).toBe(true)
  })

  it('exposes only a redacted state and opaque candidate ids', async () => {
    install()
    const state = await handles.get('computer-use:get-state')!({})
    const candidates = await handles.get('computer-use:list-candidates')!({})

    expect(state).toEqual({
      supported: true,
      helperReady: true,
      bound: true,
      bindingGeneration: 7,
      target: { processName: 'notepad.exe', title: 'Temporary R2 document' },
      expiresAt: 123456789,
      reconciliationRequired: false,
      reconciliationAcknowledgementAvailable: false,
    })
    expect(candidates).toEqual([{
      candidateId: 'opaque-1',
      processName: 'notepad.exe',
      title: 'Temporary R2 document',
      blockedReason: null,
    }])
    expect(JSON.stringify({ state, candidates })).not.toMatch(/4242|0x1234|fingerprint|processStartTime|browserTaskId|runId/i)
  })

  it('binds by opaque candidate id and strips the target fingerprint', async () => {
    const controller = install()
    const result = await handles.get('computer-use:bind')!({}, 'opaque-1')

    expect(controller.bindCandidate).toHaveBeenCalledWith('opaque-1')
    expect(result).toEqual({ ok: true, bindingGeneration: 8 })
  })

  it('rejects malformed candidate ids before they reach the controller', async () => {
    const controller = install()
    const result = await handles.get('computer-use:bind')!({}, '../raw-hwnd')

    expect(controller.bindCandidate).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: false, error: 'Некорректный идентификатор окна' })
  })

  it('unbinds explicitly and exposes bounded Stop acknowledgement', async () => {
    const controller = install()
    expect(await handles.get('computer-use:unbind')!({})).toEqual({ ok: true })
    expect(await handles.get('computer-use:stop')!({})).toEqual({
      acknowledged: true,
      targetAckMs: 500,
      realTimeGuaranteed: false,
    })
    expect(controller.unbind).toHaveBeenCalledTimes(1)
    expect(controller.stop).toHaveBeenCalledTimes(1)
  })

  it('requires a main-owned native confirmation and never trusts renderer-supplied lineage', async () => {
    const controller = install()
    const acknowledge = handles.get('computer-use:acknowledge-uncertain')!
    controller.getBinding.mockReturnValue({
      candidateId: 'opaque-selected',
      bindingGeneration: 7,
      targetFingerprint: 'must-stay-main-only',
      identity: { pid: 4242, processStartTime100ns: '123', hwnd: '0x1234' },
      processName: 'notepad.exe',
      title: 'Temporary R2 document',
      expiresAt: null,
      reconciliationRequired: true,
      reconciliationAcknowledgementAvailable: true,
    })
    controller.prepareUncertainAcknowledgement.mockReturnValue({
      challenge: 'main-only-challenge',
      bindingGeneration: 7,
      processName: 'notepad.exe',
      title: 'Temporary R2 document',
    })

    showMessageBox.mockResolvedValueOnce({ response: 0 })
    const cancelled = await acknowledge({ sender: { id: 9 } }, 'forged-task', 'forged-run', 'forged-action')
    expect(cancelled).toEqual({ ok: false, error: 'Подтверждение отменено' })
    expect(controller.acknowledgePreparedUncertain).not.toHaveBeenCalled()

    const accepted = await acknowledge({ sender: { id: 9 } }, 'forged-task', 'forged-run', 'forged-action')
    expect(accepted).toEqual({ ok: true })
    expect(controller.acknowledgePreparedUncertain).toHaveBeenCalledWith('main-only-challenge')
    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      defaultId: 0,
      cancelId: 0,
    }))
    expect(JSON.stringify(showMessageBox.mock.calls)).not.toMatch(/main-only-challenge|browserTaskId|runId|actionId|pid|hwnd|fingerprint/i)
    expect(JSON.stringify(accepted)).not.toMatch(/browserTaskId|runId|actionId|pid|hwnd|fingerprint/i)

    controller.acknowledgePreparedUncertain.mockResolvedValueOnce(false)
    const rejected = await acknowledge({})
    expect(rejected).toEqual({ ok: false, error: 'Нет ожидающего подтверждения результата' })
    expect(JSON.stringify(rejected)).not.toMatch(/browserTaskId|runId|actionId|pid|hwnd|fingerprint/i)
  })

  it('cannot reuse a dialog prepared before a rebind to acknowledge the new target', async () => {
    const controller = install()
    const acknowledge = handles.get('computer-use:acknowledge-uncertain')!
    controller.prepareUncertainAcknowledgement.mockReturnValue({
      challenge: 'challenge-for-a',
      bindingGeneration: 7,
      processName: 'notepad.exe',
      title: 'Target A',
    })
    let resolveDialog!: (value: { response: number }) => void
    showMessageBox.mockImplementationOnce(() => new Promise(resolve => { resolveDialog = resolve }))

    const pending = acknowledge({ sender: { id: 9 } }) as Promise<unknown>
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledTimes(1))
    await expect(acknowledge({ sender: { id: 9 } })).resolves.toEqual({
      ok: false,
      error: 'Подтверждение уже открыто',
    })
    expect(controller.prepareUncertainAcknowledgement).toHaveBeenCalledTimes(1)
    await handles.get('computer-use:bind')!({}, 'opaque-1')
    controller.acknowledgePreparedUncertain.mockResolvedValueOnce(false)
    resolveDialog({ response: 1 })

    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'Нет ожидающего подтверждения результата',
    })
    expect(controller.acknowledgePreparedUncertain).toHaveBeenCalledWith('challenge-for-a')
  })
})
