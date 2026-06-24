// Command-хендлер: run_command. Вынесено при распиле.
import type { ToolHandler } from './shared'
import { emitActivity, awaitCommandConfirm } from './shared'
import { scanText } from '../../ai/secret-scanner'
import { decide, blockReason } from '../../ai/mode-policy'

export const runCommandHandler: ToolHandler = {
  mode: 'sequential',
  async handle(call, ctx) {
    const command = String(call.args.command ?? '')
    const verdict = ctx.tools.classifyCommand(command)
    if (!verdict.allowed) {
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-blocked', callId: call.id, name: 'run_command', command, reason: verdict.reason ?? 'denylist' }
      })
      return {
        id: call.id, name: call.name,
        result: `Command: ${command}`,
        error: `Blocked by safety policy: ${verdict.reason ?? 'denylist'}`
      }
    }
    // Mode policy: plan blocks, ask confirms, auto/bypass auto-accept,
    // accept-edits still confirms commands (only edits auto-pass).
    const decision = decide('run_command', ctx.agentMode)
    if (decision === 'block') {
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-blocked', callId: call.id, name: 'run_command', command, reason: blockReason('run_command', ctx.agentMode) }
      })
      return { id: call.id, name: call.name, result: '', error: blockReason('run_command', ctx.agentMode) }
    }
    let accepted: boolean
    if (decision === 'auto-accept') {
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'tool-activity', callId: call.id, name: 'run_command', label: 'run_command (авто)', detail: command, status: 'ok' }
      })
      accepted = true
    } else {
      // sendId в payload события: фоновый чат сохранит его в снапшот pendingCommand,
      // и резолв из Inbox пойдёт по строгому ключу ${sendId}::${callId}, а не по
      // collision-prone endsWith-фолбэку (ревью 24.06).
      ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'pending-command', callId: call.id, command, sendId: ctx.sendId } })
      accepted = await awaitCommandConfirm(ctx, call.id)
    }
    if (!accepted) {
      ctx.sender.send('ai:event', { id: ctx.sendId, event: { type: 'command-result', callId: call.id, command, status: 'rejected' } })
      return { id: call.id, name: call.name, result: `Command: ${command}`, error: 'User rejected' }
    }
    try {
      const result = await ctx.tools.runCommand(command)
      // Редактируем оба потока через secret-scanner ДО отправки в UI и
      // возврата модели — иначе ключи/токены из stdout/stderr утекают в
      // контекст и в Timeline.
      const stdout = scanText(result.stdout).redacted
      const stderr = scanText(result.stderr).redacted
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'command-result', callId: call.id, command, status: 'ok', exitCode: result.exitCode, stdout, stderr }
      })
      // Timeline задачи (Фаза 4): run_command не идёт через emitActivity, поэтому
      // пишем событие здесь, рядом с command-result. exitCode≠0 → status='error'.
      try { ctx.recordRunEvent?.('tool_call', { label: 'run_command', detail: command, status: result.exitCode === 0 ? 'ok' : 'error' }) } catch { /* best-effort */ }
      return { id: call.id, name: call.name, result: { stdout, stderr, exitCode: result.exitCode } }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      ctx.sender.send('ai:event', {
        id: ctx.sendId,
        event: { type: 'command-result', callId: call.id, command, status: 'error', error: msg }
      })
      try { ctx.recordRunEvent?.('tool_call', { label: 'run_command', detail: msg, status: 'error' }) } catch { /* best-effort */ }
      return { id: call.id, name: call.name, result: '', error: msg }
    }
  }
}
