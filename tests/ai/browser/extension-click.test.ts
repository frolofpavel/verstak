// extension-click.test.ts — EXT-C1: click via extension adapter + controller path.
// RED-first production-path: reject raw CSS, stale ref, wrong tab, one-shot click.

import { describe, it, expect, beforeEach } from 'vitest'
import { createExtensionAdapterWithTransport } from '../../../electron/ai/browser/adapters/extension'
import type { BridgePageSnapshot } from '../../../electron/ai/browser/bridge/protocol'
import { UnknownBrowserEffectError } from '../../../electron/ai/browser/errors'

const SCOPE = {
  browserTaskId: 'bt-1',
  runId: 'run-1',
  tabRef: 'tab-1',
  origin: '127.0.0.1:8765',
} as const

function snap(over: Partial<BridgePageSnapshot> = {}): BridgePageSnapshot {
  return {
    text: 'Счётчик: 0',
    tables: [],
    source: { url: 'http://127.0.0.1:8765/', title: 'counter', origin: 'http://127.0.0.1:8765' },
    controls: [
      {
        elementRef: 'button:Увеличить:0',
        role: 'button',
        label: 'Увеличить',
        observationVersion: 100,
      },
    ],
    observationVersion: 100,
    ...over,
  }
}

describe('EXT-C1 extension click', () => {
  it.each(['click', 'navigate', 'scroll', 'focus', 'select_option', 'type_text',
    'clear_field', 'toggle', 'press_key'] as const)('%s propagates transport uncertainty unchanged to its caller', async action => {
    let dispatches = 0
    const unknown = new UnknownBrowserEffectError('acknowledgement was lost', 'timeout')
    const loseAcknowledgement = async (): Promise<never> => {
      dispatches += 1
      throw unknown
    }
    const ref = action === 'toggle' ? 'checkbox:Agree:0'
      : action === 'select_option' ? 'select:Role:0'
      : action === 'click' ? 'button:Save:0' : 'input:Name:0'
    const adapter = createExtensionAdapterWithTransport({
      attachedTabRef: SCOPE.tabRef,
      attachedOrigin: 'http://127.0.0.1:8765',
      browserTaskId: SCOPE.browserTaskId,
      runId: SCOPE.runId,
      requestObserve: async () => snap({ controls: [
        { elementRef: ref, role: 'control', label: 'Fixture', observationVersion: 100 },
      ] }),
      requestClick: loseAcknowledgement,
      requestNavigate: loseAcknowledgement,
      requestScroll: loseAcknowledgement,
      requestFocus: loseAcknowledgement,
      requestSelectOption: loseAcknowledgement,
      requestTypeText: loseAcknowledgement,
      requestClearField: loseAcknowledgement,
      requestToggle: loseAcknowledgement,
      requestPressKey: loseAcknowledgement,
    })
    await adapter.observe(SCOPE)
    const starters: Record<typeof action, () => Promise<unknown>> = {
      click: () => adapter.click(ref, SCOPE),
      navigate: () => adapter.navigate('http://127.0.0.1:8765/next', SCOPE),
      scroll: () => adapter.scroll(null, { y: 50 }, SCOPE),
      focus: () => adapter.focus(ref, SCOPE),
      select_option: () => adapter.selectOption!(ref, 'value', SCOPE),
      type_text: () => adapter.typeText!(ref, 'fixture', undefined, SCOPE),
      clear_field: () => adapter.clearField!(ref, SCOPE),
      toggle: () => adapter.toggle!(ref, SCOPE),
      press_key: () => adapter.pressKey!(ref, 'Enter', SCOPE),
    }
    await expect(starters[action]()).rejects.toBe(unknown)
    expect(dispatches).toBe(1)
  })

  let clickCount = 0
  let lastClick: Record<string, unknown> | null = null

  beforeEach(() => {
    clickCount = 0
    lastClick = null
  })

  it('observe → controls map → click once → post text', async () => {
    let text = 'Счётчик: 0'
    const adapter = createExtensionAdapterWithTransport({
      attachedTabRef: 'tab-1',
      attachedOrigin: 'http://127.0.0.1:8765',
      browserTaskId: 'bt-1',
      runId: 'run-1',
      requestObserve: async () =>
        snap({
          text,
          controls: [
            {
              elementRef: 'button:Увеличить:0',
              role: 'button',
              label: 'Увеличить',
              observationVersion: text === 'Счётчик: 0' ? 100 : 200,
            },
          ],
          observationVersion: text === 'Счётчик: 0' ? 100 : 200,
        }),
      requestClick: async (input) => {
        lastClick = { ...input }
        clickCount += 1
        text = 'Счётчик: 1'
        return { ok: true, finalUrl: 'http://127.0.0.1:8765/' }
      },
    })

    const obs = await adapter.observe({ browserTaskId: 'bt-1', runId: 'run-1', tabRef: 'tab-1' })
    expect(obs.controls?.some((c) => c.label.includes('Увеличить'))).toBe(true)
    expect(obs.text).toContain('Счётчик: 0')

    const r = await adapter.click('button:Увеличить:0', SCOPE)
    expect(r.finalUrl).toContain('127.0.0.1')
    expect(clickCount).toBe(1)
    expect(lastClick?.elementRef).toBe('button:Увеличить:0')
    expect(lastClick?.observationVersion).toBe(100)

    const after = await adapter.observe({ browserTaskId: 'bt-1', runId: 'run-1', tabRef: 'tab-1' })
    expect(after.text).toContain('Счётчик: 1')
  })

  it('raw CSS selector → reject, 0 clicks', async () => {
    const adapter = createExtensionAdapterWithTransport({
      attachedTabRef: 'tab-1',
      attachedOrigin: 'http://127.0.0.1:8765',
      requestObserve: async () => snap(),
      requestClick: async () => {
        clickCount += 1
        return { ok: true, finalUrl: 'http://127.0.0.1:8765/' }
      },
    })
    await adapter.observe({ browserTaskId: 'bt-1', runId: 'run-1', tabRef: 'tab-1' })
    await expect(adapter.click('document.querySelector("#x")', SCOPE)).rejects.toThrow(/raw CSS|JS/)
    expect(clickCount).toBe(0)
  })

  it('unknown elementRef → reject before bridge click', async () => {
    const adapter = createExtensionAdapterWithTransport({
      attachedTabRef: 'tab-1',
      attachedOrigin: 'http://127.0.0.1:8765',
      requestObserve: async () => snap(),
      requestClick: async () => {
        clickCount += 1
        return { ok: true, finalUrl: 'http://127.0.0.1:8765/' }
      },
    })
    await adapter.observe({ browserTaskId: 'bt-1', runId: 'run-1', tabRef: 'tab-1' })
    await expect(adapter.click('button:НетТакой:0', SCOPE)).rejects.toThrow(/нет в последнем observation/)
    expect(clickCount).toBe(0)
  })

  it('reconnect на той же вкладке инвалидирует старый elementRef до fresh observe', async () => {
    let connectionGeneration = 1
    const adapter = createExtensionAdapterWithTransport({
      attachedTabRef: 'tab-1',
      attachedOrigin: 'http://127.0.0.1:8765',
      browserTaskId: 'bt-1',
      runId: 'run-1',
      getConnectionGeneration: () => connectionGeneration,
      requestObserve: async () => snap(),
      requestClick: async () => {
        clickCount += 1
        return { ok: true, finalUrl: 'http://127.0.0.1:8765/' }
      },
    })

    await adapter.observe(SCOPE)
    connectionGeneration += 1

    await expect(adapter.click('button:Увеличить:0', SCOPE)).rejects.toThrow(/reconnect|свеж.*observe/i)
    expect(clickCount).toBe(0)

    await adapter.observe(SCOPE)
    await expect(adapter.click('button:Увеличить:0', SCOPE)).resolves.toMatchObject({
      finalUrl: 'http://127.0.0.1:8765/',
    })
    expect(clickCount).toBe(1)
  })

  it('not attached → unavailable', async () => {
    const adapter = createExtensionAdapterWithTransport({
      attachedTabRef: null,
      sessionId: 's1',
      requestObserve: async () => snap(),
      requestClick: async () => {
        clickCount += 1
        return { ok: true, finalUrl: '' }
      },
    })
    expect(adapter.available()).toBe(false)
    await expect(adapter.click('button:Увеличить:0', SCOPE)).rejects.toThrow()
    expect(clickCount).toBe(0)
  })
})
