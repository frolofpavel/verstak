import { describe, expect, it } from 'vitest'
import { collectToolTurnOutcome, reviewGatePassedInTurn } from '../../electron/ai/runner-tool-outcome'
import { REVIEW_GATE_PASS_MARKER } from '../../electron/ai/review-gate'
import type { ToolCall, ToolResult } from '../../electron/ai/types'

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, args }
}

function result(toolCall: ToolCall, extra: Partial<ToolResult> = {}): ToolResult {
  return { id: toolCall.id, name: toolCall.name, result: '', ...extra }
}

describe('collectToolTurnOutcome', () => {
  it('собирает writes, checks и verification state без потери lineage', () => {
    const calls = [
      call('w', 'write_file', { path: 'src/a.ts', content: 'export const a = 1' }),
      call('p', 'apply_patch', { path: 'src/b.py', patch: '+print(1)' }),
      call('c', 'run_command', { command: ' npm test ' }),
      call('v', 'attest_verification'),
      call('o', 'report_step_outcome'),
    ]
    const results = [
      result(calls[0]),
      result(calls[1], { filesWritten: ['src/extra.ts'] }),
      result(calls[2], { result: { exitCode: 0 } }),
      result(calls[3]),
      result(calls[4]),
    ]
    const filesTouched = new Set<string>()
    const commandsRun: string[] = []
    const sessionChanges: Array<{ file: string; type: 'write' | 'patch'; content: string }> = []
    const executedChecks = new Map<string, number>()

    const outcome = collectToolTurnOutcome({
      toolCalls: calls,
      toolResults: results,
      filesTouched,
      commandsRun,
      sessionChanges,
      executedChecks,
    })

    expect([...filesTouched]).toEqual(['src/a.ts', 'src/extra.ts', 'src/b.py'])
    expect(commandsRun).toEqual([' npm test '])
    expect(executedChecks.get('npm test')).toBe(0)
    expect(sessionChanges).toEqual([
      { file: 'src/a.ts', type: 'write', content: 'export const a = 1' },
      { file: 'src/b.py', type: 'patch', content: '+print(1)' },
    ])
    expect(outcome).toMatchObject({
      acceptedWrites: 3,
      tsWrites: 2,
      attested: true,
      stepOutcomeReported: true,
    })
    expect(outcome.lspWrites.get('src/b.py')).toBeUndefined()
  })

  it('ошибочный tool не засчитывает успех', () => {
    const calls = [call('v', 'attest_verification'), call('w', 'write_file', { path: 'x.ts' })]
    const outcome = collectToolTurnOutcome({
      toolCalls: calls,
      toolResults: calls.map(item => result(item, { error: 'failed' })),
      filesTouched: new Set(),
      commandsRun: [],
      sessionChanges: [],
      executedChecks: new Map(),
    })

    expect(outcome.attested).toBe(false)
    expect(outcome.acceptedWrites).toBe(0)
  })
})

describe('reviewGatePassedInTurn', () => {
  it('принимает только реальный pass-маркер без error', () => {
    const calls = [call('r', 'review_before_commit')]
    expect(reviewGatePassedInTurn(calls, [result(calls[0], { result: `✅ ${REVIEW_GATE_PASS_MARKER}` })])).toBe(true)
    expect(
      reviewGatePassedInTurn(calls, [result(calls[0], { result: `✅ ${REVIEW_GATE_PASS_MARKER}`, error: 'no' })]),
    ).toBe(false)
  })
})
