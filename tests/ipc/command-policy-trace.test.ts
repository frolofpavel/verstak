import { describe, expect, it } from 'vitest'
import { runCommandHandler } from '../../electron/ipc/tool-handlers/command'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { ToolCall } from '../../electron/ai/types'

describe('S2-A1 run_command policy trace', () => {
  it('does not write policy events while the feature is off', async () => {
    const policyEvents: string[] = []
    const ctx = {
      sendId: 43,
      agentMode: 'auto',
      signal: new AbortController().signal,
      sender: { send: () => {} },
      pendingCommands: new Map(),
      scopedKey: (sendId: unknown, callId: unknown) => `${sendId}:${callId}`,
      projectPath: 'C:\\project',
      policyDecisionMode: 'off',
      recordRunEvent: (kind: string) => { if (kind.startsWith('policy_')) policyEvents.push(kind) },
      appendAudit: (action: string) => { if (action.startsWith('policy_')) policyEvents.push(action) },
      tools: {
        classifyCommand: () => ({ allowed: true }),
        runCommand: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
      },
    } as unknown as ToolContext

    await runCommandHandler.handle({ id: 'call-43', name: 'run_command', args: { command: 'npm test' } }, ctx)
    expect(policyEvents).toEqual([])
  })

  it('records decision before execution and sanitized readback after it', async () => {
    const order: string[] = []
    const timeline: Array<{ kind: string; detail?: string | null; status?: string | null }> = []
    const audit: Array<{ action: string; detail: string }> = []
    const secret = 'TOP-SECRET-ARGUMENT'
    const ctx = {
      sendId: 44,
      agentMode: 'auto',
      signal: new AbortController().signal,
      sender: { send: () => {} },
      pendingCommands: new Map(),
      scopedKey: (sendId: unknown, callId: unknown) => `${sendId}:${callId}`,
      projectPath: 'C:\\project',
      runId: 'run-44',
      parentJobId: 'job-44',
      policyDecisionMode: 'enforce',
      policyIdentity: {
        agentId: 'agent:44',
        ownerId: 'owner:local',
        taskId: 'task:44',
        capability: { id: 'skill:test', version: 'v1', trust: 'T3' },
      },
      recordRunEvent: (kind: string, payload: { detail?: string | null; status?: string | null }) => {
        order.push(`timeline:${kind}`)
        timeline.push({ kind, ...payload })
      },
      appendAudit: (action: string, detail: string) => {
        order.push(`audit:${action}`)
        audit.push({ action, detail })
      },
      tools: {
        classifyCommand: () => ({ allowed: true }),
        runCommand: async () => {
          order.push('execute')
          return { stdout: 'verified output', stderr: '', exitCode: 0 }
        },
      },
    } as unknown as ToolContext
    const call: ToolCall = { id: 'call-44', name: 'run_command', args: { command: `npm test -- --token=${secret}` } }

    const result = await runCommandHandler.handle(call, ctx)

    expect(result.error).toBeFalsy()
    expect(order.indexOf('timeline:policy_decision')).toBeLessThan(order.indexOf('execute'))
    expect(order.indexOf('audit:policy_decision')).toBeLessThan(order.indexOf('execute'))
    expect(timeline.some(e => e.kind === 'policy_result' && e.status === 'ok')).toBe(true)
    expect(audit.some(e => e.action === 'policy_result')).toBe(true)

    const policyOnly = JSON.stringify({
      timeline: timeline.filter(e => e.kind.startsWith('policy_')),
      audit: audit.filter(e => e.action.startsWith('policy_')),
    })
    expect(policyOnly).not.toContain(secret)
    expect(policyOnly).not.toContain('npm test')
    expect(policyOnly).not.toContain('verified output')
    expect(policyOnly).toContain('run-44')
    expect(policyOnly).toContain('job-44')
  })
})
