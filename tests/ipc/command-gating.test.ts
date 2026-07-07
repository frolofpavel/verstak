import { describe, it, expect, vi } from 'vitest'
import { clearSmartApproveForSend, runCommandHandler } from '../../electron/ipc/tool-handlers/command'
import type { ToolContext } from '../../electron/ipc/tool-handlers/shared'
import type { AgentMode } from '../../electron/ai/mode-policy'
import type { ToolCall } from '../../electron/ai/types'
import type { SmartApproveContext, SmartApproveResult } from '../../electron/ai/smart-approve'

/**
 * Гейтинг команд (run_command): два рубежа ДО запуска + редакция вывода.
 *  - denylist (classifyCommand) → blocked, не запускаем;
 *  - mode-policy: plan→block, ask→confirm, auto/bypass→auto-accept;
 *  - stdout/stderr прогоняются через secret-scanner — ключи/токены не утекают в контекст/Timeline.
 * Мокнут classifyCommand/runCommand (входы), остальное — настоящая логика хендлера.
 */

interface RunResult { stdout: string; stderr: string; exitCode: number }
interface Overrides {
  classify?: (cmd: string) => { allowed: boolean; reason?: string }
  run?: (cmd: string) => Promise<RunResult>
  smartApproveEnabled?: boolean
  smartApprove?: (ctx: SmartApproveContext) => Promise<SmartApproveResult>
}
interface Harness {
  ctx: ToolContext
  runs: string[]
  controller: AbortController
  audits: Array<{ action: string; detail: string }>
}

function harness(mode: AgentMode, o: Overrides = {}): Harness {
  const runs: string[] = []
  const audits: Array<{ action: string; detail: string }> = []
  const controller = new AbortController()
  const ctx = {
    sendId: 't',
    agentMode: mode,
    signal: controller.signal,
    sender: { send: () => {} },
    pendingCommands: new Map(),
    scopedKey: (sendId: unknown, callId: unknown) => `${sendId}:${callId}`,
    recordRunEvent: () => {},
    appendAudit: (action: string, detail: string) => { audits.push({ action, detail }) },
    smartApproveEnabled: o.smartApproveEnabled,
    smartApprove: o.smartApprove,
    tools: {
      classifyCommand: o.classify ?? (() => ({ allowed: true })),
      runCommand: o.run ?? (async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }))
    }
  } as unknown as ToolContext
  // обернуть runCommand чтобы фиксировать факт запуска даже при кастомном run
  const realRun = (ctx.tools as { runCommand: (c: string) => Promise<RunResult> }).runCommand
  ;(ctx.tools as { runCommand: (c: string) => Promise<RunResult> }).runCommand = async (cmd: string) => { runs.push(cmd); return realRun(cmd) }
  return { ctx, runs, controller, audits }
}

function call(command = 'npm test'): ToolCall {
  return { id: '1', name: 'run_command', args: { command } }
}

const tick = () => new Promise<void>(r => setTimeout(r, 0))

