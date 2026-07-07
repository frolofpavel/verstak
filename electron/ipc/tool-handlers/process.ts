import { isAbsolute, resolve, relative } from 'path'
import { realpathSync } from 'fs'
import type { ToolHandler } from './shared'
import { awaitCommandConfirm } from './shared'
import { globalProcessRegistry } from '../../ai/process-registry'
import { blockReason } from '../../ai/mode-policy'
import { resolveDecision } from '../../ai/permission-rules'
import { parseAllowlist, matchesAllowlist } from '../../ai/bash-allowlist'
import { scanText } from '../../ai/secret-scanner'
import { hashCommandForAudit } from '../../ai/smart-approve'

function registry(ctx: Parameters<ToolHandler['handle']>[1]) {
  return ctx.processRegistry ?? globalProcessRegistry
}

function sameOrInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function resolveProcessCwd(ctx: Parameters<ToolHandler['handle']>[1], cwd?: unknown): string {
  const root = realpathSync(ctx.projectPath)
  const raw = cwd ? String(cwd) : ctx.projectPath
  const candidate = isAbsolute(raw) ? raw : resolve(ctx.projectPath, raw)
  const real = realpathSync(candidate)
  if (!sameOrInside(root, real)) {
    throw new Error(`spawn_process cwd must stay inside project: ${raw}`)
  }
  return real
}

async function authorizeProcessCommand(call: Parameters<ToolHandler['handle']>[0], ctx: Parameters<ToolHandler['handle']>[1], command: string) {
  const verdict = ctx.tools.classifyCommand(command)
  if (!verdict.allowed) {
    ctx.sender.send('ai:event', {
      id: ctx.sendId,
      event: { type: 'tool-blocked', callId: call.id, name: call.name, command, reason: verdict.reason ?? 'denylist' }
    })
    return `Blocked by safety policy: ${verdict.reason ?? 'denylist'}`
  }

  const { decision, reason: denyReason } = resolveDecision('run_command', { command }, ctx.agentMode, ctx.autoApprove, ctx.permissionRules)
  if (decision === 'block') {
    const reason = denyReason ?? blockReason('run_command', ctx.agentMode)
    ctx.sender.send('ai:event', {
      id: ctx.sendId,
      event: { type: 'tool-blocked', callId: call.id, name: call.name, command, reason }
    })
    return reason
  }

  let forceConfirm = false
  if (ctx.smartApproveEnabled ?? process.env.USE_SMART_APPROVE === 'true') {
    const smart = ctx.smartApprove
      ? await ctx.smartApprove({ command, cwd: ctx.projectPath, agentMode: ctx.agentMode, projectPath: ctx.projectPath })
      : { verdict: 'escalate' as const, reason: 'smart approval is enabled but no guard provider is configured', model: 'unconfigured', durationMs: 0 }
    try {
      ctx.appendAudit?.('smart_approve', JSON.stringify({
        callId: call.id,
        cmd_hash: hashCommandForAudit(command),
        verdict: smart.verdict,
        model: smart.model,
        durationMs: smart.durationMs,
        reason: scanText(smart.reason).redacted.slice(0, 240)
      }))
    } catch { /* best-effort */ }
    if (smart.verdict === 'deny') return `smart-approve denied: ${scanText(smart.reason).redacted}`
    if (smart.verdict === 'escalate') forceConfirm = true
  }

  const allowlisted = decision !== 'auto-accept'
    && matchesAllowlist(command, parseAllowlist(ctx.getSecretForDelegate?.('bash_allowlist') ?? null))
  if (!forceConfirm && (decision === 'auto-accept' || allowlisted)) {
    ctx.sender.send('ai:event', {
      id: ctx.sendId,
      event: { type: 'tool-activity', callId: call.id, name: call.name, label: allowlisted ? 'spawn_process (авто · allowlist)' : 'spawn_process (авто)', detail: command, status: 'ok' }
    })
    return null
  }

  ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'pending-command', callId: call.id, command, sendId: ctx.sendId } })
  const accepted = await awaitCommandConfirm(ctx, call.id)
  if (!accepted) {
    ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'command-result', callId: call.id, command, status: 'rejected' } })
    return 'User rejected'
  }
  return null
}

export const spawnProcessHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    const command = String(call.args.command ?? '').trim()
    if (!command) return { id: call.id, name: call.name, result: '', error: 'spawn_process: command is required' }
    const blocked = await authorizeProcessCommand(call, ctx, command)
    if (blocked) return { id: call.id, name: call.name, result: `Command: ${command}`, error: blocked }

    try {
      const cwd = resolveProcessCwd(ctx, call.args.cwd)
      const timeout = Math.max(0, Math.min(24 * 60 * 60_000, Math.floor(Number(call.args.timeout_ms) || 0))) || undefined
      const handle = registry(ctx).spawn(command, {
        cwd,
        timeout,
        notifyOnExit: call.args.notify_on_exit === true,
        owner: {
          sendId: ctx.sendId,
          runId: ctx.runId ?? null,
          chatId: ctx.parentChatId ?? null,
        },
      })
      ctx.recordRunEvent?.('tool_call', { label: 'spawn_process', detail: `${handle.id} · ${command}`, status: 'ok' })
      return { id: call.id, name: call.name, result: { process_id: handle.id, pid: handle.pid, status: handle.status } }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { id: call.id, name: call.name, result: '', error: message }
    }
  }
}

export const processStatusHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    const id = String(call.args.id ?? call.args.process_id ?? '')
    const handle = registry(ctx).get(id)
    if (!handle) return { id: call.id, name: call.name, result: '', error: `process not found: ${id}` }
    const runtimeMs = (handle.exitedAt ?? Date.now()) - handle.startedAt
    return {
      id: call.id,
      name: call.name,
      result: {
        process_id: handle.id,
        pid: handle.pid,
        status: handle.status,
        exitCode: handle.exitCode,
        runtimeMs,
        outputTail: handle.outputTail,
      }
    }
  }
}

export const readProcessHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    const id = String(call.args.id ?? call.args.process_id ?? '')
    const handle = registry(ctx).get(id)
    if (!handle) return { id: call.id, name: call.name, result: '', error: `process not found: ${id}` }
    const lines = Math.max(0, Math.min(500, Math.floor(Number(call.args.lines) || 0)))
    const tail = lines > 0 ? handle.outputTail.split(/\r?\n/).slice(-lines).join('\n') : handle.outputTail
    return { id: call.id, name: call.name, result: { tail } }
  }
}

export const stopProcessHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    const id = String(call.args.id ?? call.args.process_id ?? '')
    const before = registry(ctx).get(id)
    if (!before) return { id: call.id, name: call.name, result: '', error: `process not found: ${id}` }
    await registry(ctx).kill(id)
    const after = registry(ctx).get(id)
    const killed = after?.status === 'killed' || before.status !== 'running'
    ctx.recordRunEvent?.('tool_call', { label: 'stop_process', detail: id, status: killed ? 'ok' : 'error' })
    return { id: call.id, name: call.name, result: { killed, status: after?.status ?? before.status } }
  }
}
