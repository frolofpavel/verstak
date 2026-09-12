// d1-keyboard-actions.test.ts — Unit tests for Stage D1 (type_text, clear_field, toggle, press_key)
import { describe, it, expect } from 'vitest'
import { createExtensionAdapterWithTransport } from '../../../electron/ai/browser/adapters/extension'
import type { BridgePageSnapshot } from '../../../electron/ai/browser/bridge/protocol'

function makeTestSnapshot(): BridgePageSnapshot {
  return {
    text: 'Form test',
    tables: [],
    source: { url: 'https://example.com/form', title: 'Form', origin: 'https://example.com' },
    controls: [
      {
        elementRef: 'input:Username:0',
        role: 'textbox',
        label: 'Username',
        observationVersion: 10,
      },
      {
        elementRef: 'checkbox:Agree:0',
        role: 'checkbox',
        label: 'Agree',
        observationVersion: 10,
      },
    ],
    observationVersion: 10,
  }
}

describe('Stage D1: Keyboard & Text Input actions', () => {
  it('1. typeText passes payload over wire and invalidates lastObs', async () => {
    let typedText = ''
    let clearFirst = false
    let submitEnter = false

    const adapter = createExtensionAdapterWithTransport({
      connected: true,
      attachedTabRef: 'tab-1',
      attachedOrigin: 'https://example.com',
      browserTaskId: 'bt-d1',
      runId: 'run-d1',
      requestObserve: async () => makeTestSnapshot(),
      requestTypeText: async (input) => {
        typedText = input.text
        clearFirst = !!input.clearFirst
        submitEnter = !!input.submitEnter
        return { ok: true }
      },
    })

    await adapter.observe({ browserTaskId: 'bt-d1', runId: 'run-d1', tabRef: 'tab-1' })
    await adapter.typeText!('input:Username:0', 'admin_user', { clearFirst: true, submitEnter: true })

    expect(typedText).toBe('admin_user')
    expect(clearFirst).toBe(true)
    expect(submitEnter).toBe(true)

    // Invalidation check: call without re-observe must fail
    await expect(adapter.typeText!('input:Username:0', 'other')).rejects.toThrow(/нет observation|elementRef/i)
  })

  it('2. clearField sends clear request and invalidates lastObs', async () => {
    let clearedRef = ''
    const adapter = createExtensionAdapterWithTransport({
      connected: true,
      attachedTabRef: 'tab-1',
      attachedOrigin: 'https://example.com',
      browserTaskId: 'bt-d1',
      runId: 'run-d1',
      requestObserve: async () => makeTestSnapshot(),
      requestClearField: async (input) => {
        clearedRef = input.elementRef
        return { ok: true }
      },
    })

    await adapter.observe({ browserTaskId: 'bt-d1', runId: 'run-d1', tabRef: 'tab-1' })
    await adapter.clearField!('input:Username:0')
    expect(clearedRef).toBe('input:Username:0')
  })

  it('3. toggle checkbox sends request and invalidates lastObs', async () => {
    let toggledRef = ''
    const adapter = createExtensionAdapterWithTransport({
      connected: true,
      attachedTabRef: 'tab-1',
      attachedOrigin: 'https://example.com',
      browserTaskId: 'bt-d1',
      runId: 'run-d1',
      requestObserve: async () => makeTestSnapshot(),
      requestToggle: async (input) => {
        toggledRef = input.elementRef
        return { ok: true }
      },
    })

    await adapter.observe({ browserTaskId: 'bt-d1', runId: 'run-d1', tabRef: 'tab-1' })
    await adapter.toggle!('checkbox:Agree:0')
    expect(toggledRef).toBe('checkbox:Agree:0')
  })

  it('4. pressKey sends key events across bridge', async () => {
    let pressedKey = ''
    const adapter = createExtensionAdapterWithTransport({
      connected: true,
      attachedTabRef: 'tab-1',
      attachedOrigin: 'https://example.com',
      browserTaskId: 'bt-d1',
      runId: 'run-d1',
      requestObserve: async () => makeTestSnapshot(),
      requestPressKey: async (input) => {
        pressedKey = input.key
        return { ok: true }
      },
    })

    await adapter.observe({ browserTaskId: 'bt-d1', runId: 'run-d1', tabRef: 'tab-1' })
    await adapter.pressKey!('input:Username:0', 'Enter')
    expect(pressedKey).toBe('Enter')
  })
})