describe('run_command gating', () => {
  it('denylist → blocked, команда НЕ запускается', async () => {
    const h = harness('auto', { classify: () => ({ allowed: false, reason: 'rm -rf запрещён' }) })
    const res = await runCommandHandler.handle(call('rm -rf /'), h.ctx)
    expect(h.runs.length).toBe(0)
    expect(res.error).toContain('Blocked by safety policy')
    expect(res.error).toContain('rm -rf запрещён')
  })

  it('plan → block: не запускается, причина режима', async () => {
    const h = harness('plan')
    const res = await runCommandHandler.handle(call(), h.ctx)
    expect(h.runs.length).toBe(0)
    expect(res.result).toBe('')
    expect(res.error).toContain('Режим планирования')
  })

  it('auto → запускается без подтверждения, отдаёт exitCode/stdout', async () => {
    const h = harness('auto')
    const res = await runCommandHandler.handle(call(), h.ctx)
    expect(h.runs).toEqual(['npm test'])
    expect(res.result).toMatchObject({ exitCode: 0, stdout: 'ok' })
    expect(res.error).toBeFalsy()
  })

  it('ask → confirm + accept: запуск после подтверждения', async () => {
    const h = harness('ask')
    const p = runCommandHandler.handle(call(), h.ctx)
    await tick()
    expect(h.runs.length).toBe(0)                       // ждёт юзера
    h.ctx.pendingCommands.get('t:1')!.resolve(true)
    const res = await p
    expect(h.runs).toEqual(['npm test'])
    expect(res.error).toBeFalsy()
  })

  it('ask → confirm + reject: не запускается, "User rejected"', async () => {
    const h = harness('ask')
    const p = runCommandHandler.handle(call(), h.ctx)
    await tick()
    h.ctx.pendingCommands.get('t:1')!.resolve(false)
    const res = await p
    expect(h.runs.length).toBe(0)
    expect(res.error).toBe('User rejected')
  })

  it('секреты в stdout/stderr редактируются (не утекают в контекст)', async () => {
    const h = harness('auto', {
      run: async () => ({ stdout: 'key=AKIAIOSFODNN7EXAMPLE', stderr: '', exitCode: 0 })
    })
    const res = await runCommandHandler.handle(call(), h.ctx)
    const out = (res.result as { stdout: string }).stdout
    expect(out).toContain('[REDACTED:aws-access-key]')
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE')
  })

  it('smart-approve disabled by default: auto keeps old silent execution path', async () => {
    const smartApprove = async () => ({ verdict: 'deny' as const, reason: 'would deny', model: 'test', durationMs: 1 })
    const h = harness('auto', { smartApprove })

    const res = await runCommandHandler.handle(call('npm test'), h.ctx)

    expect(h.runs).toEqual(['npm test'])
    expect(res.error).toBeFalsy()
    expect(h.audits.some(a => a.action === 'smart_approve')).toBe(false)
  })

  it('smart-approve approve lets auto command execute and records hash-only audit', async () => {
    const h = harness('auto', {
      smartApproveEnabled: true,
      smartApprove: async () => ({ verdict: 'approve', reason: 'safe local test', model: 'guard-model', durationMs: 12 })
    })

    const res = await runCommandHandler.handle(call('npm test -- --runInBand'), h.ctx)

    expect(h.runs).toEqual(['npm test -- --runInBand'])
    expect(res.error).toBeFalsy()
    const audit = h.audits.find(a => a.action === 'smart_approve')
    expect(audit).toBeTruthy()
    expect(audit!.detail).toContain('"cmd_hash"')
    expect(audit!.detail).not.toContain('npm test')
    expect(audit!.detail).not.toContain('--runInBand')
  })

  it('smart-approve deny blocks before execution', async () => {
    const h = harness('auto', {
      smartApproveEnabled: true,
      smartApprove: async () => ({ verdict: 'deny', reason: 'downloads installer into shell', model: 'guard-model', durationMs: 8 })
    })

    const res = await runCommandHandler.handle(call('npm test'), h.ctx)

    expect(h.runs).toEqual([])
    expect(res.error).toContain('smart-approve denied')
    expect(res.error).toContain('downloads installer')
  })

  it('smart-approve escalate turns auto execution into manual confirmation', async () => {
    const h = harness('auto', {
      smartApproveEnabled: true,
      smartApprove: async () => ({ verdict: 'escalate', reason: 'ambiguous command', model: 'guard-model', durationMs: 5 })
    })
    const p = runCommandHandler.handle(call('npm test'), h.ctx)
    await tick()

    expect(h.runs).toEqual([])
    h.ctx.pendingCommands.get('t:1')!.resolve(true)

    const res = await p
    expect(h.runs).toEqual(['npm test'])
    expect(res.error).toBeFalsy()
  })

  it('smart-approve bounded escalation: third ambiguous command skips guard model and confirms manually', async () => {
    clearSmartApproveForSend('t')
    const smartApprove = vi.fn(async () => ({
      verdict: 'escalate' as const,
      reason: 'ambiguous command',
      model: 'guard-model',
      durationMs: 5
    }))
    const h = harness('auto', { smartApproveEnabled: true, smartApprove })

    for (const id of ['1', '2']) {
      const p = runCommandHandler.handle({ ...call('npm test'), id }, h.ctx)
      await tick()
      h.ctx.pendingCommands.get(`t:${id}`)!.resolve(false)
      await p
    }

    const third = runCommandHandler.handle({ ...call('npm test'), id: '3' }, h.ctx)
    await tick()

    expect(smartApprove).toHaveBeenCalledTimes(2)
    expect(h.runs).toEqual([])
    h.ctx.pendingCommands.get('t:3')!.resolve(false)

    const res = await third
    expect(res.error).toBe('User rejected')
  })
})
