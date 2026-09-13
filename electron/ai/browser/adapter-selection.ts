import type { BrowserAdapter } from './types'
import type { CapabilityEnvelope } from './types'
import type { BrowserTasks } from '../../storage/browser-tasks'

export interface BrowserAdapterSelectionInput {
  preferred?: BrowserAdapter['id']
  extensionAuthenticated: boolean
  /** Durable pairing keeps the user's connected-browser choice across disconnects. */
  hasDurablePairing?: boolean
  extensionAdapter: BrowserAdapter
  webviewAdapter: BrowserAdapter
}

/**
 * Выбирает среду по пользовательскому intent, а не по текущей доступности.
 * Для connected browser live-auth или durable pairing означают выбор extension:
 * обрыв связи и отсутствие attached tab должны вернуться честной ошибкой
 * extension adapter, а не незаметно отправить browser_read_page во встроенный webview.
 */
export function selectBrowserAdapter(input: BrowserAdapterSelectionInput): BrowserAdapter {
  if (input.preferred === 'chrome-extension') return input.extensionAdapter
  if (input.preferred === 'electron-webview') return input.webviewAdapter
  const connectedBrowserIntent = input.extensionAuthenticated || input.hasDurablePairing === true
  return connectedBrowserIntent ? input.extensionAdapter : input.webviewAdapter
}

export interface AttachedTabBindingInput {
  browserTaskId: string
  tab: { tabRef: string; url: string }
  storage: BrowserTasks
  taskTabs: Map<string, string>
  getCapability: (browserTaskId: string) => CapabilityEnvelope
}

/** Переносит live toolbar-tab в durable task текущего чата. */
export function bindAttachedTabToTask(input: AttachedTabBindingInput): void {
  const { browserTaskId, tab, storage, taskTabs } = input
  storage.setTaskTab(browserTaskId, tab.tabRef)
  taskTabs.set(browserTaskId, tab.tabRef)

  let host = ''
  try { host = new URL(tab.url).host } catch { return }
  if (!host) return

  const existingDomains = storage.get(browserTaskId)?.allowedDomains ?? []
  const domains = Array.from(new Set([...existingDomains, host]))
  storage.setAllowedDomains(browserTaskId, domains)

  const caps = input.getCapability(browserTaskId)
  storage.setCaps(browserTaskId, {
    ...caps,
    allowedDomains: Array.from(new Set([...(caps.allowedDomains || []), ...domains])),
    allowedActionTypes: caps.allowedActionTypes.includes('click')
      ? caps.allowedActionTypes
      : [...caps.allowedActionTypes, 'click'],
  } as unknown as Record<string, unknown>)
}
