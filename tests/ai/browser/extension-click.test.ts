// extension-click.test.ts — EXT-C1: click via extension adapter + controller path.
// RED-first production-path: reject raw CSS, stale ref, wrong tab, one-shot click.

import { describe, it, expect, beforeEach } from 'vitest'
import { createExtensionAdapterWithTransport } from '../../../electron/ai/browser/adapters/extension'
import type { BridgePageSnapshot } from '../../../electron/ai/browser/bridge/protocol'

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

    const r = await adapter.click('button:Увеличить:0')
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
    await expect(adapter.click('document.querySelector("#x")')).rejects.toThrow(/raw CSS|JS/)
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
    await expect(adapter.click('button:НетТакой:0')).rejects.toThrow(/нет в последнем observation/)
    expect(clickCount).toBe(0)
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
    await expect(adapter.click('button:Увеличить:0')).rejects.toThrow()
    expect(clickCount).toBe(0)
  })
})
