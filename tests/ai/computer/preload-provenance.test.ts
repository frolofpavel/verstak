import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({
  api: null as null | Record<string, unknown>,
  sendSync: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: Record<string, unknown>) => {
      bridge.api = api
    },
  },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
    sendSync: bridge.sendSync,
  },
}))

await import('../../../electron/preload')

type ComposerApi = {
  mintComputerUseComposerTicket: (
    chatId: string,
    canonicalUserContent: string,
  ) => string | null
}

function aiApi(): ComposerApi {
  return (bridge.api as { ai: ComposerApi }).ai
}

describe('Computer Use preload composer provenance', () => {
  beforeEach(() => {
    bridge.sendSync.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('не обращается к main без текущей browser user activation', () => {
    vi.stubGlobal('navigator', { userActivation: { isActive: false } })

    expect(aiApi().mintComputerUseComposerTicket('17', '/computer-use: click Save'))
      .toBeNull()
    expect(bridge.sendSync).not.toHaveBeenCalled()
  })

  it('синхронно запрашивает opaque ticket только во время текущей user activation', () => {
    vi.stubGlobal('navigator', { userActivation: { isActive: true } })
    bridge.sendSync.mockReturnValue('ticket-from-main')

    expect(aiApi().mintComputerUseComposerTicket('17', '/computer-use: click Save'))
      .toBe('ticket-from-main')
    expect(bridge.sendSync).toHaveBeenCalledWith(
      'ai:mint-computer-use-composer-ticket',
      '17',
      '/computer-use: click Save',
      { kind: 'keyboard', key: 'Enter' },
    )
  })
})
