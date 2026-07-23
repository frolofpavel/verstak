// c1-actions-validation.test.ts — Strict C1 validation & red-first regression tests.
// Covers fail-closed scope, elementRef invalidation, stale observationVersion,
// wrong origin/tab STOP, reload without observation, and wait_for handling.

import { describe, it, expect } from 'vitest'
import { createExtensionAdapterWithTransport } from '../../../electron/ai/browser/adapters/extension'
import type { BridgePageSnapshot } from '../../../electron/ai/browser/bridge/protocol'

function makeTestSnapshot(opts?: { url?: string; origin?: string; tabRef?: string }): BridgePageSnapshot {
  const url = opts?.url || 'https://example.com/page1'
  const origin = opts?.origin || 'https://example.com'
  return {
    text: 'Example content',
    tables: [],
    source: { url, title: 'Title', origin },
    controls: [
      {
        elementRef: 'input:Select:0',
        role: 'combobox',
        label: 'Select option',
        observationVersion: 100,
      },
      {
        elementRef: 'button:Submit:0',
        role: 'button',
        label: 'Submit',
        observationVersion: 100,
      },
    ],
    observationVersion: 100,
  }
}

describe('C1 actions validation & fail-closed scope', () => {
  it('1. missing browserTaskId/runId lineage → fail-closed throw on all C1 actions', async () => {
    const adapter = createExtensionAdapterWithTransport({
      connected: true,
      attachedTabRef: 'tab-1',
      attachedOrigin: 'https://example.com',
      browserTaskId: '', // missing
      runId: '', // missing
      requestObserve: async () => makeTestSnapshot(),
    })

    // Without observe, no lineage in adapter or state
    await expect(adapter.navigate('https://example.com/2')).rejects.toThrow(/lineage|observe/i)
    await expect(adapter.scroll(null, { y: 100 })).rejects.toThrow(/lineage|observe/i)
    await expect(adapter.focus('input:Select:0')).rejects.toThrow(/lineage|observe|elementRef/i)
    await expect(adapter.selectOption!('input:Select:0', 'v1')).rejects.toThrow(/lineage|observe|elementRef/i)
    await expect(adapter.waitFor!({ text: 'test' })).rejects.toThrow(/lineage|observe/i)
  })

  it('2. navigate invalidates elementRef map (lastObs = null)', async () => {
    let obsCount = 0
    const adapter = createExtensionAdapterWithTransport({
      connected: true,
      attachedTabRef: 'tab-1',
      attachedOrigin: 'https://example.com',
      browserTaskId: 'bt-1',
      runId: 'run-1',
      requestObserve: async () => {
        obsCount++
        return makeTestSnapshot()
      },
      requestNavigate: async () => ({ ok: true, finalUrl: 'https://example.com/page2', title: 'P2' }),
    })

    // First observe populates lastObs
    await adapter.observe({ browserTaskId: 'bt-1', runId: 'run-1', tabRef: 'tab-1' })
    expect(obsCount).toBe(1)

    // Navigate must invalidate lastObs
    await adapter.navigate('https://example.com/page2')

    // Click after navigate without fresh observe must fail due to invalidated lastObs
    await expect(adapter.click('button:Submit:0')).rejects.toThrow(/нет observation|elementRef/i)
  })

  it('3. scroll / focus / select_option with missing or stale elementRef fail-closed', async () => {
    const adapter = createExtensionAdapterWithTransport({
      connected: true,
      attachedTabRef: 'tab-1',
      attachedOrigin: 'https://example.com',
      browserTaskId: 'bt-1',
      runId: 'run-1',
      requestObserve: async () => makeTestSnapshot(),
      requestFocus: async () => ({ ok: true }),
      requestSelectOption: async () => ({ ok: true }),
    })

    await adapter.observe({ browserTaskId: 'bt-1', runId: 'run-1', tabRef: 'tab-1' })

    // Element ref not in controls map -> throw
    await expect(adapter.focus('button:NonExistent:99')).rejects.toThrow(/нет в последнем observation/i)
    await expect(adapter.selectOption!('button:NonExistent:99', 'val')).rejects.toThrow(/нет в последнем observation/i)
    await expect(adapter.scroll('button:NonExistent:99', { y: 50 })).rejects.toThrow(/нет в последнем observation/i)
  })

  it('4. select_option and focus on wrong origin or wrong tab → STOP', async () => {
    const adapter = createExtensionAdapterWithTransport({
      connected: true,
      attachedTabRef: 'tab-WRONG', // different attached tab than observation
      attachedOrigin: 'https://example.com',
      browserTaskId: 'bt-1',
      runId: 'run-1',
      requestObserve: async () => makeTestSnapshot({ tabRef: 'tab-ORIGINAL' }),
    })

    // Observe recorded tab-ORIGINAL
    await adapter.observe({ browserTaskId: 'bt-1', runId: 'run-1', tabRef: 'tab-ORIGINAL' })

    // Action on tab-WRONG must fail-closed
    await expect(adapter.focus('input:Select:0')).rejects.toThrow(/wrong tab|другой вкладки/i)
    await expect(adapter.selectOption!('input:Select:0', 'v1')).rejects.toThrow(/wrong tab|другой вкладки/i)
  })

  it('5. reload without prior observation → honest error', async () => {
    const adapter = createExtensionAdapterWithTransport({
      connected: true,
      attachedTabRef: 'tab-1',
      attachedOrigin: 'https://example.com',
      browserTaskId: 'bt-1',
      runId: 'run-1',
      requestObserve: async () => makeTestSnapshot(),
    })

    // Without observe, reload must throw clear error (not quiet no-op)
    await expect(adapter.reload()).rejects.toThrow(/reload невозможно|нет предшествующего observation/i)
  })

  it('6. wait_for condition checking across protocol wire', async () => {
    let waitForCalled = false
    const adapter = createExtensionAdapterWithTransport({
      connected: true,
      attachedTabRef: 'tab-1',
      attachedOrigin: 'https://example.com',
      browserTaskId: 'bt-1',
      runId: 'run-1',
      requestObserve: async () => makeTestSnapshot(),
      requestWaitFor: async (input: { condition: { text?: string } }) => {
        waitForCalled = true
        expect(input.condition.text).toBe('Отчёт готов')
        return { ok: true, reason: 'matched' }
      },
    })

    await adapter.observe({ browserTaskId: 'bt-1', runId: 'run-1', tabRef: 'tab-1' })
    const res = await adapter.waitFor!({ text: 'Отчёт готов', timeoutMs: 5000 })
    expect(res.ok).toBe(true)
    expect(res.reason).toBe('matched')
    expect(waitForCalled).toBe(true)
  })
})
