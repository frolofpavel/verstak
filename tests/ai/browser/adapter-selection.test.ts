import { describe, expect, it, vi } from 'vitest'
import { bindAttachedTabToTask, selectBrowserAdapter } from '../../../electron/ai/browser/adapter-selection'
import type { BrowserAdapter, CapabilityEnvelope } from '../../../electron/ai/browser/types'
import type { BrowserTasks } from '../../../electron/storage/browser-tasks'

function adapter(id: BrowserAdapter['id'], available: boolean): BrowserAdapter {
  return {
    id,
    available: () => available,
    unavailableReason: () => available ? null : `${id} unavailable`,
  } as BrowserAdapter
}

describe('browser adapter selection truthfulness', () => {
  it('authenticated extension остаётся выбранным intent даже без attached tab', () => {
    const extension = adapter('chrome-extension', false)
    const webview = adapter('electron-webview', true)

    expect(selectBrowserAdapter({
      extensionAuthenticated: true,
      extensionAdapter: extension,
      webviewAdapter: webview,
    })).toBe(extension)
  })

  it('durable pairing сохраняет connected-browser intent после обрыва live-связи', () => {
    const extension = adapter('chrome-extension', false)
    const webview = adapter('electron-webview', true)

    expect(selectBrowserAdapter({
      extensionAuthenticated: false,
      hasDurablePairing: true,
      extensionAdapter: extension,
      webviewAdapter: webview,
    })).toBe(extension)
  })

  it('без authenticated extension сохраняет builtin webview path', () => {
    const extension = adapter('chrome-extension', false)
    const webview = adapter('electron-webview', true)

    expect(selectBrowserAdapter({
      extensionAuthenticated: false,
      extensionAdapter: extension,
      webviewAdapter: webview,
    })).toBe(webview)
  })

  it('явный builtin mode побеждает authenticated extension', () => {
    const extension = adapter('chrome-extension', true)
    const webview = adapter('electron-webview', true)

    expect(selectBrowserAdapter({
      preferred: 'electron-webview',
      extensionAuthenticated: true,
      extensionAdapter: extension,
      webviewAdapter: webview,
    })).toBe(webview)
  })
})

describe('attached singleton durable binding', () => {
  it('переносит tabRef и origin в bt-chat, пинит origin и capability', () => {
    const setTaskTab = vi.fn()
    const setAllowedDomains = vi.fn()
    const setCaps = vi.fn()
    const taskTabs = new Map<string, string>()
    const storage = {
      get: () => ({ allowedDomains: ['existing.example'] }),
      setTaskTab,
      setAllowedDomains,
      setCaps,
    } as unknown as BrowserTasks
    const caps = {
      allowedDomains: [],
      allowedActionTypes: ['observe'],
    } as unknown as CapabilityEnvelope

    bindAttachedTabToTask({
      browserTaskId: 'bt-17',
      tab: { tabRef: 'tab-42', url: 'https://my.calltouch.ru/accounts' },
      storage,
      taskTabs,
      getCapability: () => caps,
    })

    expect(setTaskTab).toHaveBeenCalledWith('bt-17', 'tab-42')
    expect(taskTabs.get('bt-17')).toBe('tab-42')
    expect(setAllowedDomains).toHaveBeenCalledWith('bt-17', ['existing.example', 'my.calltouch.ru'])
    expect(setCaps).toHaveBeenCalledWith('bt-17', expect.objectContaining({
      allowedDomains: ['existing.example', 'my.calltouch.ru'],
      allowedActionTypes: ['observe', 'click'],
    }))
  })
})
