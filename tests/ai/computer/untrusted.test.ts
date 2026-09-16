import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { wrapComputerObservationForModel } from '../../../electron/ai/computer/untrusted'
import type { ComputerObservation } from '../../../electron/ai/computer/types'

function observationWithElements(count: number): ComputerObservation {
  return {
    observationId: 'wo-boundary',
    observationVersion: 1,
    capturedAt: 1,
    browserTaskId: 'bt-1',
    runId: 'run-1',
    bindingGeneration: 1,
    targetFingerprint: 'a'.repeat(64),
    processName: 'notepad.exe',
    title: 'Visible document',
    geometry: { left: 0, top: 0, width: 800, height: 600 },
    dpi: 96,
    foreground: true,
    screenLocked: false,
    userInputEpoch: 1,
    elements: Array.from({ length: count }, (_, index) => ({
      elementRef: `we-boundary-${index + 1}`,
      role: 'Button',
      label: `Action ${index + 1}`,
      supportedActions: ['click'] as const,
    })),
    text: '',
    screenshotDataUrl: null,
    omissions: [],
  }
}

describe('computer observation model boundary', () => {
  it('exports only refs whose semantics are visible in the first 200 elements', () => {
    const wrapped = wrapComputerObservationForModel(observationWithElements(201))

    expect(wrapped.text).toContain('[we-boundary-200] Button: Action 200')
    expect(wrapped.text).not.toContain('[we-boundary-201]')
    expect(wrapped.structured.elements).toHaveLength(200)
    expect(wrapped.structured.elements[199]).toEqual({
      elementRef: 'we-boundary-200',
      supportedActions: ['click'],
    })
    expect(wrapped.structured.elements.some(element => element.elementRef === 'we-boundary-201')).toBe(false)
    expect(wrapped.truncated).toBe(true)
  })

  it('pins the same bounded element set for visible semantics and structured refs', () => {
    const source = readFileSync(
      join(process.cwd(), 'electron', 'ai', 'computer', 'untrusted.ts'),
      'utf8',
    )
    const hasSharedBoundary = (value: string) => [
      /const visibleElements = observation\.elements\.slice\(0, MAX_ELEMENTS\)/u,
      /for \(const element of visibleElements\)/u,
      /elements: visibleElements\.map\(element => \(\{/u,
    ].every(pattern => pattern.test(value))

    expect(hasSharedBoundary(source)).toBe(true)
    const mutation = source.replace(
      'elements: visibleElements.map(element => ({',
      'elements: observation.elements.map(element => ({',
    )
    expect(mutation).not.toBe(source)
    expect(hasSharedBoundary(mutation)).toBe(false)
  })
})
