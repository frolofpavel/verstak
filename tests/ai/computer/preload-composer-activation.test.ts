import { describe, expect, it, vi } from 'vitest'
import { installComputerUseComposerActivationLatch } from '../../../electron/preload-computer-use-activation'

type CapturedListener = (event: {
  isTrusted: boolean
  key?: string
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  clientX?: number
  clientY?: number
  composedPath: () => unknown[]
}) => void

function element(...classes: string[]) {
  return {
    classList: {
      contains: (name: string) => classes.includes(name),
    },
  }
}

function makeTarget() {
  const listeners = new Map<string, CapturedListener>()
  return {
    listeners,
    target: {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.set(type, listener as unknown as CapturedListener)
      },
    },
  }
}

describe('Computer Use preload composer activation latch', () => {
  it('trusted click on the visible send button arms exactly one synchronous mint', () => {
    const clock = vi.fn(() => 1_000)
    const { target, listeners } = makeTarget()
    const consume = installComputerUseComposerActivationLatch(target, clock)

    listeners.get('click')!({
      isTrusted: true,
      clientX: 120,
      clientY: 240,
      composedPath: () => [element('gg-send-btn')],
    })

    expect(consume()).toEqual({ kind: 'mouse', x: 120, y: 240 })
    expect(consume()).toBeNull()
  })

  it('trusted Enter in the visible composer arms mint without relying on isolated-world userActivation', () => {
    const clock = vi.fn(() => 2_000)
    const { target, listeners } = makeTarget()
    const consume = installComputerUseComposerActivationLatch(target, clock)

    listeners.get('keydown')!({
      isTrusted: true,
      key: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      composedPath: () => [element('gg-composer-textarea')],
    })

    expect(consume()).toEqual({ kind: 'keyboard', key: 'Enter' })
  })

  it('rejects synthetic, unrelated, modified, stop and expired input', () => {
    let now = 3_000
    const { target, listeners } = makeTarget()
    const consume = installComputerUseComposerActivationLatch(target, () => now)
    const click = listeners.get('click')!
    const keydown = listeners.get('keydown')!

    click({ isTrusted: false, clientX: 1, clientY: 2, composedPath: () => [element('gg-send-btn')] })
    expect(consume()).toBeNull()

    click({ isTrusted: true, clientX: 1, clientY: 2, composedPath: () => [element('gg-send-btn', 'gg-stop-btn')] })
    expect(consume()).toBeNull()

    keydown({
      isTrusted: true,
      key: 'Enter',
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      composedPath: () => [element('gg-composer-textarea')],
    })
    expect(consume()).toBeNull()

    click({ isTrusted: true, composedPath: () => [element('other-button')] })
    expect(consume()).toBeNull()

    click({ isTrusted: true, clientX: 5, clientY: 6, composedPath: () => [element('gg-send-btn')] })
    now += 251
    expect(consume()).toBeNull()
  })
})
