import { describe, expect, it } from 'vitest'
import { createComputerUseComposerActivationGate } from '../../../electron/ai/computer/composer-activation'

describe('Computer Use main-owned composer activation gate', () => {
  it('matches one renderer mouse proof to the exact recent native mouse-up', () => {
    let now = 1_000
    const gate = createComputerUseComposerActivationGate(() => now)
    gate.noteMouse({ type: 'mouseUp', button: 'left', x: 120, y: 240 })

    expect(gate.consume({ kind: 'mouse', x: 120, y: 240 })).toBe(true)
    expect(gate.consume({ kind: 'mouse', x: 120, y: 240 })).toBe(false)

    gate.noteMouse({ type: 'mouseUp', button: 'left', x: 120, y: 240 })
    expect(gate.consume({ kind: 'mouse', x: 140, y: 240 })).toBe(false)

    gate.noteMouse({ type: 'mouseUp', button: 'left', x: 120, y: 240 })
    now += 251
    expect(gate.consume({ kind: 'mouse', x: 120, y: 240 })).toBe(false)
  })

  it('matches one unmodified Enter proof and rejects modified/non-keydown input', () => {
    const gate = createComputerUseComposerActivationGate(() => 2_000)

    gate.noteKey({ type: 'keyDown', key: 'Enter', shift: false, control: false, meta: false, alt: false })
    expect(gate.consume({ kind: 'keyboard', key: 'Enter' })).toBe(true)
    expect(gate.consume({ kind: 'keyboard', key: 'Enter' })).toBe(false)

    gate.noteKey({ type: 'keyDown', key: 'Enter', shift: true, control: false, meta: false, alt: false })
    expect(gate.consume({ kind: 'keyboard', key: 'Enter' })).toBe(false)

    gate.noteKey({ type: 'keyUp', key: 'Enter', shift: false, control: false, meta: false, alt: false })
    expect(gate.consume({ kind: 'keyboard', key: 'Enter' })).toBe(false)
  })
})
