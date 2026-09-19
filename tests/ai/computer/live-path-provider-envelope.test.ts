import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { wrapComputerObservationForModel } from '../../../electron/ai/computer/untrusted'
import type { ComputerObservation } from '../../../electron/ai/computer/types'
import { compactToolHistory } from '../../../electron/ai/compact-history'
import { serializeProviderToolResult } from '../../../electron/ai/provider-tool-result'
import type { ToolResult } from '../../../electron/ai/types'

const ONE_REF = 'we-00000000-0000-4000-8000-000000000101'
const NAV_REF = 'we-00000000-0000-4000-8000-000000000001'

describe('Computer Use live-path provider envelope', () => {
  it('pins verstak-gateway and Claude to the shared Computer serializer', () => {
    const openai = readFileSync(join(process.cwd(), 'electron/ai/openai-compat.ts'), 'utf8')
    const claude = readFileSync(join(process.cwd(), 'electron/ai/claude.ts'), 'utf8')
    expect(openai).toContain('serializeProviderToolResult')
    expect(claude).toContain('serializeProviderToolResult')
    expect(openai).not.toMatch(/JSON\.stringify\(r\.result\)\.slice\(0, 5000\)/u)
    expect(claude).not.toMatch(/JSON\.stringify\(r\.result\)\.slice\(0, 5000\)/u)
  })

  it('proves the installed 2.9.1 path: 5000-char gateway slice keeps Open Navigation ref and drops One label', () => {
    const live = naiveGatewaySlice(calculatorObserveResult())
    expect(JSON.stringify(calculatorObserveResult().result).length).toBeGreaterThan(5000)
    expect(firstStructuredClickable(live)).toBe(NAV_REF)
    expect(live).not.toContain('Open Navigation')
    expect(live).not.toContain('Button: One')
    expect(live).not.toMatch(/\[we-[^\]]+\] Button: One;/u)
  })

  it('gives the model Calculator digit labels on the live observe → tool result → provider path', () => {
    const payload = serializeProviderToolResult(calculatorObserveResult())
    expect(payload).toContain(`[${ONE_REF}] Button: One; actions=click`)
    expect(payload).toContain('observationId":"wo-00000000-0000-4000-8000-000000000001')
    expect(payload).toContain('Open Navigation')
    expect(payload).not.toContain(`"elementRef":"${NAV_REF}"`)
  })

  it('keeps One after compactToolHistory on the first Computer observe turn', () => {
    const compacted = compactToolHistory([
      { role: 'user', content: 'Открой калькулятор и посчитай 125 × 47' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-observe', name: 'computer_observe', args: {} }] },
      { role: 'user', content: '', toolResults: [calculatorObserveResult()] },
    ], 0)
    const result = compacted[2]?.toolResults?.[0]
    expect(result).toBeDefined()
    expect(serializeProviderToolResult(result!)).toContain(`[${ONE_REF}] Button: One; actions=click`)
  })

  it('keeps uncertain/readback-mismatch and the no-retry sentence in the provider envelope', () => {
    const payload = serializeProviderToolResult({
      ...calculatorObserveResult(),
      name: 'computer_click',
      error: 'readback-mismatch Исход действия неизвестен; автоматический повтор запрещён.',
      result: {
        ...(calculatorObserveResult().result as Record<string, unknown>),
        status: 'uncertain',
        detail: 'readback-mismatch',
      },
    })
    expect(payload.startsWith('Error: readback-mismatch')).toBe(true)
    expect(payload).toContain('автоматический повтор запрещён')
    expect(payload).toContain(`[${ONE_REF}] Button: One; actions=click`)
  })
})

function calculatorObserveResult(): ToolResult {
  const observation = calculatorObservation()
  const wrapped = wrapComputerObservationForModel(observation)
  return {
    id: 'call-observe',
    name: 'computer_observe',
    result: {
      actionId: 'run-live:computer-observe',
      status: 'verified',
      detail: 'independent-readback-verified',
      observation: wrapped.structured,
      observationText: wrapped.text,
    },
  }
}

function calculatorObservation(): ComputerObservation {
  const chrome = [
    { ref: NAV_REF, label: 'Open Navigation' },
    { ref: 'we-00000000-0000-4000-8000-000000000002', label: 'History' },
    { ref: 'we-00000000-0000-4000-8000-000000000003', label: 'Memory' },
    { ref: 'we-00000000-0000-4000-8000-000000000004', label: 'Clear' },
  ]
  const filler = Array.from({ length: 48 }, (_, index) => ({
    ref: `we-00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
    label: `Pad ${index + 1}`,
  }))
  const digits = [
    { ref: ONE_REF, label: 'One' },
    { ref: 'we-00000000-0000-4000-8000-000000000102', label: 'Two' },
    { ref: 'we-00000000-0000-4000-8000-000000000105', label: 'Five' },
    { ref: 'we-00000000-0000-4000-8000-000000000112', label: 'Multiply by' },
    { ref: 'we-00000000-0000-4000-8000-000000000104', label: 'Four' },
    { ref: 'we-00000000-0000-4000-8000-000000000107', label: 'Seven' },
    { ref: 'we-00000000-0000-4000-8000-000000000115', label: 'Equals' },
  ]
  return {
    observationId: 'wo-00000000-0000-4000-8000-000000000001',
    observationVersion: 1,
    capturedAt: 1,
    browserTaskId: 'bt-99',
    runId: '237ae48f-f62f-4cd7-abc1-23ef58c7fe74',
    bindingGeneration: 1,
    targetFingerprint: 'c'.repeat(64),
    processName: 'CalculatorApp.exe',
    title: 'Calculator',
    geometry: { left: 0, top: 0, width: 420, height: 640 },
    dpi: 96,
    foreground: true,
    screenLocked: false,
    userInputEpoch: 1,
    text: '0',
    screenshotDataUrl: null,
    omissions: [],
    elements: [...chrome, ...filler, ...digits].map(item => ({
      elementRef: item.ref,
      role: 'Button',
      label: item.label,
      supportedActions: ['click'] as const,
    })),
  }
}

function naiveGatewaySlice(result: ToolResult): string {
  return typeof result.result === 'string'
    ? result.result
    : JSON.stringify(result.result).slice(0, 5000)
}

function firstStructuredClickable(payload: string): string | null {
  const match = payload.match(/"elementRef":"(we-[^"]+)"[^}]*"supportedActions":\["click"\]/u)
  return match?.[1] ?? null
}
